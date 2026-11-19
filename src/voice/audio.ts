/**
 * PCM helpers. Discord gives and takes 48 kHz stereo s16le. STT wants 16 kHz
 * mono; ElevenLabs TTS gives 24 kHz mono.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";

/** 48 kHz stereo -> 16 kHz mono: average channels, 3-tap box filter, keep every third sample. */
export function downsample48kStereoTo16kMono(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4);
  const outLen = Math.floor(frames / 3);
  const out = Buffer.alloc(outLen * 2);
  for (let o = 0; o < outLen; o++) {
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      const f = (o * 3 + k) * 4;
      sum += pcm.readInt16LE(f) + pcm.readInt16LE(f + 2);
    }
    out.writeInt16LE(clamp(Math.round(sum / 6)), o * 2);
  }
  return out;
}

/** Half the taps of the windowed-sinc half-band filter (32 taps in all; ~0.7 ms of lookahead at 24 kHz). */
const TAPS = 16;
const HALF_BAND = (() => {
  const c: number[] = [];
  for (let k = 0; k < TAPS; k++) {
    const t = k + 0.5;
    const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
    const blackman = 0.42 + 0.5 * Math.cos((Math.PI * t) / TAPS) + 0.08 * Math.cos((2 * Math.PI * t) / TAPS);
    c.push(sinc * blackman);
  }
  const sum = 2 * c.reduce((a, b) => a + b, 0);
  return c.map((v) => v / sum);
})();

/**
 * Streaming 24 kHz mono -> 48 kHz stereo s16le. The new in-between samples come from a windowed-sinc
 * filter rather than a straight line, so the voice stays clean instead of dull and gritty. Output lags
 * input by TAPS samples; `flush()` releases the tail at the end of a stream.
 */
export class Upsampler24to48 {
  private hist: number[] = new Array<number>(TAPS).fill(0);
  private carry: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer {
    const buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const n = Math.floor(buf.length / 2);
    this.carry = buf.subarray(n * 2);
    for (let i = 0; i < n; i++) this.hist.push(buf.readInt16LE(i * 2));
    return this.drain();
  }

  flush(): Buffer {
    for (let i = 0; i < TAPS; i++) this.hist.push(0);
    const out = this.drain();
    this.hist = new Array<number>(TAPS).fill(0);
    this.carry = Buffer.alloc(0);
    return out;
  }

  private drain(): Buffer {
    const h = this.hist;
    const count = Math.max(0, h.length - 2 * TAPS);
    const out = Buffer.alloc(count * 8);
    for (let j = 0; j < count; j++) {
      const n = j + TAPS;
      let odd = 0;
      for (let k = 0; k < TAPS; k++) odd += (HALF_BAND[k] ?? 0) * ((h[n - k] ?? 0) + (h[n + 1 + k] ?? 0));
      const even = h[n] ?? 0;
      const o = clamp16(Math.round(odd));
      out.writeInt16LE(even, j * 8);
      out.writeInt16LE(even, j * 8 + 2);
      out.writeInt16LE(o, j * 8 + 4);
      out.writeInt16LE(o, j * 8 + 6);
    }
    this.hist = h.slice(count);
    return out;
  }
}

const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, v));

/** RMS level 0..1 of 16-bit PCM. Used to drop coughs and keyboard clicks. */
export function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    acc += s * s;
  }
  return Math.sqrt(acc / n);
}

/** Wrap 16 kHz mono s16le in a WAV header (whisper.cpp wants a file). */
export function wav16kMono(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const clamp = (v: number) => Math.max(-32768, Math.min(32767, v));

/**
 * Speed up 24 kHz mono s16le without changing pitch (ffmpeg's atempo, WSOLA), streaming.
 * ElevenLabs caps its own speed at 1.2; this covers the rest.
 */
export async function* stretch(src: AsyncIterable<Buffer>, factor: number, signal: AbortSignal): AsyncIterable<Buffer> {
  const pcm = ["-f", "s16le", "-ar", "24000", "-ac", "1"];
  const ff = spawn("ffmpeg", [
    "-loglevel",
    "error",
    ...pcm,
    "-i",
    "pipe:0",
    "-af",
    `atempo=${String(factor)}`,
    ...pcm,
    "-flush_packets",
    "1",
    "pipe:1",
  ]);
  let stderr = "";
  ff.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  ff.stdin.on("error", () => {}); // EPIPE after a kill
  const exited = new Promise<number | null>((resolve, reject) => {
    ff.on("error", reject); // ffmpeg not installed
    ff.on("close", resolve);
  });
  const kill = () => ff.kill("SIGKILL");
  signal.addEventListener("abort", kill, { once: true });
  const feed = (async () => {
    try {
      for await (const b of src) if (!ff.stdin.write(b)) await once(ff.stdin, "drain", { signal });
    } finally {
      ff.stdin.end();
    }
  })();
  feed.catch(() => {}); // surfaced below unless we stopped early
  try {
    for await (const b of ff.stdout) yield b as Buffer;
    await feed;
    const code = await exited;
    if (code !== 0 && !signal.aborted) throw new Error(`ffmpeg exited ${String(code)}: ${stderr.trim()}`);
  } finally {
    signal.removeEventListener("abort", kill);
    if (ff.exitCode === null) kill();
  }
}
