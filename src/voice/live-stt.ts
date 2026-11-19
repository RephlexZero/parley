import type { Config } from "../config.ts";
import { errorMessage } from "../errors.ts";

/**
 * ElevenLabs Scribe realtime over one WebSocket per call. Turn prediction
 * decides when the user has finished (with a silence fallback), so there's no
 * fixed end-of-speech wait and no upload after it.
 *
 * Discord sends nothing while nobody talks, and the server's turn detection
 * only runs on audio it receives, so silence is sent as zeros for a few
 * seconds after speech. Outside that, a tiny zero chunk every few seconds
 * keeps the socket open (the server drops it after 15 s without messages)
 * while billing almost no audio.
 */
export class ElevenLiveStt {
  /** A finished turn. `afterMs`: from the last voice packet to the transcript. */
  onCommitted: (text: string, afterMs: number) => void = () => {};

  private ws: WebSocket | undefined;
  private queue: Buffer[] = [];
  private lastVoiceAt = 0;
  private lastSentAt = 0;
  private speaking = false;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;
  private vocab: string[] = [];
  private apiKey: string;
  private cfg: Config["stt"];
  private log: (m: string) => void;

  constructor(apiKey: string, cfg: Config["stt"], log: (m: string) => void) {
    this.apiKey = apiKey;
    this.cfg = cfg;
    this.log = log;
  }

  /** Connect; resolves once the session has started, rejects if it can't. */
  async start(vocab: string[]): Promise<void> {
    this.vocab = vocab;
    this.closed = false;
    await this.connect();
    this.timer = setInterval(() => {
      this.tick();
    }, TICK_MS);
  }

  /** the user's voice, 16 kHz mono s16le, as it arrives. */
  push(pcm16k: Buffer): void {
    this.queue.push(pcm16k);
    this.lastVoiceAt = Date.now();
    this.speaking = true;
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.ws?.close();
    this.ws = undefined;
  }

  private async connect(): Promise<void> {
    // Node's WebSocket can't set headers portably, so authenticate with a single-use token.
    const res = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
      method: "POST",
      headers: { "xi-api-key": this.apiKey },
    });
    if (!res.ok) throw new Error(`ElevenLabs realtime token ${String(res.status)}: ${await res.text()}`);
    const { token } = (await res.json()) as { token: string };
    const q = new URLSearchParams({
      model_id: this.cfg.liveModel,
      audio_format: "pcm_16000",
      language_code: this.cfg.language,
      commit_strategy: this.cfg.liveModel.includes("v3") ? "turn_prediction" : "vad",
      vad_silence_threshold_secs: String(this.cfg.liveSilenceS),
      token,
    });
    if (this.cfg.keyterms) for (const t of liveKeyterms(this.vocab)) q.append("keyterms", t);
    const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${q.toString()}`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const failed = (why: string) => {
        reject(new Error(why));
      };
      ws.addEventListener("message", (ev) => {
        const data: unknown = ev.data;
        if (typeof data !== "string") return;
        const m = JSON.parse(data) as { message_type: string; text?: string; error?: string };
        if (m.message_type === "session_started") resolve();
        else if (m.message_type === "committed_transcript") {
          this.speaking = false;
          const text = m.text?.trim() ?? "";
          if (text) this.onCommitted(text, Date.now() - this.lastVoiceAt);
        } else if (m.error) {
          this.log(`stt live: ${m.message_type}: ${m.error}`);
          failed(m.error);
        }
      });
      ws.addEventListener("error", () => {
        failed("websocket error");
      });
      ws.addEventListener("close", (ev) => {
        failed(`closed ${String(ev.code)}`);
        if (this.ws === ws) this.ws = undefined;
        if (!this.closed) this.reconnect();
      });
    });
  }

  private reconnect(): void {
    setTimeout(() => {
      if (this.closed || this.ws) return;
      this.connect().catch((e: unknown) => {
        this.log(`stt live: reconnect failed: ${errorMessage(e)}`);
        this.reconnect();
      });
    }, 1000);
  }

  private tick(): void {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    let audio: Buffer | undefined;
    if (this.queue.length) {
      audio = Buffer.concat(this.queue);
      this.queue = [];
    } else if (this.speaking && now - this.lastVoiceAt < TRAIL_MS) {
      audio = Buffer.alloc(16 * TICK_MS * 2); // silence, so turn detection sees the pause
    } else if (now - this.lastSentAt > KEEPALIVE_MS) {
      audio = Buffer.alloc(16 * 20 * 2); // 20 ms
    }
    if (!audio) return;
    if (now - this.lastVoiceAt >= TRAIL_MS) this.speaking = false;
    ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: audio.toString("base64"),
        commit: false,
        sample_rate: 16000,
      }),
    );
    this.lastSentAt = now;
  }
}

const TICK_MS = 100;
/** Keep sending silence this long after the last voice packet (covers the silence fallback). */
const TRAIL_MS = 4000;
const KEEPALIVE_MS = 5000;

/** Realtime keyterms: at most 50, 20 characters each. */
export function liveKeyterms(vocab: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of vocab) {
    const t = raw
      .replace(/[^\p{L}\p{N} '-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!t || t.length > 20 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === 50) break;
  }
  return out;
}
