import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.ts";
import { errorMessage } from "../errors.ts";
import { rank } from "../match.ts";
import { Approvals, summariseTool } from "./approvals.ts";
import { aliasesFor, scanProjects } from "./projects.ts";
import { label, lastAssistantText, mergeSessions, readAgents, readRegistry, transcriptPath } from "./sessions.ts";
import type { Decision, HookInput, HubEvent, Project, Session, SessionState } from "./types.ts";

const run = promisify(execFile);

export type ChannelMsg =
  | { kind: "message"; content: string; meta: Record<string, string> }
  | { kind: "verdict"; request_id: string; behavior: Decision };

interface ChannelPeer {
  queue: ChannelMsg[];
  waiter?: ((m: ChannelMsg[]) => void) | undefined;
  lastSeen: number;
}

export type Resolved<T> = { ok: T } | { ambiguous: T[] } | { none: true };

/**
 * The hub knows about every Claude Code session on this PC (registry files,
 * `claude agents`, hook events, attached channels) and is the only thing that
 * acts on them. The voice side talks to it; it never talks to the voice side
 * except through events.
 */
export class Hub extends EventEmitter<{ event: [HubEvent] }> {
  readonly approvals: Approvals;
  projects: Project[] = [];
  /** True while someone is in the voice call: approvals are only relayed then. */
  callActive = false;
  /** What the user last said, verbatim, so dispatch briefs can carry their own words. */
  lastUtterance = "";
  /** Sessions most recently started, announced or talked about, newest first: what "that one" means. */
  private recent: string[] = [];

  private cache: { at: number; sessions: Session[] } = { at: 0, sessions: [] };
  private channels = new Map<string, ChannelPeer>();
  private dispatched = new Set<string>();
  /** Follow-ups for busy background sessions, sent when their turn ends. */
  private followUps = new Map<string, string[]>();
  /** Last state seen by the watcher, to spot busy -> done without hooks. */
  private lastStates = new Map<string, SessionState>();
  /** When a turn end / needs-input was last announced per session, so hook and watcher don't both speak. */
  private announced = new Map<string, number>();

  private cfg: Config;

  constructor(cfg: Config) {
    super();
    this.cfg = cfg;
    this.approvals = new Approvals((id, decision) => this.emit("event", { type: "approval_closed", id, decision }));
    this.rescanProjects();
  }

  rescanProjects(): void {
    this.projects = scanProjects(this.cfg.projects);
  }

  async sessions(maxAgeMs = 3000): Promise<Session[]> {
    if (Date.now() - this.cache.at < maxAgeMs) return this.cache.sessions;
    const live = new Set([...this.channels].filter(([, p]) => Date.now() - p.lastSeen < 60_000).map(([id]) => id));
    const sessions = mergeSessions(readRegistry(this.cfg.claudeDir), await readAgents(), this.cfg.projects, {
      channels: live,
      dispatched: this.dispatched,
    }).filter((s) => !s.cwd.startsWith(this.cfg.stateDir)); // the brain's own `claude -p` processes
    this.cache = { at: Date.now(), sessions };
    return sessions;
  }

  async session(id: string): Promise<Session | undefined> {
    return (
      (await this.sessions()).find((s) => s.sessionId === id) ??
      (await this.sessions(0)).find((s) => s.sessionId === id)
    );
  }

  static sessionAliases(s: Session): string[] {
    return [...aliasesFor(s.project), ...(s.name ? [s.name] : []), s.short];
  }

  noteReference(sessionId: string): void {
    this.recent = [sessionId, ...this.recent.filter((id) => id !== sessionId)].slice(0, 20);
  }

  async resolveSession(query: string): Promise<Resolved<Session>> {
    const all = await this.sessions();
    const pointed = pronounTarget(query, all, this.recent);
    if (pointed) return { ok: pointed };
    // Its own name or short id beats the project name it shares with siblings.
    const named = pick(rank(query, all, (s) => [s.name, s.short].filter(Boolean)));
    return "ok" in named ? named : pick(rank(query, all, (s) => Hub.sessionAliases(s)));
  }

  resolveProject(query: string): Resolved<Project> {
    return pick(rank(query, this.projects, (p) => p.aliases));
  }

  lastMessage(s: Session): string {
    return lastAssistantText(transcriptPath(this.cfg.claudeDir, s.cwd, s.sessionId));
  }

  // ---- acting on sessions -------------------------------------------------

  /** Start a new background session. Returns its short id. */
  async dispatch(
    project: Project,
    prompt: string,
    opts: { model?: string | undefined; name?: string | undefined } = {},
  ): Promise<Session | string> {
    const args = [
      "--bg",
      "--model",
      opts.model ?? this.cfg.dispatch.model,
      "--permission-mode",
      this.cfg.dispatch.permissionMode,
    ];
    if (opts.name) args.push("--name", opts.name);
    args.push(prompt.startsWith("-") ? " " + prompt : prompt);
    const { stdout, stderr } = await run("claude", args, { cwd: project.path, timeout: 60_000 });
    const short = /\b([0-9a-f]{8})\b/.exec(stdout + stderr)?.[1];
    if (!short) return `started, but couldn't read its id: ${(stdout + stderr).trim().slice(0, 200)}`;
    return (await this.adopt(short)) ?? short;
  }

  /** Mark a session parley started as ours and point the conversation at it. */
  private async adopt(short: string): Promise<Session | undefined> {
    const s = (await this.sessions(0)).find((x) => x.short === short);
    if (!s) return undefined;
    this.dispatched.add(s.sessionId);
    s.dispatched = true;
    this.lastStates.set(s.sessionId, "busy");
    this.noteReference(s.sessionId);
    this.emit("event", { type: "dispatched", session: s });
    return s;
  }

  /**
   * Send a message into an existing session, by the best route available:
   * an attached channel, a background resume, or (asked for) a fork.
   */
  async send(
    s: Session,
    text: string,
    opts: { fork?: boolean | undefined; quiet?: boolean | undefined } = {},
  ): Promise<string> {
    const acted = (say: string) => {
      if (!opts.quiet) this.acted(say);
    };
    const peer = this.channels.get(s.sessionId);
    if (peer && !opts.fork) {
      this.pushChannel(s.sessionId, { kind: "message", content: text, meta: { from: "voice" } });
      acted("Sent.");
      return `delivered to ${label(s)} through its channel`;
    }
    if (s.kind === "background" || opts.fork) {
      if (s.state === "busy" && !opts.fork) {
        this.followUps.set(s.sessionId, [...(this.followUps.get(s.sessionId) ?? []), text]);
        acted("It's busy, so it gets that when it finishes this step.");
        return `${label(s)} is busy; queued to send when its current turn ends`;
      }
      const args = ["--resume", s.sessionId, "--bg"];
      if (opts.fork) args.push("--fork-session");
      args.push(text.startsWith("-") ? " " + text : text);
      const { stdout, stderr } = await run("claude", args, { cwd: s.cwd, timeout: 60_000 });
      this.dispatched.add(s.sessionId);
      this.cache.at = 0;
      // Resuming a finished background session starts a copy with a new id; follow that one from now on.
      const short = /\b([0-9a-f]{8})\b/.exec(stdout + stderr)?.[1];
      const next = short && short !== s.short ? await this.adopt(short) : undefined;
      acted(opts.fork ? "Forked it." : next ? "It had finished, so it carries on as a new session." : "Sent.");
      if (opts.fork) return `forked ${label(s)} into a new background session${next ? ` [${next.short}]` : ""}`;
      return next
        ? `${label(s)} had finished, so it continues as a new session [${next.short}] with your message`
        : `sent to ${label(s)}`;
    }
    if (s.name) {
      const r = await this.messageInteractive(s, text);
      if (r === true) {
        acted("Sent.");
        return `delivered to ${label(s)} as a cross-session message; it reads it between steps, or starts a turn if idle`;
      }
      return `couldn't message ${label(s)} (${r}). I can fork it into a background session instead, or you can answer it from the phone.`;
    }
    return `${label(s)} is an interactive session with no name to address it by, so I can't message it. I can fork it into a background session instead, or you can answer it from the phone.`;
  }

  /**
   * Message an interactive session through Claude Code's cross-session
   * messaging. There's no CLI command for it, only the SendMessage tool, so a
   * one-shot headless relay calls it. ~3.5 s with Haiku.
   */
  messageInteractive: (s: Session, text: string) => Promise<true | string> = (s, text) => this.relay(s, text);

  private async relay(s: Session, text: string): Promise<true | string> {
    const prompt = [
      "Deliver a message from the user to another Claude Code session on this machine, using SendMessage.",
      `Target: the session named "${s.name}" (project folder ${s.cwd}). If that name matches more than one session or none, call ListAgents and pick the one whose name and folder match; if none match, don't send.`,
      'Send exactly the text between the markers, verbatim, with the summary "From the user, by voice".',
      `<message>\n${text}\n</message>`,
      "Then reply with only SENT, or FAILED: <reason>.",
    ].join("\n");
    const cwd = join(this.cfg.stateDir, "relay");
    mkdirSync(cwd, { recursive: true });
    try {
      const { stdout } = await run(
        "claude",
        [
          "-p",
          prompt,
          "--name",
          "parley",
          "--model",
          "haiku",
          "--tools",
          "SendMessage,ListAgents",
          "--allowedTools",
          "SendMessage,ListAgents",
          "--permission-mode",
          "dontAsk",
          "--setting-sources",
          "",
          "--no-session-persistence",
        ],
        { cwd, timeout: 60_000 },
      );
      const out = stdout.trim();
      return /^SENT\b/.test(out) ? true : out.replace(/^FAILED:\s*/, "").slice(0, 200) || "no answer from the relay";
    } catch (e) {
      return errorMessage(e);
    }
  }

  // ---- noticing finished turns ----------------------------------------------

  /** Tell the voice side an action really happened, in words it can speak as-is. */
  acted(say: string): void {
    this.emit("event", { type: "acted", say });
  }

  private turnEnded(s: Session, lastMessage: string): void {
    const queued = this.followUps.get(s.sessionId);
    if (queued?.length) {
      this.followUps.delete(s.sessionId);
      s.state = "idle";
      void this.send(s, queued.join("\n\n"), { quiet: true });
    }
    if (this.recentlyAnnounced(s)) return;
    this.noteReference(s.sessionId);
    this.emit("event", { type: "turn_done", session: s, lastMessage });
  }

  private recentlyAnnounced(s: Session, now = Date.now()): boolean {
    if (now - (this.announced.get(s.sessionId) ?? 0) < 60_000) return true;
    this.announced.set(s.sessionId, now);
    return false;
  }

  /**
   * Polls session states during a call, so finished and stuck sessions are
   * announced even when Claude Code's hooks aren't installed. Hooks are
   * quicker; whichever notices first speaks, the other stays quiet.
   */
  startWatching(everyMs = 10_000): void {
    setInterval(() => {
      if (!this.callActive) {
        this.lastStates.clear();
        return;
      }
      this.sessions(0).then(
        (ss) => this.watchTick(ss),
        () => {},
      );
    }, everyMs).unref();
  }

  watchTick(sessions: Session[]): void {
    for (const s of sessions) {
      const prev = this.lastStates.get(s.sessionId);
      this.lastStates.set(s.sessionId, s.state);
      if (prev !== "busy" || s.state === "busy" || s.state === "unknown") continue;
      if (s.state === "idle") this.turnEnded(s, this.lastMessage(s));
      else if (!this.recentlyAnnounced(s)) {
        this.noteReference(s.sessionId);
        this.emit("event", { type: "needs_input", session: s, message: "" });
      }
    }
  }

  // ---- hooks --------------------------------------------------------------

  /** Body returned to Claude Code's HTTP hook. `{}` means "no opinion". */
  async handleHook(h: HookInput): Promise<object> {
    const s = await this.session(h.session_id);
    switch (h.hook_event_name) {
      case "PermissionRequest": {
        if (!this.callActive || !s || this.channels.has(s.sessionId)) return {};
        const tool = h.tool_name ?? "tool";
        const decision = await this.ask(s, tool, summariseTool(tool, h.tool_input), "hook");
        if (decision === "timeout") return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "Denied by voice." },
          },
        };
      }
      case "Stop": {
        if (!s) return {};
        this.cache.at = 0;
        this.lastStates.set(s.sessionId, "idle");
        this.turnEnded(s, h.last_assistant_message ?? this.lastMessage(s));
        return {};
      }
      case "Notification": {
        if (!s || h.notification_type === "permission_prompt") return {};
        if (["idle_prompt", "agent_needs_input", "elicitation_dialog"].includes(h.notification_type ?? "")) {
          if (this.recentlyAnnounced(s)) return {};
          this.emit("event", { type: "needs_input", session: s, message: h.message ?? "" });
        }
        return {};
      }
      default:
        return {};
    }
  }

  private async ask(s: Session, tool: string, summary: string, source: "hook" | "channel", channelRequestId?: string) {
    const approval = {
      id: this.approvals.nextId(),
      sessionId: s.sessionId,
      sessionLabel: label(s),
      toolName: tool,
      summary,
      source,
      channelRequestId,
      createdAt: Date.now(),
    };
    const p = this.approvals.open(approval, this.cfg.hub.approvalTimeoutS * 1000);
    this.emit("event", { type: "approval", approval });
    return p;
  }

  // ---- channel servers (one per Claude Code session that loads it) ---------

  async channelRegister(pid: number): Promise<string | undefined> {
    for (let i = 0; i < 20; i++) {
      const e = readRegistry(this.cfg.claudeDir).find((r) => r.pid === pid);
      if (e) {
        this.peer(e.sessionId);
        this.cache.at = 0;
        return e.sessionId;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return undefined;
  }

  private peer(sessionId: string): ChannelPeer {
    let p = this.channels.get(sessionId);
    if (!p) this.channels.set(sessionId, (p = { queue: [], lastSeen: Date.now() }));
    return p;
  }

  private pushChannel(sessionId: string, m: ChannelMsg) {
    const p = this.peer(sessionId);
    if (p.waiter) {
      const w = p.waiter;
      p.waiter = undefined;
      w([m]);
    } else p.queue.push(m);
  }

  /** Long-poll: resolves with queued messages, or [] after `waitMs`. */
  channelPoll(sessionId: string, waitMs = 25_000): Promise<ChannelMsg[]> {
    const p = this.peer(sessionId);
    p.lastSeen = Date.now();
    if (p.queue.length) return Promise.resolve(p.queue.splice(0));
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        if (p.waiter === done) p.waiter = undefined;
        resolve([]);
      }, waitMs);
      const done = (m: ChannelMsg[]) => {
        clearTimeout(t);
        resolve(m);
      };
      p.waiter = done;
    });
  }

  async channelReply(sessionId: string, text: string): Promise<void> {
    const s = await this.session(sessionId);
    if (s) this.emit("event", { type: "session_reply", session: s, text });
  }

  async channelPermission(
    sessionId: string,
    req: { request_id: string; tool_name: string; description: string; input_preview: string },
  ) {
    const s = await this.session(sessionId);
    if (!s || !this.callActive) return;
    const summary = req.description || summariseTool(req.tool_name, { command: req.input_preview });
    const d = await this.ask(s, req.tool_name, summary, "channel", req.request_id);
    if (d !== "timeout") this.pushChannel(sessionId, { kind: "verdict", request_id: req.request_id, behavior: d });
  }

  channelGone(sessionId: string): void {
    this.channels.delete(sessionId);
    this.cache.at = 0;
  }
}

function pick<T>(ranked: { item: T; score: number }[]): Resolved<T> {
  if (!ranked.length) return { none: true };
  const best = ranked[0]?.score;
  const top = ranked.filter((r) => r.score === best);
  const [only] = top;
  return only && top.length === 1 ? { ok: only.item } : { ambiguous: top.map((r) => r.item) };
}

const POINTER =
  /^(it|that|this|(that|this|the) (one|session)|the (last|latest|new|newest|current|running|working|active) (one|session)|(the )?(running|working) (one|session)|the one (that'?s |that is |which is )?(running|working|going|still going))$/;
const WANTS_RUNNING = /\b(running|working|going|active)\b/;

/**
 * "that one" / "the one that's running": the newest session the user started,
 * heard about or talked about; for "running", the newest one still working.
 */
export function pronounTarget(query: string, all: Session[], recent: string[]): Session | undefined {
  const q = query
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!POINTER.test(q)) return undefined;
  const ok = (s: Session) => !WANTS_RUNNING.test(q) || s.state === "busy";
  const byId = new Map(all.map((s) => [s.sessionId, s]));
  for (const id of recent) {
    const s = byId.get(id);
    if (s && ok(s)) return s;
  }
  return WANTS_RUNNING.test(q) ? all.find((s) => s.state === "busy") : undefined;
}
