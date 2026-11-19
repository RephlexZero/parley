import { homedir } from "node:os";
import { join } from "node:path";
import { STACKS, isStack, type SttKind, type TtsKind } from "./stacks.ts";

const env = process.env;
const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);
const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

function projectAliases(v: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of (v ?? "").split(";")) {
    const [name, said] = entry.split("=");
    if (name?.trim() && said)
      out[name.trim()] = said
        .split("|")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
  }
  return out;
}

export type BrainKind = "cli" | "api";

const stackName = env.STACK ?? "eleven";
if (!isStack(stackName)) throw new Error(`STACK=${stackName}: expected one of ${Object.keys(STACKS).join(", ")}`);
const stack = STACKS[stackName];

export const config = {
  claudeDir: expand(env.CLAUDE_DIR ?? "~/.claude"),
  stateDir: expand(env.PARLEY_STATE_DIR ?? join(import.meta.dirname, "..", "state")),

  hub: {
    port: num(env.PARLEY_PORT, 7420),
    token: env.PARLEY_TOKEN ?? "",
    /** Seconds a PermissionRequest hook waits for a spoken answer before falling back to the normal prompt. */
    approvalTimeoutS: num(env.APPROVAL_TIMEOUT_S, 45),
  },

  discord: {
    token: env.DISCORD_TOKEN ?? "",
    /** Only these users are listened to. Everyone else in the channel is ignored. */
    ownerIds: list(env.DISCORD_OWNER_IDS),
    guildId: env.DISCORD_GUILD_ID ?? "",
    /** The bot joins when an owner enters this channel and leaves when they all leave. */
    voiceChannelId: env.DISCORD_VOICE_CHANNEL_ID ?? "",
    /** Optional: transcripts, long answers and approval buttons go here. */
    textChannelId: env.DISCORD_TEXT_CHANNEL_ID ?? "",
    /** Silence (ms) that ends an utterance. Lower = snappier, higher = fewer cut-offs. */
    endSilenceMs: num(env.END_SILENCE_MS, 700),
  },

  brain: {
    kind: (env.BRAIN ?? "cli") as BrainKind,
    /** What to call the user in the brain's prompt; empty for "the user". */
    owner: env.OWNER_NAME ?? "",
    /** cli: a Claude Code model alias (haiku/sonnet/opus). api: a model id. */
    model: env.BRAIN === "api" ? apiModel(env.BRAIN_MODEL ?? "haiku") : (env.BRAIN_MODEL ?? "haiku"),
    effort: (env.BRAIN_EFFORT ?? "low") as "low" | "medium" | "high",
    /** Turns of history kept per topic (api backend) before older ones are dropped. */
    historyTurns: num(env.BRAIN_HISTORY_TURNS, 12),
    /** cli backend: warm `claude -p` processes kept alive (one per active topic + one spare). */
    poolSize: num(env.BRAIN_POOL, 3),
  },

  /** Speech stack preset; STT / TTS below override its parts. */
  stack: stackName,

  stt: {
    kind: (env.STT ?? stack.stt) as SttKind,
    elevenModel: env.ELEVEN_STT_MODEL ?? "scribe_v3",
    /** Bias Scribe toward project and session names (+20% STT price). */
    keyterms: env.STT_KEYTERMS !== "0",
    /** Stream to Scribe realtime with turn prediction instead of uploading each utterance (ElevenLabs only). */
    live: env.STT_LIVE !== "0",
    liveModel: env.ELEVEN_STT_LIVE_MODEL ?? "scribe_v3_live",
    /** Silence fallback (s) for ending a turn when turn prediction isn't sure. 0.192 to 3. */
    liveSilenceS: num(env.STT_LIVE_SILENCE_S, 0.7),
    whisperUrl: env.WHISPER_URL ?? "http://127.0.0.1:8178",
    language: env.STT_LANGUAGE ?? "en",
  },

  tts: {
    kind: (env.TTS ?? stack.tts) as TtsKind,
    /** Used by STT too when either side is ElevenLabs. */
    apiKey: env.ELEVENLABS_API_KEY ?? "",
    voiceId: env.ELEVEN_VOICE_ID ?? "",
    model: env.ELEVEN_TTS_MODEL ?? "eleven_v4_turbo",
    /** Speaking rate. ElevenLabs does 0.7 to 1.2 itself (v4: none), the rest is an ffmpeg stretch; Kokoro 0.5 to 2. */
    speed: num(env.TTS_SPEED, 1.4),
    /** Parallel TTS requests; ElevenLabs allows 2 on free, 3 Starter, 5 Creator. */
    concurrency: num(env.TTS_CONCURRENCY, 2),
    kokoroUrl: env.KOKORO_URL ?? "http://127.0.0.1:8880",
    kokoroVoice: env.KOKORO_VOICE ?? "bm_george",
  },

  dispatch: {
    model: env.DISPATCH_MODEL ?? "opus",
    permissionMode: env.DISPATCH_PERMISSION_MODE ?? "auto",
  },

  projects: {
    roots: list(env.PROJECT_ROOTS ?? "~/code").map(expand),
    /** Path fragments that mark a project as work (kept apart from personal topics). */
    workMarkers: list(env.WORK_MARKERS ?? "/work/"),
    uniMarkers: list(env.UNI_MARKERS ?? "/uni/"),
    /** Extra spoken names: "coursework-notes=final year project|fyp;robot-arm=arm". */
    aliases: projectAliases(env.PROJECT_ALIASES),
  },
};

export type Config = typeof config;

/** The api backend needs a model id; accept the same aliases as the cli backend. */
function apiModel(m: string): string {
  const alias: Record<string, string> = {
    haiku: "claude-haiku-5-5",
    sonnet: "claude-sonnet-5-5",
    opus: "claude-opus-5-5",
  };
  return alias[m] ?? m;
}
