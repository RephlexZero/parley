/**
 * Prints what to paste into ~/.claude/settings.json (hooks) and an MCP entry
 * for the optional channel. Makes a PARLEY_TOKEN if there isn't one.
 * Parley never edits your Claude settings itself.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { config } from "../config.ts";

let token = config.hub.token;
if (!token) {
  token = randomBytes(24).toString("base64url");
  console.log(`# 1. Add to parley/.env:\nPARLEY_TOKEN=${token}\n`);
}

const url = `http://127.0.0.1:${config.hub.port}/hook`;
const headers = { Authorization: `Bearer ${token}` };
const http = (timeout: number) => [{ hooks: [{ type: "http", url, timeout, headers }] }];

const hooks = {
  hooks: {
    // Waits for a spoken yes/no while you're in the call; answers instantly ("no opinion") otherwise.
    PermissionRequest: http(config.hub.approvalTimeoutS + 15),
    Stop: http(5),
    Notification: http(5),
  },
};

console.log("# 2. Merge into ~/.claude/settings.json (applies to every session, including claude-rc ones):");
console.log(JSON.stringify(hooks, null, 2));

const mcp = {
  mcpServers: {
    parley: {
      command: "node",
      args: [join(import.meta.dirname, "..", "channel", "server.ts")],
      env: { PARLEY_URL: `http://127.0.0.1:${config.hub.port}`, PARLEY_TOKEN: token },
    },
  },
};
console.log("\n# 3. Optional, two-way channel (needs channels enabled for your plan). Add as a user MCP server:");
console.log(`claude mcp add-json --scope user parley '${JSON.stringify(mcp.mcpServers.parley)}'`);
console.log("# then start sessions with:  claude --dangerously-load-development-channels server:parley");
