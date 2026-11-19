import { spawnSync } from "node:child_process";
import { ApiBrain } from "./brain/api.ts";
import type { Brain } from "./brain/brain.ts";
import { CliBrain } from "./brain/cli.ts";
import { runTool, type ToolContext } from "./brain/tools.ts";
import { config } from "./config.ts";
import { Hub } from "./hub/hub.ts";
import { startServer } from "./hub/server.ts";
import { DiscordVoice } from "./voice/bot.ts";
import { Conversation } from "./voice/conversation.ts";
import { ElevenLiveStt } from "./voice/live-stt.ts";
import { ElevenStt, WhisperStt } from "./voice/stt.ts";
import { ElevenTts, KokoroTts, needsStretch, supportsAudioTags } from "./voice/tts.ts";

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

function need(name: string, v: string) {
  if (!v) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

need("PARLEY_TOKEN (run `npm run hooks` to make one)", config.hub.token);
const token = config.hub.token;

need("DISCORD_TOKEN", config.discord.token);
need("DISCORD_VOICE_CHANNEL_ID", config.discord.voiceChannelId);
need("DISCORD_OWNER_IDS", config.discord.ownerIds.join(","));
if (config.stt.kind === "elevenlabs" || config.tts.kind === "elevenlabs") need("ELEVENLABS_API_KEY", config.tts.apiKey);
if (config.tts.kind === "elevenlabs") need("ELEVEN_VOICE_ID", config.tts.voiceId);
if (needsStretch(config.tts) && spawnSync("ffmpeg", ["-version"]).status !== 0) {
  console.error(`TTS_SPEED=${String(config.tts.speed)} with ${config.tts.model} needs ffmpeg on PATH.`);
  process.exit(1);
}

const hub = new Hub(config);
setInterval(() => hub.rescanProjects(), 10 * 60_000).unref();
hub.startWatching();
log(`hub: ${hub.projects.length} projects under ${config.projects.roots.join(", ")}`);

const ctx: ToolContext = { hub, post: (t) => voice.post(t), log };
const audioTags = config.tts.kind === "elevenlabs" && supportsAudioTags(config.tts.model);

const brain: Brain =
  config.brain.kind === "api"
    ? new ApiBrain(config.brain, ctx, audioTags)
    : new CliBrain(config.brain, { port: config.hub.port, token }, config.stateDir, audioTags, hub.projects);
log(`brain: ${config.brain.kind} (${config.brain.model}, effort ${config.brain.effort})`);

await startServer(hub, config.hub.port, token, (name, input) => runTool(name, input, ctx));
log(`hub: listening on 127.0.0.1:${config.hub.port}`);

const stt = config.stt.kind === "whisper" ? new WhisperStt(config.stt) : new ElevenStt(config.tts.apiKey, config.stt);
const tts = config.tts.kind === "kokoro" ? new KokoroTts(config.tts) : new ElevenTts(config.tts);
log(`speech: stack ${config.stack}, STT ${config.stt.kind}, TTS ${config.tts.kind}`);

const voice: DiscordVoice = new DiscordVoice(
  config.discord,
  hub,
  (): Conversation => {
    const conv = new Conversation(hub, brain, stt, tts, voice, voice, {
      audioTags,
      log,
      ttsConcurrency: config.tts.concurrency,
    });
    void brain.warm(conv.router.current);
    return conv;
  },
  log,
  config.stt.kind === "elevenlabs" && config.stt.live
    ? () => new ElevenLiveStt(config.tts.apiKey, config.stt, log)
    : undefined,
);
await voice.start();

const shutdown = () => {
  brain.close();
  void voice.client.destroy();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
