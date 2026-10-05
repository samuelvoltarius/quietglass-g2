# Changelog

## [0.3.0] — 2026-10-05

- Added opt-in spoken output through the phone's current audio route, including
  AirPods and Bluetooth headphones on iOS and Android.
- Added language, installed system voice, and speech-speed controls.
- Buffers streamed tokens into completed sentences before speaking.
- Omits code blocks, inline code, URLs, commands, and token-looking values from
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
