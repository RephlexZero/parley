export type Domain = "work" | "uni" | "personal" | "other";

export type SessionState = "busy" | "idle" | "blocked" | "waiting" | "unknown";

export interface Session {
  sessionId: string;
  /** First 8 chars of the id; what `claude agents` calls the short id. */
  short: string;
  name: string;
  cwd: string;
  project: string;
  domain: Domain;
  /** interactive = terminal/desktop/Remote Control; background = `claude --bg`. */
  kind: "interactive" | "background";
  /** Reachable from claude.ai / the phone via Remote Control. */
  remoteControl: boolean;
  state: SessionState;
  pid?: number;
  /** A parley channel server is attached, so messages can be pushed straight in. */
  channel: boolean;
  /** Started by parley's dispatch_task: its completion is announced. */
  dispatched: boolean;
  updatedAt: number;
}

export interface Project {
  name: string;
  path: string;
  domain: Domain;
  /** Lower-case words a person might say for this project. */
  aliases: string[];
  /** One line on what it is and what's in it, so the brain can match "my coursework" to a folder. */
  description?: string;
}

export interface Approval {
  id: string;
  sessionId: string;
  sessionLabel: string;
  toolName: string;
  /** One line, safe to read aloud: "run npm test" / "edit src/main.rs". */
  summary: string;
  source: "hook" | "channel";
  /** For channel relays: the request_id Claude Code issued. */
  channelRequestId?: string | undefined;
  createdAt: number;
}

export type Decision = "allow" | "deny";

/** Everything the hub tells the voice side about. */
export type HubEvent =
  | { type: "approval"; approval: Approval }
  | { type: "approval_closed"; id: string; decision: Decision | "timeout" }
  | { type: "turn_done"; session: Session; lastMessage: string }
  | { type: "needs_input"; session: Session; message: string }
  | { type: "session_reply"; session: Session; text: string }
  /** Parley just started this session (dispatch, or a resume that became a new session): talk about it next. */
  | { type: "dispatched"; session: Session }
  /** An acting tool succeeded: say this, built from the result rather than the model's own claim. */
  | { type: "acted"; say: string };

/** Fields Claude Code sends to every hook. */
export interface HookInput {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  message?: string;
  notification_type?: string;
  last_assistant_message?: string;
  [k: string]: unknown;
}
