import { rank, words } from "../match.ts";
import { Hub } from "../hub/hub.ts";
import { inProject } from "../hub/projects.ts";
import { label } from "../hub/sessions.ts";
import type { Decision, Domain, Project, Session } from "../hub/types.ts";

/**
 * Topic binning. Every utterance lands in exactly one topic, and each topic
 * has its own conversation with the brain, so talk about one project never
 * leaks into another and unrelated chat never reaches a work session.
 */
export interface Topic {
  id: string;
  kind: "session" | "project" | "general";
  title: string;
  domain: Domain | "none";
  sessionId?: string;
  projectPath?: string;
  lastUsed: number;
}

export type Route =
  { kind: "approval"; decision: Decision } | { kind: "topic"; topic: Topic; switched: boolean; reason: string };

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go( ahead)?|do it|allow( it)?|approve(d)?|fine|go for it)\b/;
const NO = /^(no|nope|nah|deny|denied|don'?t|do not|stop|cancel|reject|block it)\b/;
const OFF_TOPIC =
  /\b(unrelated|random question|quick question|different topic|something else|change of subject|off topic|new topic|general question)\b/;
const NOT_A_DECISION = /\b(but|wait|what|which|why|how|first|instead)\b/;
const RETRACT =
  /\b(actually,? no|scratch that|never ?mind|forget (that|it|about)|let'?s not|not that one|no,? wait)\b/i;
const NEGATED =
  /\b(not|don'?t|forget( about)?|skip|ignore|never ?mind)\s+((do|touch|bother with|worry about|about|with|on|the)\s+)*[\w-]+(\s+(project|session|one))?/gi;

/**
 * Drop what the user took back before matching names: "Orbit... actually no,
 * let's not do Orbit. How's tidepool?" is about tidepool only.
 */
export function withoutRetracted(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/);
  let last = -1;
  parts.forEach((p, i) => {
    if (RETRACT.test(p)) last = i;
  });
  const kept = last >= 0 && last < parts.length - 1 ? parts.slice(last + 1).join(" ") : text;
  return kept.replace(NEGATED, " ");
}

/** A bare yes/no, said while an approval is pending. Longer replies go to the brain. */
export function approvalDecision(text: string): Decision | undefined {
  const w = words(text);
  if (!w.length || w.length > 6) return undefined;
  const t = w.join(" ");
  if (NOT_A_DECISION.test(t)) return undefined;
  if (YES.test(t)) return "allow";
  if (NO.test(t)) return "deny";
  return undefined;
}

export class Router {
  private topics = new Map<string, Topic>();
  current: Topic;

  private stickyMs: number;

  constructor(stickyMs = 120_000) {
    this.stickyMs = stickyMs;
    this.current = this.general(0);
  }

  private general(now: number): Topic {
    return this.upsert({ id: "general", kind: "general", title: "general chat", domain: "none", lastUsed: now });
  }

  private upsert(t: Topic): Topic {
    const existing = this.topics.get(t.id);
    if (existing) {
      existing.title = t.title;
      return existing;
    }
    this.topics.set(t.id, t);
    return t;
  }

  forSession(s: Session, now = Date.now()): Topic {
    return this.upsert({
      id: `session:${s.sessionId}`,
      kind: "session",
      title: label(s),
      domain: s.domain,
      sessionId: s.sessionId,
      projectPath: s.cwd,
      lastUsed: now,
    });
  }

  forProject(p: Project, now = Date.now()): Topic {
    return this.upsert({
      id: `project:${p.path}`,
      kind: "project",
      title: p.name,
      domain: p.domain,
      projectPath: p.path,
      lastUsed: now,
    });
  }

  route(
    text: string,
    ctx: { sessions: Session[]; projects: Project[]; pendingApprovals: number },
    now = Date.now(),
  ): Route {
    if (ctx.pendingApprovals > 0) {
      const d = approvalDecision(text);
      if (d) return { kind: "approval", decision: d };
    }
    const enter = (topic: Topic, reason: string): Route => {
      const switched = topic.id !== this.current.id;
      topic.lastUsed = now;
      this.current = topic;
      return { kind: "topic", topic, switched, reason };
    };

    const said = withoutRetracted(text);
    const projectOf = (s: Session) => ctx.projects.find((p) => inProject(s.cwd, p.path));

    // 1. A session named by its own name (or short id) wins, unless it has
    //    finished and a sibling in the same project is still working: then
    //    "the coursework session" most likely means the running one, so the
    //    project topic (which lists both, with states) decides.
    const named = rank(said, ctx.sessions, (s) => [s.name, s.short].filter(Boolean));
    const [first, second] = named;
    let namedProject: Project | undefined;
    if (first && (!second || first.score > second.score)) {
      const s = first.item;
      const p = projectOf(s);
      const busySibling =
        s.state !== "busy" &&
        p !== undefined &&
        ctx.sessions.some((o) => o !== s && o.state === "busy" && inProject(o.cwd, p.path));
      if (!busySibling) return enter(this.forSession(s, now), `mentioned ${label(s)}`);
      namedProject = p;
    }

    // 2. A project named: its only session, else the project topic, whose
    //    context lists its sessions so the brain can tell them apart.
    const project =
      namedProject ??
      rank(said, ctx.projects, (p) => p.aliases)[0]?.item ??
      ctx.projects.find((p) =>
        inProject(rank(said, ctx.sessions, (s) => Hub.sessionAliases(s))[0]?.item.cwd ?? "", p.path),
      );
    if (project) {
      const members = ctx.sessions.filter((s) => inProject(s.cwd, project.path));
      const [only] = members;
      if (only && members.length === 1) return enter(this.forSession(only, now), `mentioned ${project.name}`);
      return enter(this.forProject(project, now), `mentioned ${project.name}`);
    }

    if (OFF_TOPIC.test(words(said).join(" "))) return enter(this.general(now), "marked as unrelated");
    if (now - this.current.lastUsed < this.stickyMs) return enter(this.current, "continuing");
    return enter(this.general(now), "no project named and the last topic went quiet");
  }

  /** Point the conversation at a session (e.g. it just finished and we're telling the user). */
  focus(t: Topic, now = Date.now()): void {
    t.lastUsed = now;
    this.current = t;
  }

  all(): Topic[] {
    return [...this.topics.values()];
  }

  drop(id: string): void {
    if (id !== "general") this.topics.delete(id);
  }
}

/** The line that opens every brain turn, telling it which bin it is in. */
export function topicHeader(t: Topic, s?: Session): string {
  switch (t.kind) {
    case "general":
      return "[topic: general chat. Not about any Claude session or project. Don't use session tools unless the user explicitly asks.]";
    case "project":
      return `[topic: project ${t.title} (${t.domain}) at ${t.projectPath}. Only this project.]`;
    case "session":
      return `[topic: session ${t.title} (${t.domain}${s ? `, ${s.state}, ${s.kind}` : ""}). Only this session; target it as "${s?.short ?? t.title}".]`;
  }
}
