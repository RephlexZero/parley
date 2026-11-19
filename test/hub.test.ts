import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { Hub, pronounTarget } from "../src/hub/hub.ts";
import { startServer } from "../src/hub/server.ts";
import { lastAssistantText, mergeSessions, transcriptPath } from "../src/hub/sessions.ts";
import { summariseTool } from "../src/hub/approvals.ts";
import { noteFromParent } from "../src/hub/projects.ts";
import type { HubEvent } from "../src/hub/types.ts";

function fakeClaudeDir() {
  const dir = mkdtempSync(join(tmpdir(), "parley-"));
  mkdirSync(join(dir, "sessions"));
  // Our own pid, so the "is it alive" check passes.
  writeFileSync(
    join(dir, "sessions", `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: "11111111-aaaa",
      cwd: "/home/user/work/orbit",
      name: "Lidar capture",
      status: "busy",
      kind: "interactive",
      bridgeSessionId: "session_x",
      updatedAt: 5,
    }),
  );
  writeFileSync(join(dir, "sessions", "999999.json"), JSON.stringify({ pid: 999999, sessionId: "dead", cwd: "/x" }));
  return dir;
}

test("registry + agents merge, dead pids dropped", async () => {
  const dir = fakeClaudeDir();
  const { readRegistry } = await import("../src/hub/sessions.ts");
  const reg = readRegistry(dir);
  assert.equal(reg.length, 1);
  const merged = mergeSessions(
    reg,
    [
      {
        id: "22222222",
        sessionId: "22222222-bbbb",
        cwd: "/home/user/code/personal/tidepool",
        kind: "background",
        state: "blocked",
        name: "backtest",
      },
    ],
    config.projects,
    { channels: new Set(), dispatched: new Set() },
  );
  assert.equal(merged.length, 2);
  const s = merged.find((x) => x.sessionId === "11111111-aaaa")!;
  assert.equal(s.remoteControl, true);
  assert.equal(s.state, "busy");
  assert.equal(s.domain, "work");
  assert.equal(merged.find((x) => x.short === "22222222")!.state, "blocked");
});

test("reads the last assistant text from a transcript tail", () => {
  const dir = fakeClaudeDir();
  const p = transcriptPath(dir, "/home/user/code/personal/x.y", "abc");
  assert.ok(p.includes("-home-user-code-personal-x-y"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(
    p,
    [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "First answer." }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Tests pass." }] } }),
      JSON.stringify({ type: "system", subtype: "x" }),
    ].join("\n"),
  );
  assert.equal(lastAssistantText(p), "Tests pass.");
});

test("tool summaries are speakable", () => {
  assert.equal(summariseTool("Bash", { command: "npm test\nnpm run lint" }), "run npm test");
  assert.equal(summariseTool("Edit", { file_path: "src/main.rs" }), "edit src/main.rs");
});

test("PermissionRequest hook: no call -> no opinion; in call -> spoken decision", async () => {
  const cfg = {
    ...config,
    claudeDir: fakeClaudeDir(),
    projects: { ...config.projects, roots: [] },
    hub: { ...config.hub, approvalTimeoutS: 2 },
  };
  const hub = new Hub(cfg);
  const server = await startServer(hub, 0, "secret", () => Promise.resolve("ok"));
  const port = (server.address() as { port: number }).port;
  const hook = (body: object, token = "secret") =>
    fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const req = {
    hook_event_name: "PermissionRequest",
    session_id: "11111111-aaaa",
    cwd: "/home/user/work/orbit",
    tool_name: "Bash",
    tool_input: { command: "rm -rf build" },
  };

  try {
    assert.equal((await hook(req, "wrong")).status, 401);
    assert.deepEqual(await (await hook(req)).json(), {});

    hub.callActive = true;
    const events: HubEvent[] = [];
    hub.on("event", (e) => {
      events.push(e);
      if (e.type === "approval") setTimeout(() => hub.approvals.resolve("deny"), 10);
    });
    const res = (await (await hook(req)).json()) as { hookSpecificOutput: { decision: { behavior: string } } };
    assert.equal(res.hookSpecificOutput.decision.behavior, "deny");
    const ev = events.find((e) => e.type === "approval");
    assert.ok(ev?.type === "approval" && ev.approval.summary === "run rm -rf build");

    // Unanswered: falls back to the normal prompt after the timeout.
    hub.removeAllListeners("event");
    const t0 = Date.now();
    assert.deepEqual(await (await hook(req)).json(), {});
    assert.ok(Date.now() - t0 >= 1900);
  } finally {
    server.close();
  }
});

test("channel long-poll delivers pushed messages and verdicts", async () => {
  const cfg = { ...config, claudeDir: fakeClaudeDir(), projects: { ...config.projects, roots: [] } };
  const hub = new Hub(cfg);
  const id = await hub.channelRegister(process.pid);
  assert.equal(id, "11111111-aaaa");
  const s = (await hub.session(id))!;
  assert.equal(s.channel, true);
  const poll = hub.channelPoll(id, 1000);
  assert.match(await hub.send(s, "run the tests"), /through its channel/);
  assert.deepEqual(await poll, [{ kind: "message", content: "run the tests", meta: { from: "voice" } }]);
  assert.deepEqual(await hub.channelPoll(id, 50), []);
});

test("interactive session without a channel: cross-session message, fork offer if it fails", async () => {
  const cfg = { ...config, claudeDir: fakeClaudeDir(), projects: { ...config.projects, roots: [] } };
  const hub = new Hub(cfg);
  const s = (await hub.session("11111111-aaaa"))!;
  const sent: string[] = [];
  hub.messageInteractive = (target, text) => {
    sent.push(`${target.name}: ${text}`);
    return Promise.resolve(true);
  };
  assert.match(await hub.send(s, "hello"), /cross-session message/);
  assert.deepEqual(sent, ["Lidar capture: hello"]);
  hub.messageInteractive = () => Promise.resolve("no such session");
  assert.match(await hub.send(s, "hello"), /couldn't message .*fork/);
});

test("watcher announces busy -> done once, and stays quiet if a hook already did", () => {
  const cfg = { ...config, claudeDir: fakeClaudeDir(), projects: { ...config.projects, roots: [] } };
  const hub = new Hub(cfg);
  const events: HubEvent[] = [];
  hub.on("event", (e) => events.push(e));
  const s = (state: "busy" | "idle" | "blocked", id = "s1") =>
    ({
      sessionId: id,
      short: id,
      name: "x",
      cwd: "/x",
      project: "x",
      domain: "personal",
      kind: "background",
      remoteControl: false,
      state,
      channel: false,
      dispatched: true,
      updatedAt: 0,
    }) as const;
  hub.watchTick([s("busy"), s("busy", "s2")]);
  hub.watchTick([s("idle"), s("blocked", "s2")]);
  hub.watchTick([s("idle"), s("blocked", "s2")]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["turn_done", "needs_input"],
  );
});

test("project notes come from the parent folder's CLAUDE.md rows, not passing mentions", () => {
  const doc = [
    "- Supporting repos: `racing/ECU/` and `racing/sim/`.",
    "| `ECU/` | Core code for the **ECU** (has `DBCs` as a submodule) |",
    "| `veloxis/`, `sbinalla/` | Rust simulation work |",
    "- `coursework-notes/` — modules, coursework, and `fyp/`:",
    "  what the project is.",
  ].join("\n");
  assert.equal(noteFromParent("ECU", doc), "Core code for the ECU (has DBCs as a submodule)");
  assert.equal(noteFromParent("sbinalla", doc), "Rust simulation work");
  assert.equal(noteFromParent("coursework-notes", doc), "modules, coursework, and fyp/: what the project is.");
  assert.equal(noteFromParent("DBCs", doc), "");
});

test("pointers resolve to what was last started or discussed", () => {
  const mk = (id: string, state: "busy" | "idle") =>
    ({
      sessionId: id,
      short: id,
      name: id,
      cwd: "/x",
      project: "x",
      domain: "uni",
      kind: "background",
      remoteControl: false,
      state,
      channel: false,
      dispatched: true,
      updatedAt: 0,
    }) as const;
  const all = [mk("old", "idle"), mk("rtl", "busy"), mk("review", "idle")];
  assert.equal(pronounTarget("that one", all, ["review", "rtl"])?.sessionId, "review");
  assert.equal(pronounTarget("the one that's running", all, ["review", "rtl"])?.sessionId, "rtl");
  assert.equal(pronounTarget("the running one", all, [])?.sessionId, "rtl");
  assert.equal(pronounTarget("that", all, [])?.sessionId, undefined);
  assert.equal(pronounTarget("orbit", all, ["rtl"]), undefined);
});
