import type { Hub } from "../hub/hub.ts";
import { inProject } from "../hub/projects.ts";
import { label } from "../hub/sessions.ts";
import type { Session } from "../hub/types.ts";
import { topicHeader, type Topic } from "./router.ts";

const OVERVIEW =
  /\b(what'?s (running|going on|happening|up)|status|overview|everything|all (my )?sessions|sessions)\b/i;

const brief = (s: Session) =>
  `${label(s)} [${s.short}]: ${s.state}${s.kind === "background" ? ", background" : ""}${s.remoteControl ? ", remote-control" : ""}`;

/**
 * The text of one brain turn: topic line, then the facts the brain would
 * otherwise fetch with a tool (saves a ~1.5 s round trip on most questions),
 * then what the user said. Only facts for the current topic go in, which also
 * keeps the brain from wandering into other sessions.
 */
export function turnInput(topic: Topic, said: string, sessions: Session[], hub: Pick<Hub, "lastMessage">): string {
  const lines = [
    topicHeader(
      topic,
      sessions.find((s) => s.sessionId === topic.sessionId),
    ),
  ];
  if (topic.kind === "session") {
    const s = sessions.find((x) => x.sessionId === topic.sessionId);
    if (s) {
      const last = hub.lastMessage(s);
      lines.push(`[context] ${brief(s)}`, `[context] its latest message: ${last ? clip(last, 900) : "(none yet)"}`);
    } else lines.push("[context] this session is no longer running");
  } else if (topic.kind === "project") {
    const ss = sessions.filter((s) => inProject(s.cwd, topic.projectPath ?? ""));
    lines.push(
      ss.length
        ? `[context] sessions in this project:\n${ss.map((s) => "- " + brief(s)).join("\n")}`
        : "[context] no sessions running in this project",
    );
  } else if (OVERVIEW.test(said)) {
    lines.push(
      sessions.length
        ? `[context] all sessions:\n${sessions.map((s) => `- ${brief(s)} (${s.domain})`).join("\n")}`
        : "[context] no sessions running",
    );
  }
  lines.push(said);
  return lines.join("\n");
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? "…" + flat.slice(-n) : flat;
}

/** Said the moment a tool call starts, so there's no dead air while it runs. */
export const TOOL_FILLER: Record<string, string> = {
  list_sessions: "Checking.",
  session_status: "Checking.",
  dispatch_task: "On it.",
};
