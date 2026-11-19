import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Project } from "../hub/types.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Config } from "../config.ts";
import type { Brain, TurnOut } from "./brain.ts";
import { systemPrompt } from "./prompt.ts";
import type { Topic } from "./router.ts";

/**
 * Brain on the user's logged-in Claude Code (subscription, no API key, no
 * per-token bill). One long-lived `claude -p` stream-json process per topic,
 * so there is no start-up cost per utterance, plus one spare already running
 * so switching to a new topic is instant too.
 */
export class CliBrain implements Brain {
  private procs = new Map<string, CliProc>();
  private spare?: CliProc;
  private args: string[];
  private cwd: string;
  private cfg: Config["brain"];

  constructor(
    cfg: Config["brain"],
    hub: { port: number; token: string },
    stateDir: string,
    audioTags: boolean,
    projects: Project[] = [],
  ) {
    this.cfg = cfg;
    this.cwd = join(stateDir, "brain");
    mkdirSync(this.cwd, { recursive: true });
    const mcp = {
      mcpServers: {
        parley: {
          command: process.execPath,
          args: [join(import.meta.dirname, "mcp.ts")],
          env: { PARLEY_URL: `http://127.0.0.1:${hub.port}`, PARLEY_TOKEN: hub.token },
        },
      },
    };
    this.args = [
      "-p",
      "--model",
      cfg.model,
      "--effort",
      cfg.effort,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      // Keep these out of `claude --resume` and away from the user's settings and hooks.
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(mcp),
      // No built-in tools at all: the brain can only use parley's tools.
      "--tools",
      "",
      "--allowedTools",
      "mcp__parley",
      "--permission-mode",
      "dontAsk",
      "--system-prompt",
      systemPrompt({ audioTags, projects, owner: cfg.owner }),
    ];
  }

  private spawnProc(): CliProc {
    return new CliProc(this.args, this.cwd);
  }

  private get(topic: Topic): CliProc {
    let p = this.procs.get(topic.id);
    if (p && !p.dead) return p;
    p = this.spare && !this.spare.dead ? this.spare : this.spawnProc();
    this.spare = this.spawnProc();
    this.procs.set(topic.id, p);
    this.evict();
    return p;
  }

  private evict() {
    while (this.procs.size > Math.max(1, this.cfg.poolSize - 1)) {
      const [oldest] = [...this.procs.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      if (!oldest) break;
      oldest[1].kill();
      this.procs.delete(oldest[0]);
    }
  }

  warm(topic: Topic): Promise<void> {
    this.get(topic);
    return Promise.resolve();
  }

  forget(topicId: string): void {
    this.procs.get(topicId)?.kill();
    this.procs.delete(topicId);
  }

  close(): void {
    for (const p of this.procs.values()) p.kill();
    this.spare?.kill();
    this.procs.clear();
  }

  turn(topic: Topic, input: string, out: TurnOut, signal: AbortSignal): Promise<void> {
    return this.get(topic).turn(input, out, signal);
  }
}

interface StreamLine {
  type: string;
  subtype?: string;
  event?: { type: string; delta?: { type: string; text?: string }; content_block?: { type: string; name?: string } };
  result?: string;
  is_error?: boolean;
}

class CliProc {
  private child: ChildProcessWithoutNullStreams;
  private chain: Promise<void> = Promise.resolve();
  private onLine: ((l: StreamLine) => void) | undefined;
  private nReq = 0;
  dead = false;
  lastUsed = Date.now();

  constructor(args: string[], cwd: string) {
    this.child = spawn("claude", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "parley" },
    });
    this.child.on("exit", () => {
      this.dead = true;
      this.onLine?.({ type: "result", is_error: true, result: "brain process exited" });
    });
    this.child.stderr.on("data", (d) => process.env.PARLEY_DEBUG && process.stderr.write(`[brain] ${d}`));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.onLine?.(JSON.parse(line) as StreamLine);
      } catch {
        /* not JSON: ignore */
      }
    });
    // Claude Code finishes starting up (MCP, auth, first request) on the first
    // message, which costs ~0.5 s. Pay it now, not when the user is waiting.
    void this.turn("[warmup] Reply with only: ok", { text: () => {} }, new AbortController().signal).catch(() => {});
  }

  turn(input: string, out: TurnOut, signal: AbortSignal): Promise<void> {
    const run = () =>
      new Promise<void>((resolve, reject) => {
        if (this.dead) {
          reject(new Error("brain process is not running"));
          return;
        }
        this.lastUsed = Date.now();
        let interrupted = false;
        const abort = () => {
          if (interrupted) return;
          interrupted = true;
          this.write({ type: "control_request", request_id: `int-${++this.nReq}`, request: { subtype: "interrupt" } });
        };
        signal.addEventListener("abort", abort, { once: true });
        this.onLine = (l) => {
          if (
            l.type === "stream_event" &&
            l.event?.type === "content_block_delta" &&
            l.event.delta?.type === "text_delta"
          ) {
            if (!signal.aborted) out.text(l.event.delta.text ?? "");
          } else if (
            l.type === "stream_event" &&
            l.event?.type === "content_block_start" &&
            l.event.content_block?.type === "tool_use"
          ) {
            if (!signal.aborted) out.tool?.(l.event.content_block.name ?? "");
          } else if (l.type === "result") {
            this.onLine = undefined;
            signal.removeEventListener("abort", abort);
            // A failed turn (expired login, API error) must surface, not end as silence.
            if (l.is_error && !interrupted && !signal.aborted) reject(new Error(l.result ?? "brain error"));
            else resolve();
          }
        };
        this.write({ type: "user", message: { role: "user", content: input } });
        if (signal.aborted) abort();
      });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  private write(o: object) {
    if (!this.dead) this.child.stdin.write(JSON.stringify(o) + "\n");
  }

  kill() {
    this.dead = true;
    this.child.kill();
  }
}
