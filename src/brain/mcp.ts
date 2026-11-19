/**
 * Stdio MCP server the cli brain loads. It exposes parley's tools and runs
 * each one by calling the hub, which owns all the state.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS } from "./tools.ts";
import { errorMessage } from "../errors.ts";

const url = process.env.PARLEY_URL ?? "http://127.0.0.1:7420";
const token = process.env.PARLEY_TOKEN ?? "";

const server = new McpServer({ name: "parley", version: "0.1.0" });

for (const t of TOOLS) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.schema.shape }, async (input: unknown) => {
    try {
      const res = await fetch(`${url}/api/tool/${t.name}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(input ?? {}),
      });
      const text = await res.text();
      return { content: [{ type: "text" as const, text }], isError: !res.ok };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `parley hub unreachable: ${errorMessage(e)}` }],
        isError: true,
      };
    }
  });
}

await server.connect(new StdioServerTransport());
