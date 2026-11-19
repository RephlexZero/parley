/** Speech stacks: which STT and TTS backends run together. `npm run stack` switches between them. */

export type SttKind = "elevenlabs" | "whisper";
export type TtsKind = "elevenlabs" | "kokoro";

export interface Stack {
  stt: SttKind;
  tts: TtsKind;
  about: string;
}

export const STACKS = {
  eleven: {
    stt: "elevenlabs",
    tts: "elevenlabs",
    about: "ElevenLabs Scribe v3 + v4 Turbo: most accurate, best voice; about $22/month at daily use",
  },
  local: {
    stt: "whisper",
    tts: "kokoro",
    about: "whisper.cpp on the GPU + Kokoro on the CPU, in Docker: free, a bit worse on names, plainer voice",
  },
  hybrid: {
    stt: "whisper",
    tts: "elevenlabs",
    about: "free local whisper.cpp for listening, ElevenLabs voice for speaking",
  },
} as const satisfies Record<string, Stack>;

export type StackName = keyof typeof STACKS;

export const isStack = (s: string): s is StackName => Object.hasOwn(STACKS, s);

/** Docker services a stack needs from deploy/local/compose.yml. */
export function localServices(s: Stack): string[] {
  return [...(s.stt === "whisper" ? ["whisper"] : []), ...(s.tts === "kokoro" ? ["kokoro"] : [])];
}
