# Changelog

## [Unreleased]

Security and robustness review:

- Permission swipes are only accepted for the request actually on display, after
  a short arming delay, once per request, never while an error screen hides it,
  and never again for a request re-delivered by a reconnecting stream. The
  answer is sent before the redraw.
- A `?token=` in any provider address is moved into the token field; user
  credentials and fragments are dropped from addresses; pairing keeps a literal
  `+` in tokens and refuses non-HTTP pairing URLs. Short tokens are no longer
  shown with a 4-character suffix. The development `?pair=` parameter is removed
  from the page address after use.
- Spoken output also omits JWTs, `Authorization` headers, bearer tokens,
  environment assignments, password fields, SSH and private keys, AWS and Google
  keys, long base64 values, all `scheme://` links and `$ ` command lines, and no
  longer splits a sentence inside an open code fence or a dotted token.
- Hermes reconnects with exponential backoff, ignores events from a replaced
  socket, stops after a rejected token and stays silent after being disposed.
- OpenClaw: an interrupt, a newer prompt or a backend switch no longer surfaces
  as a "Timed out" error; a real timeout is reported as such; answers sent as
  server-sent events are parsed.
- Opening a session or switching backend while another request is in flight no
  longer starts a second stream or writes stale results into the new state.
- Errors, tool names and permission titles are clipped to the 7 × 46 display;
  the CORS hint is only shown for Even Terminal errors; a live event clears a
  "connection interrupted" message; tap-to-retry re-subscribes.
- After a double tap, nothing redraws the glasses or reacts to input.
- Documented why the network whitelist cannot be narrowed.

## [0.4.0] — 2026-10-05

- Added a real backend selector for Even Terminal, Hermes and OpenClaw.
- Integrated the existing `hermes-evenhub-bridge` WebSocket contract for
  sessions, history, streamed answers, tool activity, interruption and new
  session creation.
- Integrated the existing OpenClaw `/v1/chat/completions` gateway with its
  bearer token, conversation context, health check and interrupt support.
- Added a phone prompt composer so Hermes and OpenClaw can be used directly
  instead of merely watched.
- Keeps permission controls capability-driven: only Even Terminal shows
  allow/deny actions because the existing Hermes and OpenClaw gateways do not
  expose an external permission-decision event.
- Added provider protocol tests and network permissions for configured HTTP,
  HTTPS and WebSocket gateways.

## [0.3.0] — 2026-10-05

- Added opt-in spoken output through the phone's current audio route, including
  AirPods and Bluetooth headphones on iOS and Android.
- Added language, installed system voice, and speech-speed controls.
- Buffers streamed tokens into completed sentences before speaking.
- Omits code blocks, inline code, URLs, permission commands, and token-looking values from
  spoken output; permission prompts use a generic alert instead of reading the
  command aloud.
- Added pause, resume, replay, and a one-tap activation flow required by phone
  WebViews.
- Documented the current provider boundary: Claude Code and Codex through Even
  Terminal; Hermes and OpenClaw need an adapter rather than being claimed as
  supported.

## [0.2.0] — 2026-10-05

- Converted the glasses UI, phone UI, errors, tests, and documentation to English.
- Added a private `?demo=1` mode with neutral in-memory data for safe screenshots.
- Replaced the live-session screenshot and removed personal example content.
- Fixed the package output name and updated the minimum Even App version.

## [0.1.0] — 2026-09-29

Initial proof of concept:

- Session list from Even Terminal with swipe selection.
- Session history and live SSE stream on the glasses.
- Permission requests answered with swipe up to allow or swipe down to deny.
- Clear distinction between controllable and watch-only sessions.
- Pairing by pasting the full address printed by the server.

### Implementation notes

- Even Terminal can only control sessions it started itself.
- `even-terminal claude` is a client; the server is `even-terminal start`.
- All endpoints live under `/api`.
- `--allow-cors` is required when the app and terminal run on different ports.
- `EventSource` cannot set an authorization header, so the local SSE endpoint
  accepts the token as a query parameter.

### Not included

- The permission view is covered by tests but has not yet been validated on
  physical glasses with a session started by Even Terminal.
- No voice input.
