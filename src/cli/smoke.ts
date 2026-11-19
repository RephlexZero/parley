/**
 * Talk to the brain from the terminal, no Discord or audio:
 *   npm run smoke -- "what's running?" "how's tidepool?"
 * Uses the real hub (your sessions) and the configured brain backend.
 * Tools that act (dispatch, send, approve) are stubbed unless SMOKE_LIVE=1.
 */
import { ApiBrain } from "../brain/api.ts";
import type { Brain } from "../brain/brain.ts";
import { CliBrain } from "../brain/cli.ts";
import { TOOL_FILLER, turnInput } from "../brain/context.ts";
import { Router } from "../brain/router.ts";
import { runTool, type ToolContext } from "../brain/tools.ts";
import { config } from "../config.ts";
import { Hub } from "../hub/hub.ts";
import { startServer } from "../hub/server.ts";
import { errorMessage } from "../errors.ts";

const token = config.hub.token || "smoke";
const hub = new Hub(config);
const ctx: ToolContext = {
  hub,
  post: (t) => {
    console.log(`\n[posted to text channel]\n${t}\n`);
    return Promise.resolve();
  },
};
const ACTING = new Set(["dispatch_task", "send_to_session", "answer_approval"]);
const server = await startServer(hub, 0, token, async (name, input) => {
  console.log(`  ⚙ ${name} ${JSON.stringify(input)}`);
  if (ACTING.has(name) && !process.env.SMOKE_LIVE) return `(smoke test: ${name} not run)`;
  return runTool(name, input, ctx);
});
const port = (server.address() as { port: number }).port;

const brain: Brain =
  config.brain.kind === "api"
    ? new ApiBrain(config.brain, ctx, false)
    : new CliBrain(config.brain, { port, token }, config.stateDir, false, hub.projects);
const router = new Router();
const t0 = Date.now();
await brain.warm(router.current);
await new Promise((r) => setTimeout(r, Number(process.env.SMOKE_WARM_MS ?? 0)));

for (const said of process.argv.slice(2)) {
  const sessions = await hub.sessions();
  const r = router.route(said, { sessions, projects: hub.projects, pendingApprovals: 0 });
  if (r.kind !== "topic") continue;
  console.log(`\n> ${said}\n  [${r.topic.title}: ${r.reason}]`);
  const start = Date.now();
  let first = 0;
  process.stdout.write("  ");
  const out = (d: string) => {
    first ||= Date.now() - start;
    process.stdout.write(d);
  };
  const input = turnInput(r.topic, said, sessions, hub);
  if (process.env.SMOKE_SHOW_INPUT) console.log(input.replace(/^/gm, "  | "));
  try {
    await brain.turn(
      r.topic,
      input,
      { text: out, tool: (n) => TOOL_FILLER[n] && !first && out(`(${TOOL_FILLER[n]}) `) },
      new AbortController().signal,
    );
  } catch (e) {
    console.log(`[brain error] ${errorMessage(e)}`);
  }
  console.log(`\n  (first token ${first} ms, turn ${Date.now() - start} ms)`);
}
console.log(`\ntotal ${Date.now() - t0} ms`);
brain.close();
server.close();
