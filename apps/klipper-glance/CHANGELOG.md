# Changelog

## [0.2.1] — 2026-10-13

### Added

- Private builds carry the bridge address (`VITE_KLIPPER_URL`): nothing to type on the phone. A stored placeholder (loopback, example host) gives way to it once.

### Fixed

- The glasses listen before the first page is built.
- A command without an answer says "Ergebnis unklar – Status wird geprüft" (it may have run) and checks the printer at once.
- Leaving through the system stops polling; coming back rebuilds the page and polls at once.

### Changed

- Footers in one style (`Tippen = …`, `2× = Ende`); "Fortsetzen gesendet".

## [0.2.0] — 2026-10-13

### Added

- While a printer is online the HUD shows a progress ring (144 x 144 image) at the left with the percentage in large pixel digits, the file, layer, remaining time and speed beside it, and below them the nozzle temperature of the last five minutes as a curve (288 x 64 image) with nozzle and bed temperatures next to it. The ring is only resent when the percentage changes, the curve only with a new reading.
- Offline, control and setup screens keep the plain text page; changing between the two layouts is a page rebuild.
- `?demo=1&pct=73` starts the demo print at 73 % in the simulator.

### Fixed

- Page set-up on the glasses: one `rebuildPageContainer`, then exactly one `createStartUpPageContainer`; every later page is a rebuild.

## [0.1.4] — 2026-10-13

### Changed

- Glasses rows use the full display width (56 instead of 46 characters).
- Progress bar is 22 glyphs wide (was 20) so it fills the row next to the percentage.

## [0.1.3] — 2026-10-13

### Fixed

- Start language: an explicit choice is kept in the Even SDK store (the WebView's localStorage may not survive a relaunch); without one, a German-speaking Even account country (AT/DE/CH/LI/LU) starts the app in German, even when the WebView reports English.

## [0.1.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

All notable changes to Klipper Glance are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-10-07

First public release, brought over from a private printer HUD and rebuilt on
Quietglass conventions.

### Added
- Print status on the glasses: file, progress bar, layer, time left, nozzle and
  bed temperatures, speed and the printer's own message.
- Stale readings are marked in the header after 15 s.
- Optional control (pause, resume, cancel), offered only for the current state;
  every command needs a confirming second tap, a swipe drops it, and it lapses
  after 6 s.
- Phone page: bridge address and optional token (write-only), language, swipe
  inversion, printer state, whether control is allowed, http/mixed-content
  warning.
- German and English throughout, following the phone language.
- `?demo=1` with a simulated printer.
- Example bridge (`examples/klipper-bridge.mjs`) and mock Moonraker
  (`examples/mock-moonraker.mjs`).

### Changed (compared with the private version)
- No built-in addresses: the bridge is entered on the phone. The bridge binds to
  `127.0.0.1` by default and searches the machine's own private networks
  instead of a fixed subnet; the search runs in the background.
- Control needs `KL_ALLOW_CONTROL=1` and, beyond loopback, a `TOKEN`, compared
  in constant time. CORS answers preflights with or without a token.
- Double tap on the HUD asks the system before leaving (exit mode 1); on the
  control screen it returns to the HUD.
- The bridge speaks English field names and reason codes, so the app can word
  them in either language.
- One screen updated in place; requests time out after 6 s and never overlap.
