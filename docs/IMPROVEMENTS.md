# Improvement backlog

Research from 2026-11-18, after the first real call. Ranked; effort S/M/L. Claims marked
_(unverified)_ come from the research pass and need checking before building on them.

Done already, from the same review: reply and tool logging, focus on newly started sessions, a
session-state watcher so finishes are announced without hooks, project descriptions and aliases in
the prompt, retraction handling in the router, a code check for claimed-but-not-done actions, and
the Eleven v4 speed fix (v4 ignores `voice_settings.speed`, measured). Then items 1 to 4 below:
cross-session messaging relay, Scribe v3 Live streaming (~1.0 s to text, measured), spoken
confirmations from tool results, and pointer resolution ("that one") in code.

1. **Cross-session messaging for interactive sessions (M).** Claude Code documents `SendMessage` /
   `ListAgents` across terminal, Desktop, Remote Control and `--bg` sessions on one machine, which
   would replace the "fork it?" fallback for interactive sessions. A relay `claude -p` with
   `crossSessionInbound: accept` could carry it. Inbound messages can't approve permission prompts,
   so voice approvals stay on the hook. _(unverified: check the docs and that a `-p` worker can
   send, and update ARCHITECTURE.md, which says there is no such route)_
   <https://code.claude.com/docs/en/cross-session-messaging>
2. **Streaming STT with turn prediction (M).** Scribe v3 realtime with turn-prediction commits
   instead of a fixed silence timeout plus a batch upload; worth roughly 1 to 2.5 s per turn.
   Discord sends nothing during silence, so feed zero frames or the predictor never sees the pause.
   Local alternative: Pipecat Smart Turn v3 (small ONNX model). Log end-of-speech to first audio
   first, to measure the win. _(unverified: model name and pricing)_
   <https://github.com/pipecat-ai/smart-turn>
3. **Speak confirmations from tool results (S).** Build "Started the API refactor" from the
   dispatch result instead of the model's own words, and put the user's exact words into dispatch briefs
   beside the paraphrase.
4. **Resolve "that one" in code (S–M).** Keep last mentioned / announced / dispatched session and
   use `claude agents --json` `state` and `waitingFor` to rank working > blocked > idle > done; ask
   before sending to a finished session.
5. **Cheaper, snappier fixed phrases (S).** Pre-render "Checking.", "On it.", "Sent." and the fixed
   parts of approvals once and cache the audio: zero characters, instant playback. Add short earcons
   for heard / dispatched / finished. The free tier's 10k characters is only ~150–200 replies.
6. **Delivery (S).** Try `stability` around 0.3–0.4 for a less read-out tone; tell the prompt to use
   contractions and fragments; consider one bidirectional TTS stream per reply instead of a request
   per sentence (helps the 2-request free limit).
7. **Gentler barge-in (M, needs 2).** Duck instead of stopping, cut only after real words, ignore
   "mm"/"yeah", resume after a false interruption.
   <https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/>
8. **"While you were away" and memory (S–M).** Open a call with a digest of what finished or got
   stuck since the last one; write a short per-topic summary to `state/` at hang-up and inject it on
   that topic's first turn; hook `StopFailure` so rate-limit and API failures are announced.
9. **Preflight checks (S).** Before dispatching work that needs a VPN or a Kerberos ticket, check the VPN interface and `klist -s`,
   and say so if either is down instead of starting a session that will stall.
10. **Model choice: no change.** Haiku at low effort stays the brain; Sonnet only if dispatch briefs
    need it. Speech-to-speech models would lose the subscription brain and tool reliability.

Paid voice options if the free tier pinches: ElevenLabs Starter (~$5/month, library voices,
30k credits), Cartesia (~$5/month, fast). Kokoro stays the free local fallback.
