# Parley

Discord voice assistant that acts as a switchboard for the Claude Code sessions on this PC.
Design and rationale: `docs/ARCHITECTURE.md`. Read it before changing how sessions are reached.

- TypeScript run directly by Node 24's type stripping: no build step. Imports use `.ts` extensions, and
  `erasableSyntaxOnly` is on, so no enums, namespaces or constructor parameter properties.
- Node comes from `mise` (`mise.toml`); prefix commands with `mise exec --` if `npm` isn't on PATH.
- Check: `npm run check` (format, tsc, eslint, knip, tests); CI adds typos, gitleaks and npm audit.
  Lint is `strictTypeChecked` with zero warnings: no `!` assertions, no floating promises, `unknown` in
  catch (use `errorMessage`). `npm run smoke -- "<utterance>"` exercises the real brain against
  real sessions without Discord (needs network to the Claude API; acting tools are stubbed).
- Layout: `src/hub` (everything that touches Claude Code), `src/brain` (router, prompt, tools, cli/api
  backends), `src/voice` (Discord, audio, STT/TTS, conversation loop), `src/channel` (optional MCP channel).
- Only `src/hub` may read `~/.claude` or run `claude`. Never write to `~/.claude`; `npm run hooks` prints
  settings for the user to paste.
- The system prompt and tool list must stay byte-stable during a run (caching); put anything volatile in
  the turn input (`src/brain/context.ts`).
- Commits follow conventional commits (the commit-msg hook checks). Hooks: `mise run setup`.
- Runs natively (`deploy/parley.service`), not in Docker; the optional local speech services (whisper.cpp,
  Kokoro) are containers in `deploy/local`, switched with `npm run stack`. Reasons in `docs/ARCHITECTURE.md`.
- Facts about Claude Code used here (registry file shape, `claude agents --json`, hook payloads, channel
  notifications) were checked against v2.1.325 and its docs. Re-check them when Claude Code updates.
