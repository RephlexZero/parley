import type { Config } from "../config.ts";
import { stretch } from "./audio.ts";

/**
 * How a speaking rate splits between ElevenLabs and the ffmpeg stretch.
 * ElevenLabs does 0.7 to 1.2 itself, except Eleven v4, which ignores
 * `speed` entirely (measured: identical length at 1.0 and 1.2).
 */
export function speedSplit(model: string, speed: number): { native: number; stretch: number } {
  const native = model.includes("_v4") ? 1 : Math.min(1.2, Math.max(0.7, speed));
  return { native, stretch: speed / native };
}

/** True when the stretch stage (and so ffmpeg) is needed. */
export const needsStretch = (cfg: Config["tts"]) =>
  cfg.kind === "elevenlabs" && Math.abs(speedSplit(cfg.model, cfg.speed).stretch - 1) > 0.01;

/** Text to 24 kHz mono s16le, streamed. */
export interface Tts {
  stream(text: string, ctx: { previous?: string; signal: AbortSignal }): AsyncIterable<Buffer>;
}

export class ElevenTts implements Tts {
  private cfg: Config["tts"];
  constructor(cfg: Config["tts"]) {
    this.cfg = cfg;
  }

  async *stream(text: string, ctx: { previous?: string; signal: AbortSignal }): AsyncIterable<Buffer> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.cfg.voiceId}/stream?output_format=pcm_24000`;
    const request = () =>
      fetch(url, {
        method: "POST",
        signal: ctx.signal,
        headers: { "xi-api-key": this.cfg.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: this.cfg.model,
          voice_settings: { speed: speedSplit(this.cfg.model, this.cfg.speed).native },
          // Continuity across sentence-sized requests, so intonation doesn't reset each time.
          ...(ctx.previous ? { previous_text: ctx.previous.slice(-300) } : {}),
        }),
      });
    let res = await request();
    // 429: over the plan's concurrent-request limit for a moment; one quick retry usually clears it.
    if (res.status === 429) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 400));
      res = await request();
    }
    if (!res.ok || !res.body) throw new Error(`ElevenLabs TTS ${res.status}: ${await res.text()}`);
    const pcm = (async function* (body: ReadableStream<Uint8Array>) {
      for await (const chunk of body) yield Buffer.from(chunk);
    })(res.body);
    if (needsStretch(this.cfg)) yield* stretch(pcm, speedSplit(this.cfg.model, this.cfg.speed).stretch, ctx.signal);
    else yield* pcm;
  }
}

/** Kokoro-82M through Kokoro-FastAPI (deploy/local), streaming 24 kHz PCM. */
export class KokoroTts implements Tts {
  private cfg: Config["tts"];
  constructor(cfg: Config["tts"]) {
    this.cfg = cfg;
  }

  async *stream(text: string, ctx: { signal: AbortSignal }): AsyncIterable<Buffer> {
    const res = await fetch(`${this.cfg.kokoroUrl}/v1/audio/speech`, {
      method: "POST",
      signal: ctx.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kokoro",
        input: text,
        voice: this.cfg.kokoroVoice,
        response_format: "pcm",
        stream: true,
        speed: this.cfg.speed,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Kokoro TTS ${res.status}: ${await res.text()}`);
    for await (const chunk of res.body) yield Buffer.from(chunk);
  }
}

/** Eleven v3 and v4 read tags like [laughs]; flash and multilingual models would speak them. */
export const supportsAudioTags = (model: string) => /_v[34]/.test(model);

/** Strip anything TTS shouldn't read: markdown, tags the model can't do. */
export function speakable(text: string, audioTags: boolean): string {
  let t = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  if (!audioTags) t = t.replace(/\[[a-z ]{2,20}\]/gi, "");
  return t.replace(/\s+/g, " ").trim();
}
