# Changelog

## [0.2.0] — 2026-10-13

### Added

- A sign in the top-right corner of the header (64 x 30 image) for every page. While a take runs on the takes page it is a recording dot that pulses once a second.
- "Take läuft": a new first entry "Take starten" in the take menu (it opens on "Take OK") starts a take; the card shows "● Take 3 läuft · 0:23". Logging OK or NG, moving to another shot or leaving ends it; while it runs the entry reads "Take abbrechen".
- Day bar on the schedule page (image, 288 x 20): from the call time to the last entry, filled up to now, a tick per entry and a marker for now, start and end time below.

### Changed

- "in 1319 min" now reads "in 21 h 59 min" from two hours on.
- The header text ends 64 px before the right edge; the schedule page shows six body rows to make room for the bar. Going to or from the schedule page is a page rebuild.

### Fixed

- Page set-up on the glasses: one `rebuildPageContainer`, then exactly one `createStartUpPageContainer`, later pages are rebuilds.

## [0.1.4] — 2026-10-13

### Changed

- Glasses rows use the full display width (56 instead of 46 characters): teleprompter, schedule, packing list and take notes.
- Take card: first row reads "Szene 1 · Shot A · WS" (scene, shot letter, size) instead of the bare "1 · A   WS"; header shows the position ("1 von 5") without repeating the scene.

## [0.1.3] — 2026-10-13

### Fixed

- Start language: an explicit choice is kept in the Even SDK store (the WebView's localStorage may not survive a relaunch); without one, a German-speaking Even account country (AT/DE/CH/LI/LU) starts the app in German, even when the WebView reports English.

## [0.1.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

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
