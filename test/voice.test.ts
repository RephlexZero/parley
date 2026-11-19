import { test } from "node:test";
import assert from "node:assert/strict";
import { SentenceChunker } from "../src/brain/brain.ts";
import { trim } from "../src/brain/api.ts";
import { spawnSync } from "node:child_process";
import { Upsampler24to48, downsample48kStereoTo16kMono, rms, stretch } from "../src/voice/audio.ts";
import { isJunk, keyterms } from "../src/voice/stt.ts";
import { speakable, speedSplit, supportsAudioTags } from "../src/voice/tts.ts";

test("chunker releases an early clause, then whole sentences", () => {
  const out: string[] = [];
  const c = new SentenceChunker((s) => out.push(s));
  for (const tok of "Orbit's lidar session finished, and the capture works now. It found two bugs. ".split(/(?<= )/))
    c.push(tok);
  c.push("Want details?");
  c.flush();
  assert.deepEqual(out, [
    "Orbit's lidar session finished,",
    "and the capture works now.",
    "It found two bugs.",
    "Want details?",
  ]);
});

test("chunker doesn't split on version dots", () => {
  const out: string[] = [];
  const c = new SentenceChunker((s) => out.push(s));
  c.push("It's on Claude Code v2.1.325 now and running fine. Done.");
  c.flush();
  assert.equal(out[0], "It's on Claude Code v2.1.325 now and running fine.");
});

test("resampling keeps length ratios and survives odd chunk boundaries", () => {
  const stereo48 = Buffer.alloc(48000 * 4); // 1 s
  assert.equal(downsample48kStereoTo16kMono(stereo48).length, 16000 * 2);
  const up = new Upsampler24to48();
  const mono24 = Buffer.alloc(24000 * 2);
  for (let i = 0; i < 24000; i++) mono24.writeInt16LE(Math.round(Math.sin(i / 10) * 1000), i * 2);
  const a = up.push(mono24.subarray(0, 1001)); // odd byte split
  const b = up.push(mono24.subarray(1001));
  const c = up.flush();
  assert.equal(a.length + b.length + c.length, 48000 * 4);
  assert.ok(rms(Buffer.concat([a, b, c])) > 0.01);
});

test("upsampled 3 kHz tone matches the true 48 kHz tone closely", () => {
  const up = new Upsampler24to48();
  const f = 3000;
  const in24 = Buffer.alloc(2400 * 2);
  for (let i = 0; i < 2400; i++) in24.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * f * i) / 24000)), i * 2);
  const out = Buffer.concat([up.push(in24), up.flush()]);
  let err = 0;
  let n = 0;
  // Skip the edges, where the filter sees the zero padding.
  for (let j = 200; j < 4600; j++) {
    const want = 10000 * Math.sin((2 * Math.PI * f * j) / 48000);
    err += (out.readInt16LE(j * 4) - want) ** 2;
    n++;
  }
  assert.ok(Math.sqrt(err / n) < 100, `rms error ${Math.sqrt(err / n).toFixed(1)}`);
});

test("STT junk and markdown are filtered before speech", () => {
  assert.ok(isJunk("Thank you."));
  assert.ok(isJunk("[BLANK_AUDIO]"));
  assert.ok(!isJunk("yes"));
  assert.equal(speakable("**Done.** See `src/x.ts` [laughs]", false), "Done. See src/x.ts");
  assert.equal(speakable("Done [laughs]", true), "Done [laughs]");
});

test("history trim cuts only at real user turns", () => {
  const m = [
    { role: "user" as const, content: "one" },
    { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t", name: "x", input: {} }] },
    { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t", content: "r" }] },
    { role: "assistant" as const, content: "ok" },
    { role: "user" as const, content: "two" },
    { role: "assistant" as const, content: "ok2" },
  ];
  assert.deepEqual(trim(m, 1), m.slice(4));
  assert.equal(trim(m, 5).length, 6);
});

test("Scribe keyterms respect its limits and stay under the 20 s billing floor", () => {
  const many = Array.from({ length: 150 }, (_, i) => `project ${i}`);
  assert.equal(keyterms(many).length, 100);
  assert.deepEqual(keyterms(["orbit", "Orbit", "[x] tidepool", "a b c d e f", "x".repeat(51), "  "]), [
    "orbit",
    "x tidepool",
  ]);
  assert.ok(supportsAudioTags("eleven_v4_turbo"));
  assert.ok(!supportsAudioTags("eleven_flash_v2_5"));
});

test("stacks name their local services", async () => {
  const { STACKS, isStack, localServices } = await import("../src/stacks.ts");
  assert.ok(isStack("local") && !isStack("toString"));
  assert.deepEqual(localServices(STACKS.local), ["whisper", "kokoro"]);
  assert.deepEqual(localServices(STACKS.hybrid), ["whisper"]);
  assert.deepEqual(localServices(STACKS.eleven), []);
});

test("TTS semaphore never exceeds its limit and hands off in order", async () => {
  const { Semaphore } = await import("../src/voice/conversation.ts");
  const sem = new Semaphore(2);
  let running = 0;
  let peak = 0;
  const order: number[] = [];
  await Promise.all(
    [0, 1, 2, 3, 4].map(async (i) => {
      await sem.acquire();
      order.push(i);
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      sem.release();
    }),
  );
  assert.equal(peak, 2);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test(
  "stretch speeds speech up without changing pitch",
  { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 },
  async () => {
    const f = 440;
    const in24 = Buffer.alloc(24000 * 2); // 1 s
    for (let i = 0; i < 24000; i++)
      in24.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * f * i) / 24000)), i * 2);
    async function* chunks() {
      for (let o = 0; o < in24.length; o += 4801) {
        await new Promise((r) => setImmediate(r)); // arrive in pieces, like a network stream
        yield in24.subarray(o, o + 4801); // odd split
      }
    }
    const parts: Buffer[] = [];
    for await (const b of stretch(chunks(), 1.25, new AbortController().signal)) parts.push(b);
    const out = Buffer.concat(parts);
    const secs = out.length / 2 / 24000;
    assert.ok(Math.abs(secs - 0.8) < 0.03, `length ${secs.toFixed(3)} s`);
    // Pitch: count zero crossings in the middle.
    let crossings = 0;
    const from = 2400;
    const to = out.length / 2 - 2400;
    for (let i = from + 1; i < to; i++)
      if (out.readInt16LE((i - 1) * 2) < 0 !== out.readInt16LE(i * 2) < 0) crossings++;
    const hz = crossings / 2 / ((to - from) / 24000);
    assert.ok(Math.abs(hz - f) < 10, `pitch ${hz.toFixed(1)} Hz`);
  },
);

test("speed splits between ElevenLabs and the stretch; v4 gets none natively", () => {
  assert.deepEqual(speedSplit("eleven_v4_turbo", 1.4), { native: 1, stretch: 1.4 });
  const flash = speedSplit("eleven_flash_v2_5", 1.4);
  assert.equal(flash.native, 1.2);
  assert.ok(Math.abs(flash.stretch * flash.native - 1.4) < 1e-9);
  assert.deepEqual(speedSplit("eleven_flash_v2_5", 1.1), { native: 1.1, stretch: 1 });
});

test("a reply claiming an action without an acting tool is flagged", async () => {
  const { claimsUnbackedAction } = await import("../src/voice/conversation.ts");
  assert.ok(claimsUnbackedAction("Kicked off a session for the RTL work.", []));
  assert.ok(!claimsUnbackedAction("Kicked off a session for the RTL work.", ["mcp__parley__dispatch_task"]));
  assert.ok(!claimsUnbackedAction("It finished; two tests fail.", ["list_sessions"]));
});

test("realtime keyterms fit Scribe realtime's limits", async () => {
  const { liveKeyterms } = await import("../src/voice/live-stt.ts");
  const many = Array.from({ length: 80 }, (_, i) => `proj ${String(i)}`);
  assert.equal(liveKeyterms(many).length, 50);
  assert.deepEqual(liveKeyterms(["orbit", "Orbit", "Circuits coursework report write-up", "EE10101 RTL", "a{b}"]), [
    "orbit",
    "EE10101 RTL",
    "a b",
  ]);
});
