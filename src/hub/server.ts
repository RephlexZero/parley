import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Hub } from "./hub.ts";
import type { HookInput } from "./types.ts";
import { errorMessage } from "../errors.ts";

export type ToolRunner = (name: string, input: unknown) => Promise<string>;

/**
 * Local HTTP API on 127.0.0.1 only. Nothing here is reachable from the
 * internet: Claude Code's hooks, the brain's MCP server and channel servers
 * all run on this PC.
 *
 *   POST /hook                 Claude Code HTTP hooks (all events)
 *   POST /api/tool/:name       run a brain tool (used by the cli brain's MCP server)
 *   GET  /api/sessions         debug: what the hub sees
 *   POST /channel/register     {pid} -> {sessionId}
 *   GET  /channel/poll?session long-poll for messages/verdicts
 *   POST /channel/reply        {sessionId, text}
 *   POST /channel/permission   {sessionId, request_id, tool_name, description, input_preview}
 *   POST /channel/bye          {sessionId}
 */
export function startServer(hub: Hub, port: number, token: string, runTool: ToolRunner): Promise<Server> {
  const expected = Buffer.from(`Bearer ${token}`);
  const authed = (req: IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return token !== "" && got.length === expected.length && timingSafeEqual(got, expected);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!authed(req)) {
        send(res, 401, { error: "unauthorised" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "POST" && path === "/hook") {
        // A hook that errors is non-blocking in Claude Code; still, always answer.
        send(res, 200, await hub.handleHook((await body(req)) as HookInput));
        return;
      }
      if (req.method === "POST" && path.startsWith("/api/tool/")) {
        const out = await runTool(decodeURIComponent(path.slice("/api/tool/".length)), await body(req));
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(out);
        return;
      }
      if (req.method === "GET" && path === "/api/sessions") {
        send(res, 200, {
          sessions: await hub.sessions(0),
          approvals: hub.approvals.list(),
          projects: hub.projects.length,
        });
        return;
      }
      if (req.method === "POST" && path === "/channel/register") {
        const { pid } = (await body(req)) as { pid: number };
        const sessionId = await hub.channelRegister(pid);
        send(res, sessionId ? 200 : 404, { sessionId });
        return;
      }
      if (req.method === "GET" && path === "/channel/poll") {
        const sessionId = url.searchParams.get("session") ?? "";
        send(res, 200, { messages: await hub.channelPoll(sessionId) });
        return;
      }
      if (req.method === "POST" && path === "/channel/reply") {
        const { sessionId, text } = (await body(req)) as { sessionId: string; text: string };
        await hub.channelReply(sessionId, text);
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && path === "/channel/permission") {
        const b = (await body(req)) as {
          sessionId: string;
          request_id: string;
          tool_name: string;
          description: string;
          input_preview: string;
        };
        void hub.channelPermission(b.sessionId, b);
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && path === "/channel/bye") {
        hub.channelGone(((await body(req)) as { sessionId: string }).sessionId);
        send(res, 200, { ok: true });
        return;
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: errorMessage(e) });
    }
  };
  const server = createServer((req, res) => void handle(req, res));
  server.requestTimeout = 0; // long-polls and approval hooks hold requests open
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function send(res: ServerResponse, status: number, obj: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}
