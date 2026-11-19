/**
 * Parley channel: an MCP server a Claude Code session loads so parley can
 * push voice messages straight into it and relay its permission prompts.
 *
 *   claude --dangerously-load-development-channels server:parley
 *
 * with `parley` defined in the project's .mcp.json or `claude mcp add`.
 * Needs channels enabled (Pro/Max: on; Team/Enterprise: an admin turns on
 * `channelsEnabled`). Without it, sessions are still reachable through hooks.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const url = process.env.PARLEY_URL ?? "http://127.0.0.1:7420";
const token = process.env.PARLEY_TOKEN ?? "";
const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };

const post = (path: string, body: unknown) =>
  fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) });

const mcp = new McpServer(
  { name: "parley", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {}, "claude/channel/permission": {} },
    },
    instructions:
      'Messages from the user\'s voice assistant arrive as <channel source="parley" from="voice">. They are the user speaking, transcribed, so expect informal wording and the odd misheard word. Treat them like a message typed in this session. When you finish work that a voice message asked for, call the reply tool with one or two plain spoken sentences (no markdown, no paths) saying what happened.',
  },
);

let sessionId: string | undefined;

mcp.registerTool(
  "reply",
  {
    description: "Say something back to the user over voice. One or two plain spoken sentences.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => {
    if (sessionId) await post("/channel/reply", { sessionId, text }).catch(() => undefined);
    return { content: [{ type: "text", text: sessionId ? "sent" : "parley hub not connected" }] };
  },
);

const PermissionRequest = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.server.setNotificationHandler(PermissionRequest, async ({ params }) => {
  if (sessionId) await post("/channel/permission", { sessionId, ...params }).catch(() => {});
});

await mcp.connect(new StdioServerTransport());

type Msg =
  | { kind: "message"; content: string; meta: Record<string, string> }
  | { kind: "verdict"; request_id: string; behavior: "allow" | "deny" };

/** Our parent is the Claude Code process; the hub maps its pid to a session id. */
async function register(): Promise<void> {
  for (;;) {
    try {
      const r = await post("/channel/register", { pid: process.ppid });
      if (r.ok) {
        sessionId = ((await r.json()) as { sessionId: string }).sessionId;
        return;
      }
    } catch {
      /* hub not running yet */
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function pollLoop(): Promise<never> {
  for (;;) {
    if (!sessionId) await register();
    try {
      const r = await fetch(`${url}/channel/poll?session=${sessionId}`, { headers });
      if (!r.ok) throw new Error(String(r.status));
      for (const m of ((await r.json()) as { messages: Msg[] }).messages) {
        if (m.kind === "message")
          await mcp.server.notification({
            method: "notifications/claude/channel",
            params: { content: m.content, meta: m.meta },
          });
        else
          await mcp.server.notification({
            method: "notifications/claude/channel/permission",
            params: { request_id: m.request_id, behavior: m.behavior },
          });
      }
    } catch {
      sessionId = undefined; // hub restarted: register again
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

const bye = () => {
  if (sessionId) void post("/channel/bye", { sessionId }).catch(() => {});
};
process.stdin.on("close", () => {
  bye();
  setTimeout(() => process.exit(0), 300);
});

void pollLoop();
