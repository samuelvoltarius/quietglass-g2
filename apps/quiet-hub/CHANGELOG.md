# Changelog

## 0.4.0

Real session control for every agent, a real Stop, and a way back from every page.

- **Sessions on the glasses.** Agent list -> session page (`+ New session`,
  `» Continue`, recent sessions with age) -> open session. German and English.
- **Hermes via the evenhub-bridge.** The relay (and the daemon's own Hermes) can
  talk to the `hermes-evenhub-bridge` WebSocket: hello/token, session list, new,
  switch, streamed answer, tool activity, interrupt, reconnect with backoff.
  `relay.json`: `"bridge": {"url": "ws://…", "tokenEnv": "EVENHUB_BRIDGE_TOKEN"}`;
  the token is read at runtime from the environment or `~/.hermes/.env` and is
  never stored or printed. `hermes chat -q` stays as fallback and now continues
  a session with `--resume <id>`.
- **Claude / Codex sessions.** Claude `-p --resume <session_id>` (id read from
  the stream-json output; session list from `~/.claude/projects`), optional
  `--continue`. Codex `thread/start` vs `thread/resume`, `thread/list`.
- **Real Stop.** Double tap while an agent runs: Hermes bridge `stop`, Codex
  `turn/interrupt`, and for every CLI the whole process tree is killed
  (`taskkill /T /F /PID` on Windows, the process group on Linux/macOS). The
  status shows `[gestoppt]`; the daemon reports `stopped` and `stopConfirmed`.
- **Daemon API.** `GET /agent/sessions`, `POST /agent/session/new`,
  `POST /agent/session/select`, `POST /relay/reply`; `/agents` and `/report`
  carry `session`, `transport`, `stopped`.
- **Back never fails.** Footer hint `2× = zurück` on every page; double tap
  discards a running recording; a notification no longer pulls you out of the
  agent page; gesture decoding prefers an explicit double-tap code over an empty
  payload next to it; phone setting to reverse the swipe direction.
- **Voice.** Max 18 s, minimum length, and clear errors on the glasses
  (`Mikrofon nicht freigegeben`, `Spracherkennung nicht erreichbar`).
- **Suggestions only from the Spark vLLM.** Follow-up options for every agent kind
  and for permission cards come from vLLM (`VLLM_URL`, `VLLM_MODEL`, default
  `qwen`, Qwen thinking off, temperature 0.3, 6 s timeout, asynchronous). If it
  fails there are no suggestions (and a log line) - never agent-supplied or canned.
- Agent logic moved to `examples/quiet-hub-agents.mjs` (copy it next to the
  relay).

## 0.3.0

Multi-agent relay, voice, Home Assistant and Moonraker.
