import { test } from "node:test";
import assert from "node:assert/strict";
import { Router, approvalDecision, withoutRetracted } from "../src/brain/router.ts";
import { mentionScore } from "../src/match.ts";
import { aliasesFor } from "../src/hub/projects.ts";
import type { Project, Session } from "../src/hub/types.ts";

const proj = (name: string, path: string, domain: Project["domain"]): Project => ({
  name,
  path,
  domain,
  aliases: aliasesFor(name),
});
const sess = (id: string, cwd: string, name: string, domain: Session["domain"]): Session => ({
  sessionId: id,
  short: id.slice(0, 8),
  name,
  cwd,
  project: cwd.split("/").pop()!,
  domain,
  kind: "background",
  remoteControl: false,
  state: "idle",
  channel: false,
  dispatched: false,
  updatedAt: 0,
});

const projects = [
  proj("orbit", "/home/user/work/orbit", "work"),
  proj("tidepool", "/home/user/code/personal/tidepool", "personal"),
  proj("wheel-tuning", "/home/user/code/personal/wheel-tuning", "personal"),
  proj("discord-bot", "/home/user/code/uni/racing/discord-bot", "uni"),
];
const sessions = [
  sess("aaaaaaaa-1", "/home/user/work/orbit", "enterprise deployment architecture", "work"),
  sess("bbbbbbbb-2", "/home/user/work/orbit", "Lidar input and camera", "work"),
  sess("cccccccc-3", "/home/user/code/personal/tidepool", "", "personal"),
];
const ctx = { sessions, projects, pendingApprovals: 0 };

test("names match through STT noise", () => {
  assert.equal(mentionScore("how's tide pool doing", "tidepool"), 0.9);
  assert.equal(mentionScore("how is tidepoal doing", "tidepool"), 0.75);
  assert.equal(mentionScore("check the lidar camera thing", "Lidar input and camera"), 0.8);
  assert.equal(mentionScore("what's the weather", "orbit"), 0);
});

test("a project with one session routes straight to that session", () => {
  const r = new Router().route("how's tidepool getting on", ctx, 1000);
  assert.ok(r.kind === "topic");
  assert.equal(r.topic.sessionId, "cccccccc-3");
});

test("a project with several sessions routes to the project unless one is named", () => {
  const router = new Router();
  const a = router.route("what's happening on orbit", ctx, 1000);
  assert.ok(a.kind === "topic" && a.topic.kind === "project" && a.topic.title === "orbit");
  const b = router.route("what about the lidar camera one", ctx, 2000);
  assert.ok(b.kind === "topic" && b.topic.sessionId === "bbbbbbbb-2");
});

test("follow-ups stay in the topic, unrelated asides go to general", () => {
  const router = new Router(120_000);
  router.route("orbit lidar camera status", ctx, 1000);
  const follow = router.route("and did the tests pass", ctx, 5000);
  assert.ok(follow.kind === "topic" && follow.topic.sessionId === "bbbbbbbb-2" && !follow.switched);
  const aside = router.route("random question, how long do you boil an egg", ctx, 6000);
  assert.ok(aside.kind === "topic" && aside.topic.kind === "general" && aside.switched);
});

test("after a quiet spell, an un-named question is general chat", () => {
  const router = new Router(120_000);
  router.route("orbit lidar camera status", ctx, 0);
  const r = router.route("what should I have for dinner", ctx, 300_000);
  assert.ok(r.kind === "topic" && r.topic.kind === "general");
});

test("topics are separate bins with stable ids", () => {
  const router = new Router();
  const a = router.route("tidepool status", ctx, 1);
  router.route("orbit lidar camera", ctx, 2);
  const c = router.route("back to tidepool", ctx, 3);
  assert.ok(a.kind === "topic" && c.kind === "topic" && a.topic === c.topic);
  assert.equal(router.all().length, 3); // general + 2
});

test("yes/no only short-circuits when an approval is pending", () => {
  assert.equal(approvalDecision("yeah go ahead"), "allow");
  assert.equal(approvalDecision("no"), "deny");
  assert.equal(approvalDecision("yes but run the tests first"), undefined);
  assert.equal(approvalDecision("what does it want to run"), undefined);
  const router = new Router();
  assert.equal(router.route("yes", ctx, 1).kind, "topic");
  assert.deepEqual(router.route("yes", { ...ctx, pendingApprovals: 1 }, 2), { kind: "approval", decision: "allow" });
});

test("sessions from a moved repo still belong to the project (by folder name)", () => {
  const moved = [proj("orbit", "/home/user/code/work/orbit", "work"), ...projects.slice(1)];
  const router = new Router();
  router.route("the lidar camera one", { ...ctx, projects: moved }, 1);
  const r = router.route("and the other orbit one?", { ...ctx, projects: moved }, 2);
  assert.ok(r.kind === "topic" && r.topic.kind === "project" && r.topic.projectPath === "/home/user/code/work/orbit");
});

test("a retracted project doesn't steal the topic", () => {
  assert.doesNotMatch(
    withoutRetracted("Hmm. So with the Orbit project... Actually, no, let's not do Orbit. How's tidepool?"),
    /orbit/i,
  );
  assert.doesNotMatch(withoutRetracted("not orbit, the tidepool one"), /orbit/i);
  const r = new Router().route(
    "So with the Orbit project... Actually, no, let's not do Orbit. How's tidepool?",
    ctx,
    1000,
  );
  assert.ok(r.kind === "topic" && r.topic.sessionId === "cccccccc-3");
});

test("a finished session's name goes to its project while a sibling is still working", () => {
  const uni = proj("coursework-notes", "/home/user/code/uni/coursework-notes", "uni");
  const done = sess("dddddddd-4", uni.path, "Circuits coursework and scoping report", "uni");
  const busy = {
    ...sess("eeeeeeee-5", uni.path + "/.claude/worktrees/rtl", "EE10101 RTL and Genus", "uni"),
    state: "busy" as const,
  };
  const c = { sessions: [done, busy], projects: [uni], pendingApprovals: 0 };
  const r = new Router().route("tell the circuits coursework session I've signed in", c, 1000);
  assert.ok(r.kind === "topic" && r.topic.kind === "project" && r.topic.title === "coursework-notes");
  // Nothing running beside it: the named session itself.
  const alone = new Router().route(
    "tell the circuits coursework session I've signed in",
    { ...c, sessions: [done] },
    1000,
  );
  assert.ok(alone.kind === "topic" && alone.topic.sessionId === "dddddddd-4");
});
