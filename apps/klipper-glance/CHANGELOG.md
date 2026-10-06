# Changelog

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
