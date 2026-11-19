import { z } from "zod";
import type { Hub, Resolved } from "../hub/hub.ts";
import { label } from "../hub/sessions.ts";
import type { Project, Session } from "../hub/types.ts";
import { errorMessage } from "../errors.ts";

/** What tools can do beyond the hub. Provided by the voice side. */
export interface ToolContext {
  hub: Hub;
  /** Put long or visual output in the Discord text channel instead of speaking it. */
  post: (text: string) => Promise<void>;
  log?: (msg: string) => void;
}

export interface ToolSpec<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

const tool = <S extends z.ZodObject>(t: ToolSpec<S>) => t as unknown as ToolSpec;

const line = (s: Session) =>
  `- ${label(s)} [${s.short}] ${s.state}${s.kind === "background" ? ", background" : ""}${s.remoteControl ? ", remote-control" : ""}${s.channel ? ", channel" : ""} (${s.domain})`;

function explain<T>(r: Exclude<Resolved<T>, { ok: T }>, what: string, show: (t: T) => string): string {
  if ("ambiguous" in r) return `Ambiguous ${what}. Ask which one: ${r.ambiguous.map(show).join("; ")}`;
  return `No ${what} matched. Ask the user to say the project or session name again.`;
}

export const TOOLS: ToolSpec[] = [
  tool({
    name: "list_sessions",
    description:
      "List the Claude Code sessions running on the user's PC with their state. Use for 'what's running', 'what's everything up to', or before acting when unsure which session is meant.",
    schema: z.object({
      domain: z
        .enum(["work", "uni", "personal", "all"])
        .optional()
        .describe("Only sessions in this area. Default all."),
    }),
    run: async ({ domain }, { hub }) => {
      const all = await hub.sessions();
      const ss = domain && domain !== "all" ? all.filter((s) => s.domain === domain) : all;
      return ss.length ? ss.map(line).join("\n") : "No sessions running.";
    },
  }),

  tool({
    name: "session_status",
    description:
      "State and latest message of one session. Target is whatever the user called it: project name, session name, or short id.",
    schema: z.object({ target: z.string() }),
    run: async ({ target }, { hub }) => {
      const r = await hub.resolveSession(target);
      if (!("ok" in r)) return explain(r, "session", label);
      const msg = hub.lastMessage(r.ok);
      return `${line(r.ok)}\nLatest message:\n${msg ? msg.slice(-1500) : "(none yet)"}`;
    },
  }),

  tool({
    name: "dispatch_task",
    description:
      "Start a NEW background Claude Code session in a project to do real work (code changes, investigations, reviews). Returns at once; you'll get an event when it finishes. Restate the task in one line before calling.",
    schema: z.object({
      project: z.string().describe("Project name as the user said it"),
      task: z
        .string()
        .describe(
          "A complete, self-contained brief: what to do and what done looks like. Write it for an engineer with no context.",
        ),
      model: z.enum(["haiku", "sonnet", "opus", "fable"]).optional().describe("Only if the user asked for one"),
      name: z.string().optional().describe("Short session name, 2-5 words"),
    }),
    run: async ({ project, task, model, name }, { hub }) => {
      const r = hub.resolveProject(project);
      if (!("ok" in r)) return explain(r, "project", (p: Project) => `${p.name} (${p.domain})`);
      // The paraphrase can drop details; give the session the user's own words too.
      const words = hub.lastUtterance.trim();
      const brief = words ? `${task}\n\nThe user's own words (spoken, transcribed), for reference: "${words}"` : task;
      const s = await hub.dispatch(r.ok, brief, { model, name });
      if (typeof s === "string") {
        hub.acted(`Started it in ${r.ok.name}.`);
        return `Dispatched in ${r.ok.name}: ${s}`;
      }
      hub.acted(`Started ${s.name || `a session in ${r.ok.name}`}.`);
      return `Dispatched: ${label(s)} [${s.short}]`;
    },
  }),

  tool({
    name: "send_to_session",
    description:
      'Send a follow-up instruction or answer into an EXISTING session. Target can be its short id, name, project, or a pointer like "that one" or "the one that\'s running" (resolved from what was last started or discussed). Use fork=true only when the user agrees to branch an interactive session into a background copy.',
    schema: z.object({ target: z.string(), message: z.string(), fork: z.boolean().optional() }),
    run: async ({ target, message, fork }, { hub }) => {
      const r = await hub.resolveSession(target);
      if (!("ok" in r)) return explain(r, "session", label);
      return hub.send(r.ok, message, { fork });
    },
  }),

  tool({
    name: "answer_approval",
    description:
      "Allow or deny a pending tool approval that was read out. Only call after the user clearly said yes/allow or no/deny. Without id, answers the oldest pending one.",
    schema: z.object({ decision: z.enum(["allow", "deny"]), id: z.string().optional() }),
    run: ({ decision, id }, { hub }) => {
      const a = hub.approvals.resolve(decision, id);
      if (a) hub.acted(decision === "allow" ? "Allowed." : "Denied.");
      return Promise.resolve(
        a
          ? `${decision === "allow" ? "Allowed" : "Denied"}: ${a.sessionLabel} – ${a.summary}`
          : "No approval is pending.",
      );
    },
  }),

  tool({
    name: "post_to_text",
    description:
      "Post text to the user's Discord text channel. Use for anything that is bad to listen to: code, paths, lists over 3 items, URLs, long session output. Then say one sentence pointing to it.",
    schema: z.object({ text: z.string() }),
    run: async ({ text }, { post }) => {
      await post(text);
      return "Posted.";
    },
  }),
];

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<string> {
  const t0 = Date.now();
  const out = await runToolInner(name, input, ctx);
  ctx.log?.(
    `tool ${name} ${oneLine(JSON.stringify(input), 300)} (${String(Date.now() - t0)}ms) -> ${oneLine(out, 300)}`,
  );
  return out;
}

async function runToolInner(name: string, input: unknown, ctx: ToolContext): Promise<string> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return `Unknown tool ${name}`;
  const parsed = t.schema.safeParse(input);
  if (!parsed.success) return `Invalid input: ${parsed.error.message}`;
  try {
    return await t.run(parsed.data, ctx);
  } catch (e) {
    return `Failed: ${errorMessage(e)}`;
  }
}

const oneLine = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
};
