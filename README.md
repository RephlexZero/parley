# Parley

Call into a Discord voice channel and talk to the Claude Code sessions running on your PC: ask what
they're doing, start new ones, send follow-ups, and approve tool calls by saying yes or no.

How it works and why: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Try it without Discord

```bash
mise install          # Node 24, lefthook, typos, gitleaks
mise run setup        # npm ci + git hooks
npm test              # router, hub, hooks, audio (no network)
npm run smoke -- "what's running?" "how's tidepool?" "unrelated, name a cat"
```

`smoke` uses your real sessions and your logged-in Claude Code, and prints first-token times. Tools that
change things (dispatch, send, approve) are stubbed unless `SMOKE_LIVE=1`.

## Set up

1. **Discord bot.** discord.com/developers → New Application → Bot → copy the token. No privileged
   intents needed. Invite with scope `bot` and permissions View Channels, Connect, Speak, Send Messages.
2. **ElevenLabs.** An API key and a voice id.
3. **Config.** `cp .env.example .env` and fill it in. Turn on Discord Developer Mode to copy ids.
4. **Hooks.** `npm run hooks` prints a `PARLEY_TOKEN` (put it in `.env`) and the hooks block to merge into
   `~/.claude/settings.json`. They apply to every session, `claude-rc` ones included. With Parley not
   running, the hooks fail fast and Claude Code carries on as normal.
5. **Run.** `npm start`, then join the voice channel. Parley joins, says "Hey", and leaves when you do.

Optional:

- **Two-way channel** for sessions you start yourself: the `claude mcp add-json` line from `npm run hooks`,
  then `claude --dangerously-load-development-channels server:parley`. Needs channels enabled on your plan.
- **Speech stacks**: `npm run stack` shows them and what's running; `npm run stack -- <name>` switches,
  starting or stopping the local containers (`deploy/local`) and restarting the service if it runs.
  - `eleven`: ElevenLabs Scribe v3 + v4 Turbo (default; most accurate, best voice)
  - `local`: whisper.cpp on the GPU + Kokoro on the CPU (free)
  - `hybrid`: local whisper.cpp for listening, ElevenLabs voice
- **Always on:** `deploy/parley.service` is a systemd user unit (install steps in the file). Parley runs
  natively rather than in Docker, because it needs your `~/.claude`, your Claude login, and to start
  sessions in your real environment.

## Development

`npm run check` runs what CI runs: prettier, `tsc` (strict, plus `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`), ESLint with typescript-eslint `strictTypeChecked`, knip (dead code) and the
tests. CI also runs typos, gitleaks over the whole history, `npm audit` and `npm audit signatures`.

Git hooks (lefthook, installed by `mise run setup`) are advisory and quick: prettier, typos and gitleaks
on staged files at commit, conventional-commit messages, and typecheck/lint/knip/tests on push.

## Things to say

- "What's running?" / "Anything need me?"
- "How's the lidar camera one on orbit?" then "did the tests pass?" (stays on that session)
- "Start a session on tidepool to check the backtest tests pass, use sonnet"
- "Tell the orbit one to also update the README"
- "Yes" / "no" after an approval is read out
- "Unrelated, …" for anything that isn't about a project
