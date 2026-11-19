import type { Config } from "../config.ts";
import { wav16kMono } from "./audio.ts";

/** Speech to text on one finished utterance (16 kHz mono s16le). */
export interface Stt {
  /** `vocab`: names likely to come up (projects, sessions) to bias recognition where supported. */
  transcribe(pcm16k: Buffer, vocab: string[]): Promise<string>;
}

/**
 * Names for Scribe's `keyterms` biasing. Its limits: at most 50 chars and 5 words a term, no `<>{}[]\`.
 * Keyterms add 20% to the price, and over 100 of them every request bills at least 20 s of audio,
 * which would multiply the cost of short utterances, so cap at 100.
 */
export function keyterms(vocab: string[], max = 100): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of vocab) {
    const t = raw
      .replace(/[<>{}[\]\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const key = t.toLowerCase();
    if (!t || t.length > 50 || t.split(" ").length > 5 || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === max) break;
  }
  return out;
}

/** ElevenLabs Scribe, batch. Raw PCM upload skips decoding on their side. */
export class ElevenStt implements Stt {
  private apiKey: string;
  private cfg: Config["stt"];
  constructor(apiKey: string, cfg: Config["stt"]) {
    this.apiKey = apiKey;
    this.cfg = cfg;
  }

  async transcribe(pcm16k: Buffer, vocab: string[]): Promise<string> {
    const form = new FormData();
    form.set("model_id", this.cfg.elevenModel);
    if (this.cfg.keyterms) for (const t of keyterms(vocab)) form.append("keyterms", t);
    form.set("file_format", "pcm_s16le_16");
    form.set("language_code", this.cfg.language);
    form.set("tag_audio_events", "false");
    form.set("file", new Blob([new Uint8Array(pcm16k)]), "utterance.pcm");
    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": this.apiKey },
      body: form,
    });
    if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { text?: string }).text?.trim() ?? "";
  }
}

/**
 * Local whisper.cpp server (`whisper-server`), e.g. on a GPU via
 * Vulkan. Free and private; `prompt` biases it toward project names.
 */
export class WhisperStt implements Stt {
  private cfg: Config["stt"];
  constructor(cfg: Config["stt"]) {
    this.cfg = cfg;
  }

  async transcribe(pcm16k: Buffer, vocab: string[]): Promise<string> {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(wav16kMono(pcm16k))], { type: "audio/wav" }), "utterance.wav");
    form.set("response_format", "json");
    form.set("temperature", "0");
    form.set("language", this.cfg.language);
    if (vocab.length) form.set("prompt", `Claude Code sessions: ${vocab.slice(0, 60).join(", ")}.`);
    const res = await fetch(`${this.cfg.whisperUrl}/inference`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`whisper ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { text?: string }).text?.trim() ?? "";
  }
}

/** Whisper's favourite hallucinations on near-silence. */
const JUNK = /^(\[.*\]|\(.*\)|thank you\.?|thanks for watching\.?|you\.?|bye\.?|\.+)$/i;

export function isJunk(text: string): boolean {
  const t = text.trim();
  return !t || JUNK.test(t);
}
