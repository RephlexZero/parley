# Parley architecture

Parley is a Discord voice-channel assistant that is a switchboard for the Claude Code sessions running
on this PC. You talk; it routes what you said to the right project, answers from live session state,
starts new background sessions, passes follow-ups into existing ones, and reads out tool approvals.

## Compared with the starting plan

The starting plan was: a scheduled `claude -p` briefing file, an ElevenLabs hosted Agent (Haiku on an API
key) as the voice, a webhook on the PC that runs Claude Code for deep work, and the ElevenLabs widget or
Twilio for access.

| Starting plan                                 | Parley                                                                                      | Why                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ElevenLabs hosted Agent runs the conversation | Local bot runs the loop; ElevenLabs is only STT/TTS                                         | The LLM can call local code directly, and there's no second agent config to keep in sync                                            |
| Webhook on the PC for "dispatch task"         | Nothing listens on the internet; the hub binds 127.0.0.1                                    | A public webhook on your dev PC that runs Claude Code is a remote-code-execution endpoint                                           |
| Scheduled briefing file                       | Live context injected per turn from the session registry and transcripts                    | A cron'd file is stale by definition; reading `~/.claude/sessions` is instant                                                       |
| Deep work = `claude -p` per request           | `claude --bg` background sessions                                                           | They show up in `claude agents`, can be attached, resumed and answered from the phone                                               |
| Haiku on an API key                           | Default: Haiku via your logged-in Claude Code (`claude -p`, subscription); API is an option | No per-token bill; ~0.5 s first token when warm (measured)                                                                          |
| One conversation                              | One conversation per topic (topic binning)                                                  | Work, uni and personal never share context; asides don't derail a project thread                                                    |
| Phone/widget                                  | Discord VC                                                                                  | Discord gives one audio stream per speaker, so the bot only listens to you (speaker identity for free, which matters for approvals) |

## Components

```
 Discord VC ──opus──▶ DiscordVoice ──16k PCM──▶ STT (ElevenLabs Scribe v3 | local whisper.cpp)
                         ▲                              │ text
                         │ 48k PCM                      ▼
                    TTS (ElevenLabs) ◀── sentences ── Conversation ──▶ Router (topic bins)
                                                        │   ▲               │
                                                        ▼   │ events        ▼
                                                      Brain (per topic) ──tools──▶ Hub ◀── HTTP hooks ── every Claude Code session
                                                   cli: warm `claude -p` pool         │  ◀── channel MCP ── sessions started with the channel
                                                   api: Messages API                  ├─ ~/.claude/sessions/*.json, `claude agents --json`
                                                                                      ├─ transcripts (last message)
                                                                                      └─ `claude --bg` / `--resume --bg` / `--fork-session`
```

- **Hub** (`src/hub`): the only part that touches Claude Code. Reads the live session registry
  (`~/.claude/sessions/<pid>.json`: name, cwd, busy/idle, Remote Control bridge id) merged with
  `claude agents --json` (background sessions and their state). Receives HTTP hooks. Holds pending
  approvals. Starts and messages sessions.
- **Brain** (`src/brain`): the conversational model, with six tools (`list_sessions`, `session_status`,
  `dispatch_task`, `send_to_session`, `answer_approval`, `post_to_text`).
- **Router** (`src/brain/router.ts`): topic binning, below.
- **Voice** (`src/voice`): Discord join/leave, capture, barge-in, STT, TTS, sentence streaming.
- **Channel** (`src/channel`): optional MCP channel server for two-way messaging with a session.

## How it reaches your sessions

Your Remote Control sessions are the `claude-rc` systemd servers (`claude remote-control`, one per
folder). Parley uses three mechanisms, from universal to opt-in:

1. **Read-only state, every session.** The registry files and `claude agents --json`, plus the tail of
   each transcript for "what did it last say". No setup.
2. **Hooks, every session.** HTTP hooks in `~/.claude/settings.json` (printed by `npm run hooks`) apply to
   all sessions, the RC-spawned ones included:
   - `PermissionRequest`: while you're in the call, the hook holds the request, Parley reads it out
     ("orbit wants to run npm test. Allow?"), and your yes/no becomes the hook's decision. When you're not
     in the call, or nobody answers within `APPROVAL_TIMEOUT_S`, the hook returns no opinion and the normal
     prompt (terminal, phone, claude.ai) takes over. The hook blocks while it waits, so keep the timeout short.
   - `Stop`: a session finished a turn. If it's one Parley dispatched, or the one you're talking about,
     Parley tells you the outcome.
   - `Notification` (`idle_prompt`, `agent_needs_input`): "X needs your input".
3. **Sending into a session.**
   - Background sessions (`claude --bg`): `claude --resume <id> --bg "<message>"`. If it's busy, the
     message waits until its `Stop` hook fires.
   - Sessions with the Parley **channel** loaded: pushed straight in (`notifications/claude/channel`), and
     the session can answer by voice with the channel's `reply` tool. Channels also relay permission
     prompts (`claude/channel/permission`), which takes over from the hook for that session. A session
     opts in at launch: `claude --dangerously-load-development-channels server:parley`. Channels need
     `channelsEnabled` on Team/Enterprise plans, so check with your org admin if the work plan blocks it.
   - Interactive sessions without the channel (terminal, desktop app, Remote Control): Claude Code's
     [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging). There's no CLI
     command to send, only the `SendMessage` tool, so the hub runs a one-shot relay
     (`claude -p --name parley --tools SendMessage,ListAgents`, Haiku, ~3.5 s) that addresses the session by
     name. A busy session reads it between tool calls; an idle one starts a turn. Messages can't approve
     permission prompts, and a receiver in `bypassPermissions` holds messages from a prompting sender. If
     the session has no name or the relay fails, Parley offers to **fork** it into a background copy
     (`--resume <id> --fork-session --bg`). Checked on v2.1.325, November 2026.

Not used: writing to the inbox socket (`messagingSocketPath`) directly. Its wire format isn't
documented, and the relay does the same through the supported tool.

## Brain backends

Seeing and driving your sessions doesn't depend on the brain: the hub reads `~/.claude`, receives the
hooks and runs `claude --bg` with your login whichever backend answers. Measured side by side on the same
three questions (November 2026), `claude -p` and the API were within ~0.1 s of each other once warm, and
the API's first call was slower. So the subscription-backed cli stays the default; the API key is a
fallback if the Claude login lapses. Handing the key to ElevenLabs instead (their hosted Agents) would
move the conversation off this PC and need a public webhook for the tools, which this design avoids.

|               | `BRAIN=cli` (default)                                    | `BRAIN=api`                                                 |
| ------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| Runs on       | your logged-in Claude Code (`claude -p`, subscription)   | Claude API key                                              |
| Marginal cost | none (counts against plan limits)                        | Haiku 5.5: $0.10 / $0.50 per M tokens, about $0.0004 a turn |
| First token   | 0.5–1.1 s warm (measured)                                | 0.5–1.8 s (measured); no faster in practice                 |
| Tools         | parley's MCP server (`src/brain/mcp.ts`) → hub over HTTP | in-process                                                  |

The cli backend keeps one long-lived `claude -p --input-format stream-json --output-format stream-json
--include-partial-messages` process per active topic, plus a spare, each primed with a warm-up turn at
spawn (Claude Code finishes starting up on its first message). Each process is locked down:
`--tools ""` (no built-in tools), `--allowedTools mcp__parley`, `--permission-mode dontAsk`,
`--setting-sources ""` (none of your hooks or settings), `--strict-mcp-config`, `--no-session-persistence`
(no clutter in `claude --resume`), and a short replacement `--system-prompt`.

## Topic binning (staying on topic)

Every utterance lands in exactly one bin, and each bin is its own brain conversation:

- **session bin**: a named session ("the lidar camera one"), or a project with only one session.
- **project bin**: a project with several sessions; its context lists them so the brain can ask which.
- **general bin**: anything not about a project, or flagged as an aside ("unrelated, …", "quick
  question"). Its prompt line tells the brain not to touch sessions unless asked.

Routing is deterministic and costs nothing: fuzzy name matching that tolerates STT noise ("tempo morph",
"tempamorph"), and sessions from moved repos still match their project by folder name. A follow-up with no
name stays in the current bin for 2 minutes, then falls back to general. Projects carry a domain (work /
uni / personal, from the path), and the prompt forbids carrying information across domains.

## Latency

Per turn: end-of-speech silence (`END_SILENCE_MS`, 700) + STT + brain first token + TTS first audio.

- **Brain**: warm processes and the spare (above). `[context]` lines put live session state into the
  turn, so most questions need no tool call: a tool round trip measured +1.5 s.
- **Filler**: when a tool call starts before anything has been said, Parley says "Checking." / "On it."
  at once.
- **Speech streaming**: the first clause goes to TTS as soon as it exists; later sentences are requested
  while the current one plays, using `previous_text` so intonation carries over.
- **Fast paths**: a bare yes/no while an approval is pending is handled without the LLM.
- **Barge-in**: 300 ms of your speech stops playback and aborts the brain turn.
- STT and TTS timings are not measured live yet.

The biggest cost was **endpointing**: a fixed 700 ms of silence, then a batch upload (1.4 to 2.5 s from
the end of speech to text). With ElevenLabs, Parley now streams instead (`STT_LIVE=1`, the default):

1. Streaming STT with turn prediction: **Scribe v3 Live** (`src/voice/live-stt.ts`, one WebSocket per call,
   `commit_strategy: turn_prediction`, 0.7 s silence fallback). Measured ~1.0 s from the end of speech to
   the committed transcript. Discord sends no packets in silence and the server only judges audio it
   receives, so the client sends zeros for 4 s after speech, and a 20 ms zero chunk every 5 s otherwise
   (the server drops a socket after 15 s of nothing). If the socket can't start, that call falls back to
   batch. Deepgram **Flux** (`EagerEndOfTurn` / `TurnResumed` / `EndOfTurn`) is the alternative.
2. Speculative start: begin the brain turn on the eager end-of-turn and cancel it if you keep talking.
   Cheap on Haiku, but tools that act (dispatch, send, approve) must never run on a speculative turn.
3. Silero VAD with a short stop (~200 ms) as the fallback for local STT.

## Cost

- Brain: zero marginal on the cli backend; fractions of a cent a turn on the API.
- **TTS characters are the main recurring cost.** Short spoken answers (the prompt enforces it), long
  content goes to the text channel instead (`post_to_text`). Default `eleven_v4_turbo`: real-time
  (~100 ms), reads audio tags, and costs the same per character as Flash v2.5.
- **STT** is billed by audio length. Only end-pointed speech from you is sent, and clips under 350 ms or
  below an RMS floor (coughs, keyboard) are dropped first. `STT=whisper` makes it free and local.
- Figures for both are in Speech options below.
- Dispatched work runs as normal Claude Code sessions on your plan.

## Accuracy

- STT is biased toward your project and session names (Scribe `keyterms`, capped at 100 because more than
  that bills every request as at least 20 s; whisper `prompt`). Names are fuzzy-matched after.
- Tools resolve names themselves and return "ambiguous: X or Y?" rather than guessing.
- The prompt says to ask when a transcript looks garbled, and to confirm anything irreversible.
- Approvals are read back as "<session> wants to <action>", with the full command and an id posted to the
  text channel, which also shows every transcript (so you can see mishearings).
- Parley only listens to `DISCORD_OWNER_IDS`. Other people in the channel can't approve anything.

## Security

- Hub on 127.0.0.1 only, bearer token on every route. No webhooks, tunnels or open ports.
- The brain can't run shell commands or edit files: no built-in tools, only Parley's six.
- Approvals expire back to the normal prompt; leaving the call clears them.
- Parley never edits `~/.claude/settings.json`; `npm run hooks` prints what to add.
- Audio is only subscribed for `DISCORD_OWNER_IDS`, so nobody else's speech is decoded or transcribed.
- Voice approval is the weakest link. Others in this space (VoiceCode, WorkOS's write-up) only accept a
  typed or button approval, rendered from the real tool arguments rather than a model's summary, because
  a voice can be someone else in the room or a clone. Parley's spoken summary comes from the hook payload
  (`summariseTool`), not the LLM, and the full command is posted to the text channel. Next step: Discord
  buttons, and voice approval only for low-risk tools.

## Speech options

Priced for about 15 min of your speech a day (7.5 h a month) and 300k TTS characters a month, at list
prices checked November 2026.

| STT                                                       | Per month                             | Notes                                                                                    |
| --------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| ElevenLabs Scribe v3 Live (WebSocket) (**default**)       | ~$1.65                                | Streaming with turn prediction, ~1.0 s to text after you stop. 50 keyterms of ≤20 chars  |
| ElevenLabs Scribe v3, batch (`STT_LIVE=0`)                | ~$1.50, +20% with keyterms            | Lowest word error rate on Artificial Analysis' board (1.9%). Up to 1000 keyterms         |
| Deepgram Flux                                             | ~$3 (a $200 free credit covers years) | Best-known end-of-turn handling for agents                                               |
| whisper.cpp large-v3-turbo, Vulkan on a mid-range AMD GPU | $0                                    | ~4.6% WER, about 1 s per utterance on this class of card; prompt biasing; `deploy/local` |
| Parakeet TDT 0.6B (sherpa-onnx, CPU)                      | $0                                    | Faster than whisper on CPU, ~4.5% WER, no prompt biasing                                 |

| TTS                               | Per month                         | Notes                                             |
| --------------------------------- | --------------------------------- | ------------------------------------------------- |
| ElevenLabs v4 Turbo (**default**) | ~$12 of usage: Creator plan ($22) | ~100 ms, audio tags                               |
| ElevenLabs Flash v2.5             | same                              | No audio tags                                     |
| Deepgram Aura-2                   | ~$9                               | Lower quality                                     |
| Kokoro-82M on CPU                 | $0                                | Good local voice; `TTS=kokoro`, in `deploy/local` |

- One ElevenLabs Creator plan should cover both STT and TTS at this usage, though ElevenLabs doesn't say
  outright that the allowances are separate.
- whisper.cpp is solid and simple to run here (one container, Mesa Vulkan, no ROCm), but less accurate
  than Scribe v3 on names and jargon, and Whisper invents "Thank you." on near-silence (filtered in
  `isJunk`).
- Claude's own voice mode: Anthropic hasn't said which STT it uses. Its subprocessor list names ElevenLabs
  for text-to-speech.

## Running it: native, not Docker

Parley itself runs as a systemd user unit (`deploy/parley.service`), next to the `claude-rc` units. In a
container it would need: your `~/.claude` (registry, transcripts, credentials) mounted read-write for
`claude`; the host pid namespace to tell live sessions from dead ones; and `claude` itself, whose
`--bg` sessions would then run inside the container, with the container's tools and filesystem instead of
your real projects. Each of those undoes what the container was for.

The part that fits a container is the optional local STT: whisper.cpp's `main-vulkan` image with
`/dev/dri` passed through, and Kokoro's CPU image, both in `deploy/local/compose.yml` on loopback ports
only. `npm run stack` starts and stops them.

## Prior art

- **Discord voice in Node** needs DAVE end-to-end encryption (required by Discord since early 2026):
  `@discordjs/voice` 0.19.2 or later with `@snazzah/davey`. 0.19.2 fixed DAVE receive returning no audio.
  An unconfirmed report says packets can drop during DAVE key changes, and receive is undocumented by
  Discord, so failures are silent: worth logging packets per second per speaker.
- **No voice framework has a Discord transport.** Pipecat (Python) and LiveKit Agents expect their own
  rooms; adopting one means a custom transport around the same discord.js receive code. Borrow their
  components instead (turn detection, interruption rules).
- **Projects bridging voice to Claude Code**: VoiceCode (Python, Discord, `claude -p --resume`, typed
  approvals only), claude-voice-multiplexer (LiveKit, local Whisper and Kokoro, an MCP plugin per session,
  2.5 s silence endpointing), broca-machina (discord.js voice). The official Claude Code channels have
  Telegram/Discord/iMessage plugins for text, with the same permission relay Parley's channel uses.
- **Interruptions**: cutting the bot off on 300 ms of any sound is too eager. broca-machina ducks the
  volume first and only stops after a few words or a stop phrase; LiveKit ignores backchannels ("mm-hmm")
  and resumes after a false interruption.
- **Keep the switchboard fast and report later**: Claude Code turns take seconds to minutes. Parley
  already acknowledges at once and reports on the `Stop` hook.

## Not done yet

- Discord buttons for approvals in the text channel (voice and normal prompt only for now).
- Streaming STT with turn prediction and a speculative brain start (Latency, above).
- Gentler barge-in: duck, then stop after real words.
- Receive-health logging (packets per second per speaker).
- A daily briefing from calendar/email. If wanted: a scheduled `claude -p` with those connectors writes a
  short file that the general bin reads at call start.
- Re-seeding a topic's context after its warm process is evicted from the pool (`BRAIN_POOL`).
