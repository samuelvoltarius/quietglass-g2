# Changelog

## 0.5.1

Never show demo data when disconnected; connection diagnostics.

- **No silent demo fallback.** An unreachable daemon at startup used to show
  demo agents, devices and a printer while every action went nowhere. Demo data
  now exists only behind `?demo=1`. Disconnected, every page says "Nicht
  verbunden" with the exact reason (server missing / unreachable / wrong token /
  timeout / not https) and the server host; automatic retry with backoff
  (2, 5, 10, 30 s) and on tap. Daemon stand-ins for Home Assistant / Moonraker
  show "nicht eingerichtet" instead of fake items.
- **https check.** The installed app runs on an https origin and cannot call
  `http://` servers (mixed content). The app refuses to try and says
  "Server muss https sein - z. B. https://<pi>.<tailnet>.ts.net:8443".
  `scripts/start-pi.sh` now puts the Tailscale HTTPS names (from
  `tailscale serve status --json`) into the pairing QR, http only with a warning.
- **Phone page.** Connection status (host, last success, last error), inline
  "Verbindung testen", QR button on top when not connected; settings are written
  to the SDK store and read back, the client reloads and polls immediately.
- **Daemon access log**: one token-free line per request to the journal
  (`[access]`), relay heartbeats skipped.
- Failed actions (send, approve ...) now say why on the glasses.

## 0.5.0

A clearer hub: everything on one overview, a native menu per page, confirmed voice.

- **Overview shows everything, no setup.** Online agents with dots (`●` idle,
  `*` busy, `!` waiting, `○` offline), unread alerts, lights on, printer progress
  and what needs you right now. Agents appear from the relays by themselves;
  every empty page says in one line what is missing. No phantom agent when none
  is connected.
- **Fixed status line** (header, updated in place): page, connection, unread,
  busy agents, waiting cards.
- **Native contextual menu** per page (<= 6 verbs, <= 32 bytes, ids non-zero,
  re-supplied on every rebuild): Agent *Stop / New session / Switch agent*,
  Alerts *Mark all read*, Home, Printer, card *Allow / Deny*, Help. Gestures stay
  as shortcuts; risky menu actions keep the confirming tap.
- **Voice with confirmation.** `● Aufnahme …` -> release -> `Verstanden: …` ->
  tap sends, double tap discards. "Send immediately" is a phone setting (off by
  default). Daemon: `POST /agent/voice?ask=0` transcribes only (older apps keep
  the old behaviour).
- **Feedback and help.** Every action answers in the footer (sent, allowed,
  denied, stopped, new session, ...); a help sheet lists the controls.
- **R1 ring.** Ring double tap opens a page picker (never exits), swipe selects.
- **Long answers in pages** (six rows; swipe turns, last page = questions),
  tool calls as one line, permission cards with tool and command.
- **Robust input.** Missing `eventType` = CLICK, missing
  `currentSelectItemIndex` = 0, 300 ms scroll cooldown, selections kept in state.
- **Fewer BLE writes.** Only changed containers are upgraded, the icon only when
  it changes, a rebuild only when the menu (page) changes.
- **Fast entry.** Launching from the glasses menu opens the Overview.
- **Daemon: phone mirror.** waiting/done/error events and finished prints go to
  Home Assistant's `notify.mobile_app_*` (auto-detected, read-only; pin with
  `HA_NOTIFY_SERVICE`, off with `HA_NOTIFY=off`). `/report` approvals now carry
  the `tool`. Relay protocol unchanged.
- Screenshot scenes for the simulator: `?demo=1&scene=card|busy|long|empty|alerts`.

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
