import type { Approval, Decision } from "./types.ts";

/** Words that are easy to say and hard to mishear. */
const WORDS = [
  "amber",
  "birch",
  "cobalt",
  "delta",
  "ember",
  "falcon",
  "garnet",
  "harbor",
  "indigo",
  "juniper",
  "kestrel",
  "lumen",
  "maple",
  "nova",
  "onyx",
  "pepper",
  "quartz",
  "raven",
  "sable",
  "tango",
  "umber",
  "violet",
  "willow",
  "zephyr",
];

type Waiter = (d: Decision | "timeout") => void;

/** Pending tool approvals, each waiting for a spoken (or clicked) answer. */
export class Approvals {
  private pending = new Map<string, { a: Approval; done: Waiter; timer: NodeJS.Timeout }>();
  private n = 0;

  private onClose: (id: string, d: Decision | "timeout") => void;

  constructor(onClose: (id: string, d: Decision | "timeout") => void = () => {}) {
    this.onClose = onClose;
  }

  nextId(): string {
    // Rotate through the words so ids aren't reused back to back; skip ones still pending.
    const k = this.n++ % WORDS.length;
    const order = [...WORDS.slice(k), ...WORDS.slice(0, k)];
    return order.find((w) => !this.pending.has(w)) ?? `req${this.n}`;
  }

  /** Resolves with the decision, or "timeout" after `timeoutMs`. */
  open(a: Approval, timeoutMs: number): Promise<Decision | "timeout"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.close(a.id, "timeout"), timeoutMs);
      this.pending.set(a.id, { a, done: resolve, timer });
    });
  }

  close(id: string, d: Decision | "timeout"): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.done(d);
    this.onClose(id, d);
    return true;
  }

  /** With no id, answers the oldest pending approval (the one read out first). */
  resolve(decision: Decision, id?: string): Approval | undefined {
    const target = id ? this.pending.get(id)?.a : this.list()[0];
    if (!target) return undefined;
    this.close(target.id, decision);
    return target;
  }

  list(): Approval[] {
    return [...this.pending.values()].map((p) => p.a).sort((x, y) => x.createdAt - y.createdAt);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Drop everything (call ended): hooks fall back to the normal prompt. */
  clear(): void {
    for (const id of [...this.pending.keys()]) this.close(id, "timeout");
  }
}

/** A one-line, speakable description of a tool call. */
export function summariseTool(tool: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const str = (k: string) => (typeof i[k] === "string" ? i[k] : "");
  const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  switch (tool) {
    case "Bash":
      return `run ${clip(str("command").split("\n")[0] ?? "")}`;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return `${tool === "Write" ? "write" : "edit"} ${str("file_path") || str("notebook_path")}`;
    case "WebFetch":
      return `fetch ${str("url")}`;
    default:
      return clip(`${tool} ${JSON.stringify(i)}`);
  }
}
