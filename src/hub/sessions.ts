import { execFile } from "node:child_process";
import { openSync, readSync, closeSync, fstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.ts";
import { domainOf } from "./projects.ts";
import type { Session, SessionState } from "./types.ts";

const run = promisify(execFile);

/** One file per live Claude Code process: ~/.claude/sessions/<pid>.json. */
interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  status?: string;
  kind?: string;
  bridgeSessionId?: string;
  updatedAt?: number;
  statusUpdatedAt?: number;
}

/** One row of `claude agents --json`. */
interface AgentRow {
  id: string;
  sessionId: string;
  cwd: string;
  kind: string;
  name?: string;
  state?: string;
  status?: string;
  startedAt?: number;
}

function normaliseState(s: string | undefined): SessionState {
  switch ((s ?? "").toLowerCase()) {
    case "busy":
    case "running":
    case "working":
      return "busy";
    case "idle":
    case "done":
    case "completed":
      return "idle";
    case "blocked":
      return "blocked";
    case "waiting":
    case "needs_input":
      return "waiting";
    default:
      return "unknown";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readRegistry(claudeDir: string): RegistryEntry[] {
  const dir = join(claudeDir, "sessions");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const f of files) {
    try {
      const e = JSON.parse(readFileSync(join(dir, f), "utf8")) as RegistryEntry;
      if (e.sessionId && e.pid && alive(e.pid)) out.push(e);
    } catch {
      /* half-written file: skip this round */
    }
  }
  return out;
}

export async function readAgents(): Promise<AgentRow[]> {
  try {
    const { stdout } = await run("claude", ["agents", "--json"], { timeout: 8000 });
    return JSON.parse(stdout) as AgentRow[];
  } catch {
    return [];
  }
}

export function mergeSessions(
  reg: RegistryEntry[],
  agents: AgentRow[],
  cfg: Config["projects"],
  extra: { channels: Set<string>; dispatched: Set<string> },
): Session[] {
  const byId = new Map<string, Session>();
  const base = (id: string, cwd: string): Session => ({
    sessionId: id,
    short: id.slice(0, 8),
    name: "",
    cwd,
    project: basename(cwd),
    domain: domainOf(cwd, cfg),
    kind: "interactive",
    remoteControl: false,
    state: "unknown",
    channel: extra.channels.has(id),
    dispatched: extra.dispatched.has(id),
    updatedAt: 0,
  });
  for (const r of reg) {
    const s = byId.get(r.sessionId) ?? base(r.sessionId, r.cwd);
    s.pid = r.pid;
    s.name = r.name ?? s.name;
    s.kind = r.kind === "background" ? "background" : "interactive";
    s.remoteControl = Boolean(r.bridgeSessionId);
    s.state = normaliseState(r.status);
    s.updatedAt = Math.max(r.updatedAt ?? 0, r.statusUpdatedAt ?? 0);
    byId.set(r.sessionId, s);
  }
  for (const a of agents) {
    const s = byId.get(a.sessionId) ?? base(a.sessionId, a.cwd);
    s.name ||= a.name ?? "";
    if (a.kind === "background") s.kind = "background";
    const st = normaliseState(a.state ?? a.status);
    if (st !== "unknown") s.state = st;
    s.updatedAt ||= a.startedAt ?? 0;
    byId.set(a.sessionId, s);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** ~/.claude/projects/<cwd with every non-alphanumeric char as '-'>/<id>.jsonl */
export function transcriptPath(claudeDir: string, cwd: string, sessionId: string): string {
  return join(claudeDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/** Last assistant text in a transcript, reading only the file's tail. */
export function lastAssistantText(path: string, tailBytes = 256 * 1024): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line?.includes('"assistant"')) continue;
      try {
        const o = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
        if (o.type !== "assistant") continue;
        const content = o.message?.content;
        const text = Array.isArray(content)
          ? content
              .filter((b: { type?: string }) => b.type === "text")
              .map((b: { text?: string }) => b.text ?? "")
              .join("\n")
          : typeof content === "string"
            ? content
            : "";
        if (text.trim()) return text.trim();
      } catch {
        /* first line of the tail is usually cut: skip */
      }
    }
    return "";
  } finally {
    closeSync(fd);
  }
}

export function label(s: Session): string {
  return s.name ? `${s.project}: ${s.name}` : `${s.project} (${s.short})`;
}
