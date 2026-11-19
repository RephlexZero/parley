import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import { Client, GatewayIntentBits, type TextBasedChannel, type VoiceBasedChannel } from "discord.js";
import prism from "prism-media";
import type { Config } from "../config.ts";
import type { Hub } from "../hub/hub.ts";
import { label } from "../hub/sessions.ts";
import type { HubEvent } from "../hub/types.ts";
import { downsample48kStereoTo16kMono } from "./audio.ts";
import type { AudioOut, Conversation, TextOut } from "./conversation.ts";
import type { ElevenLiveStt } from "./live-stt.ts";
import { errorMessage } from "../errors.ts";

/** ms of speech before we treat it as the user talking over the bot (not a cough). */
const BARGE_IN_MS = 300;

export class DiscordVoice implements AudioOut, TextOut {
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  private connection: VoiceConnection | undefined;
  private player: AudioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  private conv: Conversation | undefined;
  private cfg: Config["discord"];
  private hub: Hub;
  private newConversation: () => Conversation;
  private log: (m: string) => void;
  /** Streaming STT for this call, when configured and connected; otherwise utterances are uploaded whole. */
  private live: ElevenLiveStt | undefined;
  private newLive: (() => ElevenLiveStt) | undefined;

  constructor(
    cfg: Config["discord"],
    hub: Hub,
    newConversation: () => Conversation,
    log: (m: string) => void,
    newLive?: () => ElevenLiveStt,
  ) {
    this.log = log;
    this.cfg = cfg;
    this.hub = hub;
    this.newConversation = newConversation;
    this.newLive = newLive;
    this.player.on("error", (e) => this.log(`player: ${e.message}`));
    hub.on("event", (e) => this.onHubEvent(e));
  }

  async start(): Promise<void> {
    this.client.on("voiceStateUpdate", () => void this.sync());
    this.client.once("clientReady", () => {
      this.log(`discord: logged in as ${this.client.user?.tag}`);
      void this.sync();
    });
    await this.client.login(this.cfg.token);
  }

  /** Join when an owner is in the voice channel; leave when none are. */
  private async sync(): Promise<void> {
    const channel = (await this.client.channels
      .fetch(this.cfg.voiceChannelId)
      .catch(() => null)) as VoiceBasedChannel | null;
    if (!channel?.isVoiceBased()) {
      this.log("discord: DISCORD_VOICE_CHANNEL_ID is not a voice channel");
      return;
    }
    const ownerPresent = channel.members.some((m) => this.cfg.ownerIds.includes(m.id));
    if (ownerPresent && !this.connection) await this.join(channel);
    else if (!ownerPresent && this.connection) this.leave();
  }

  private async join(channel: VoiceBasedChannel): Promise<void> {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption: true,
    });
    this.connection = connection;
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (e) {
      this.log(`discord: couldn't connect to voice: ${errorMessage(e)}`);
      this.leave();
      return;
    }
    connection.subscribe(this.player);
    const conv = this.newConversation();
    this.conv = conv;
    this.hub.callActive = true;
    if (this.newLive) {
      const live = this.newLive();
      try {
        await live.start(await conv.vocab());
        live.onCommitted = (text, afterMs) => {
          void conv
            .onTranscript(text, `live, ${String(afterMs)}ms after you stopped`)
            .catch((e: unknown) => this.log(`turn: ${errorMessage(e)}`));
        };
        this.live = live;
      } catch (e) {
        live.close();
        this.log(`stt live: couldn't start, uploading utterances instead: ${errorMessage(e)}`);
      }
    }
    this.log(`call: joined (${this.live ? "streaming STT" : "batch STT"})`);

    connection.receiver.speaking.on("start", (userId) => {
      if (!this.cfg.ownerIds.includes(userId)) return;
      if (this.live) this.stream(connection, userId);
      else this.capture(connection, userId);
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // Signalling/Connecting within 5 s means it's reconnecting by itself; otherwise give up.
      Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => {
        this.leave();
      });
    });
    await this.conv.say(["Hey."]);
  }

  private leave(): void {
    this.connection?.destroy();
    this.connection = undefined;
    this.live?.close();
    this.live = undefined;
    this.conv?.bargeIn();
    this.conv = undefined;
    this.hub.callActive = false;
    this.hub.approvals.clear(); // hooks fall back to the normal prompt
    this.log("call: left");
  }

  /** Feed an owner's audio to the streaming STT for the rest of the call. */
  private stream(connection: VoiceConnection, userId: string): void {
    if (connection.receiver.subscriptions.has(userId)) return;
    const opus = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    let voiceMs = 0;
    let lastAt = 0;
    opus.pipe(decoder);
    decoder.on("data", (d: Buffer) => {
      const now = Date.now();
      if (now - lastAt > 400) voiceMs = 0; // a new stretch of speech
      lastAt = now;
      const before = voiceMs;
      voiceMs += d.length / 192; // 48 kHz * 2 ch * 2 bytes = 192 bytes/ms
      if (before < BARGE_IN_MS && voiceMs >= BARGE_IN_MS) this.conv?.bargeIn();
      this.live?.push(downsample48kStereoTo16kMono(d));
    });
    decoder.on("error", (e) => this.log(`opus: ${e.message}`));
  }

  /** Record one utterance from an owner, ended by silence. */
  private capture(connection: VoiceConnection, userId: string): void {
    if (connection.receiver.subscriptions.has(userId)) return;
    const opus = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.cfg.endSilenceMs },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let barged = false;
    opus.pipe(decoder);
    decoder.on("data", (d: Buffer) => {
      chunks.push(d);
      bytes += d.length;
      if (!barged && bytes >= BARGE_IN_MS * 192) {
        barged = true; // 48 kHz * 2 ch * 2 bytes = 192 bytes/ms
        this.conv?.bargeIn();
      }
    });
    decoder.on("error", (e) => this.log(`opus: ${e.message}`));
    opus.once("end", () => {
      decoder.end();
      const pcm = downsample48kStereoTo16kMono(Buffer.concat(chunks));
      void this.conv?.onUtterance(pcm).catch((e: unknown) => this.log(`turn: ${errorMessage(e)}`));
    });
  }

  // ---- AudioOut ----

  play(pcm: AsyncIterable<Buffer>): Promise<void> {
    const resource = createAudioResource(Readable.from(pcm), { inputType: StreamType.Raw });
    this.player.play(resource);
    return new Promise((resolve) => {
      const done = () => {
        this.player.off(AudioPlayerStatus.Idle, done);
        resolve();
      };
      this.player.on(AudioPlayerStatus.Idle, done);
    });
  }

  stop(): void {
    this.player.stop(true);
  }

  // ---- TextOut ----

  async post(text: string): Promise<void> {
    if (!this.cfg.textChannelId) return;
    const ch = (await this.client.channels.fetch(this.cfg.textChannelId).catch(() => null)) as TextBasedChannel | null;
    if (!ch || !("send" in ch)) return;
    for (let i = 0; i < text.length; i += 1900)
      await ch.send(text.slice(i, i + 1900)).catch((e: unknown) => this.log(`post: ${errorMessage(e)}`));
  }

  private onHubEvent(e: HubEvent): void {
    if (this.conv) {
      this.conv.onEvent(e);
      return;
    }
    // Not in a call: only finished dispatched work is worth a text message.
    if (e.type === "turn_done" && e.session.dispatched)
      void this.post(`✅ **${label(e.session)}** finished:\n${e.lastMessage.slice(-1500)}`);
  }
}
