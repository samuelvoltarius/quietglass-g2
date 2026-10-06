# Changelog

All notable changes to Shoot Day are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-10-07

First public release, brought over from a private shoot-day app and rebuilt on
Quietglass conventions.

### Added
- Start menu with four modules: take log, teleprompter, schedule (call sheet)
  and packing list.
- Take log: OK/NG per shot with a note, counts and the last take on the card;
  takes logged offline are kept on the phone and sent later.
- Note on the last take now updates that take instead of logging a second one.
- Packing list with voice: hold to speak, release to apply; German and English
  sentences, "what's missing?" and "everything packed".
- Voice commands for takes ("Szene 2 B OK unscharf", "scene 2 B no good").
- Phone page: server address and optional token (write-only), language,
  swipe inversion, connection status, first-run hint, an http/mixed-content
  warning.
- German and English throughout, following the phone language.
- `?demo=1` with labelled sample data and no network.
- Example server (`examples/shoot-day-server.mjs`) with a bilingual web
  terminal, and an MCP server (`examples/dreh_mcp.py`).

### Changed (compared with the private version)
- Every screen is drawn on one three-container page and updated in place
  instead of rebuilding list containers on every change.
- Double tap in the menu asks the system before leaving (exit mode 1); inside
  a module it returns to the menu.
- No built-in addresses: the server is entered on the phone. The example server
  binds to `127.0.0.1`, needs a `TOKEN` beyond it, and compares it in constant
  time. The speech recogniser is configured with `WHISPER_URL`.
- Every network request has a timeout; only one load per list runs at a time,
  and replies that arrive after leaving a module are dropped.
- The microphone closes after 15 s, when leaving a module, and when the app
  closes; a cancelled recording is never sent.
- The web terminal builds its tables from DOM nodes, so notes and names are
  never interpreted as HTML.
- Neutral example project and packing-list template.
