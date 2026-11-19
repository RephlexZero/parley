import { aborted, SentenceChunker, type Brain } from "../brain/brain.ts";
import { TOOL_FILLER, turnInput } from "../brain/context.ts";
import { Router, topicHeader, type Topic } from "../brain/router.ts";
import type { Hub } from "../hub/hub.ts";
import { label } from "../hub/sessions.ts";
import type { HubEvent, Session } from "../hub/types.ts";
import { Upsampler24to48, rms } from "./audio.ts";
import { isJunk, type Stt } from "./stt.ts";
import { speakable, type Tts } from "./tts.ts";
import { errorMessage } from "../errors.ts";

/** Where audio goes (48 kHz stereo s16le). The Discord player in production. */
export interface AudioOut {
  play(pcm: AsyncIterable<Buffer>): Promise<void>;
  stop(): void;
}

export interface TextOut {
  post(text: string): Promise<void>;
}

export interface ConversationOpts {
  audioTags: boolean;
  /** Utterances quieter than this RMS or shorter than minMs are dropped before STT (saves money). */
  minRms?: number;
  minMs?: number;
  /** TTS requests in flight at once (ElevenLabs: 2 on free, 3 Starter, 5 Creator). */
  ttsConcurrency?: number;
  log?: (msg: string) => void;
}

/**
 * One voice call: utterance in -> route to a topic -> brain -> speech out,
 * plus hub events (approvals, finished sessions) read out between turns.
 */
export class Conversation {
  readonly router = new Router();
  private active: AbortController | undefined;
  private busy = false;
  private pendingEvents: HubEvent[] = [];
  private log: (m: string) => void;
  private hub: Hub;
  private brain: Brain;
  private stt: Stt;
  private tts: Tts;
  private audio: AudioOut;
  private text: TextOut;
  private opts: ConversationOpts;
  private ttsSlots: Semaphore;
  /** Speaks into the reply that's playing now, if any (tool confirmations land mid-turn). */
  private speakNow: ((line: string) => void) | undefined;

  constructor(hub: Hub, brain: Brain, stt: Stt, tts: Tts, audio: AudioOut, text: TextOut, opts: ConversationOpts) {
    this.hub = hub;
    this.brain = brain;
    this.stt = stt;
    this.tts = tts;
    this.audio = audio;
    this.text = text;
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.ttsSlots = new Semaphore(opts.ttsConcurrency ?? 2);
  }

  /** The user started talking: stop whatever we were saying (barge-in). */
  bargeIn(): void {
    if (this.active) {
      this.active.abort();
      this.active = undefined;
      this.audio.stop();
    }
  }

  async onUtterance(pcm16k: Buffer): Promise<void> {
    const ms = pcm16k.length / 32;
    if (ms < (this.opts.minMs ?? 350) || rms(pcm16k) < (this.opts.minRms ?? 0.008)) return;

    const t0 = Date.now();
    const said = await this.stt
      .transcribe(pcm16k, await this.vocab())
      .catch((e: unknown) => (this.log(`stt: ${errorMessage(e)}`), ""));
    return this.onTranscript(said, `${String(Date.now() - t0)}ms`);
  }

  /** Names likely to come up, to bias recognition: projects and session names. */
  async vocab(): Promise<string[]> {
    const sessions = await this.hub.sessions();
    return [...new Set([...this.hub.projects.map((p) => p.name), ...sessions.map((s) => s.name).filter(Boolean)])];
  }

  /** What the user said, from either STT path. `timing` is only for the log. */
  async onTranscript(said: string, timing: string): Promise<void> {
    if (isJunk(said)) return;
    this.log(`heard (${timing}): ${said}`);
    this.hub.lastUtterance = said;
    const sessions = await this.hub.sessions();

    const route = this.router.route(said, {
      sessions,
      projects: this.hub.projects,
      pendingApprovals: this.hub.approvals.size,
    });
    if (route.kind === "approval") {
      // Deterministic fast path: no LLM between "yes" and the tool running.
      const a = this.hub.approvals.resolve(route.decision);
      void this.text.post(
        `🎙️ ${said}\n${route.decision === "allow" ? "✅" : "⛔"} ${a ? `${a.sessionLabel}: ${a.summary}` : "nothing pending"}`,
      );
      await this.say([a ? (route.decision === "allow" ? "Allowed." : "Denied.") : "Nothing's waiting for approval."]);
      return this.drainEvents();
    }
    void this.text.post(`🎙️ ${said}${route.switched ? `\n↪ ${route.topic.title} (${route.reason})` : ""}`);
    if (route.topic.sessionId) this.hub.noteReference(route.topic.sessionId);
    await this.respond(route.topic, turnInput(route.topic, said, sessions, this.hub));
    return this.drainEvents();
  }

  /** Run a brain turn and speak it as it streams. */
  async respond(topic: Topic, input: string): Promise<void> {
    this.bargeIn();
    const ac = new AbortController();
    this.active = ac;
    this.busy = true;
    const sentences = new AsyncQueue<string>();
    const chunker = new SentenceChunker((c) => {
      const t = speakable(c, this.opts.audioTags);
      if (t) sentences.push(t);
    });
    const t0 = Date.now();
    let first = true;
    let reply = "";
    const tools: string[] = [];
    const speaking = this.audio.play(this.synth(sentences, ac.signal));
    this.speakNow = (line) => {
      reply += (reply ? " " : "") + line;
      sentences.push(line);
    };
    try {
      let spoke = false;
      await this.brain.turn(
        topic,
        input,
        {
          text: (d) => {
            if (first) {
              this.log(`brain first token ${Date.now() - t0}ms`);
              first = false;
            }
            spoke = true;
            reply += d;
            chunker.push(d);
          },
          tool: (name) => {
            tools.push(name);
            const filler = TOOL_FILLER[name];
            if (!spoke && filler) sentences.push(filler);
            spoke = true;
          },
        },
        ac.signal,
      );
      chunker.flush();
    } catch (e) {
      this.log(`brain: ${errorMessage(e)}`);
      void this.text.post(`⚠️ brain: ${errorMessage(e)}`); // e.g. an expired Claude login
      sentences.push("Sorry, my brain fell over. The error's in the text channel.");
    } finally {
      this.speakNow = undefined;
      sentences.end();
      const said = reply.replace(/\s+/g, " ").trim();
      const via = tools.length ? ` [tools: ${tools.join(", ")}]` : "";
      this.log(
        `said (${String(Date.now() - t0)}ms${aborted(ac.signal) ? ", interrupted" : ""}): ${said || "(nothing)"}${via}`,
      );
      if (said) void this.text.post(`🔊 ${said}${aborted(ac.signal) ? " ✂️" : ""}`);
      if (claimsUnbackedAction(said, tools)) {
        this.log(`warning: reply claims an action but no acting tool ran`);
        void this.text.post("⚠️ That reply claimed an action, but no session was started or messaged. Ask again.");
      }
      await speaking.catch(() => {});
      if (this.active === ac) this.active = undefined;
      this.busy = false;
    }
  }

  /** Speak fixed lines without the brain (approvals, confirmations). */
  async say(lines: string[]): Promise<void> {
    this.log(`said: ${lines.join(" ")}`);
    this.bargeIn();
    const ac = new AbortController();
    this.active = ac;
    const q = new AsyncQueue<string>();
    for (const l of lines) q.push(l);
    q.end();
    await this.audio.play(this.synth(q, ac.signal)).catch(() => {});
    if (this.active === ac) this.active = undefined;
  }

  /**
   * Sentences -> audio, in order, with the next sentence's TTS request already
   * in flight while the current one plays.
   */
  private async *synth(sentences: AsyncIterable<string>, signal: AbortSignal): AsyncIterable<Buffer> {
    const up = new Upsampler24to48();
    const inflight: AsyncQueue<Buffer>[] = [];
    let previous = "";
    const state = { done: false }; // an object, so TS doesn't narrow it across the awaits below
    let wake = () => {};
    // Starts reading the TTS response at once, buffering what isn't played yet.
    const start = (text: string, prev: string) => {
      const q = new AsyncQueue<Buffer>();
      void (async () => {
        // Slots are taken in sentence order, so the next sentence still prefetches while one plays.
        await this.ttsSlots.acquire();
        try {
          if (!aborted(signal)) for await (const b of this.tts.stream(text, { previous: prev, signal })) q.push(b);
        } catch (e) {
          if (!aborted(signal)) this.log(`tts: ${errorMessage(e)}`);
        } finally {
          this.ttsSlots.release();
        }
        q.end();
      })();
      return q;
    };
    // Producer: start TTS for each sentence as soon as it exists.
    const producer = (async () => {
      for await (const s of sentences) {
        if (signal.aborted) break;
        inflight.push(start(s, previous));
        previous += " " + s;
        wake();
      }
      state.done = true;
      wake();
    })();
    for (let i = 0; ; i++) {
      while (i >= inflight.length && !state.done) await new Promise<void>((r) => (wake = r));
      const buffered = inflight[i];
      if (!buffered || aborted(signal)) break;
      for await (const b of buffered) {
        if (aborted(signal)) break;
        yield up.push(b);
      }
    }
    if (!aborted(signal)) yield up.flush();
    await producer;
  }

  // ---- hub events ------------------------------------------------------------

  onEvent(e: HubEvent): void {
    if (e.type === "acted") {
      if (this.speakNow) this.speakNow(e.say);
      else void this.say([e.say]);
      return;
    }
    if (e.type === "dispatched") {
      // "Tell that session..." next should mean this one, not an older namesake.
      this.router.focus(this.router.forSession(e.session));
      return;
    }
    this.pendingEvents.push(e);
    if (!this.busy && !this.active) void this.drainEvents();
  }

  private relevant(s: Session): boolean {
    return s.dispatched || this.router.current.sessionId === s.sessionId || this.router.current.projectPath === s.cwd;
  }

  private async drainEvents(): Promise<void> {
    while (!this.busy) {
      const e = this.pendingEvents.shift();
      if (!e) break;
      switch (e.type) {
        case "approval":
          void this.text.post(
            `🔐 **${e.approval.sessionLabel}** wants to ${e.approval.summary} (say yes/no, id \`${e.approval.id}\`)`,
          );
          await this.say([`${spokenLabel(e.approval.sessionLabel)} wants to ${e.approval.summary}. Allow?`]);
          break;
        case "approval_closed":
          if (e.decision === "timeout")
            void this.text.post(`⌛ approval \`${e.id}\` timed out; it's back on the normal prompt`);
          break;
        case "needs_input":
          if (this.relevant(e.session)) await this.say([`${spokenLabel(label(e.session))} needs your input.`]);
          break;
        case "session_reply":
          await this.say([`${spokenLabel(label(e.session))} says: ${speakable(e.text, false)}`]);
          break;
        case "dispatched":
        case "acted":
          break;
        case "turn_done": {
          if (!this.relevant(e.session)) break;
          const topic = this.router.forSession(e.session);
          this.router.focus(topic);
          await this.respond(
            topic,
            `${topicHeader(topic, e.session)}\n[event] This session just finished a turn. Its last message was:\n${e.lastMessage.slice(-2000)}\nTell the user the outcome in one or two sentences.`,
          );
          break;
        }
      }
    }
  }
}

const ACTING_TOOLS = new Set(["dispatch_task", "send_to_session", "answer_approval"]);
const CLAIM =
  /\b(i'?ve |i have |i )?(started|kicked off|dispatched|launched|spun up|sent (it|that|them|the message)|passed (it|that) on|told (it|them)|let (it|them) know)\b/i;

/** Small models sometimes say they did something without calling the tool. Catch it in code, not just the prompt. */
export function claimsUnbackedAction(reply: string, tools: string[]): boolean {
  return CLAIM.test(reply) && !tools.some((t) => ACTING_TOOLS.has(t.replace(/^mcp__parley__/, "")));
}

/** "parley: voice bridge setup" -> "parley". Session names are often long; the project is what you'd say. */
function spokenLabel(l: string): string {
  return (l.split(/[:(]/)[0] ?? l).trim();
}

/** Counting semaphore with FIFO hand-off. */
export class Semaphore {
  private free: number;
  private waiters: (() => void)[] = [];
  constructor(n: number) {
    this.free = Math.max(1, n);
  }

  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
}

/** Minimal single-consumer async queue. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: (() => void) | undefined;
  private closed = false;

  push(t: T) {
    this.items.push(t);
    this.waiting?.();
  }

  end() {
    this.closed = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift() as T; // length checked; T may itself include undefined
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => (this.waiting = r));
      this.waiting = undefined;
    }
  }
}
