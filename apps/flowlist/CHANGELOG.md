# Changelog

All notable changes to FlowList are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-25

First release.

### Added
- Hands-free checklist runner for Even Realities G2. One step on screen at a
  time, with position, section and progress always visible.
- Step kinds: normal, **optional** (skippable, excluded from progress),
  **critical** (requires a second tap to confirm) and **choice** (branches to
  another step).
- Branch-aware history: going back returns to the step you actually came from,
  not to the previous line in the list.
- Detail text on demand — hold to read, release to hide. Holding commits nothing.
- Markdown import: ordinary task lists work unchanged, with `(!)` and
  `(optional)` markers and indented detail lines.
- JSON pack format (`quietglass/flowlist@1`) for branching and sharing, with
  round-trip export. Unknown fields are ignored so newer packs still load.
- Dangling `goto` targets are reported on import and fall through in list order
  at runtime, so a broken pack cannot strand a run.
- Sample checklist installed on first run, demonstrating every feature.
- R1 ring support; the ring is recognised as a distinct input source.
- Swipe inversion setting for the reported hardware/simulator difference.
- Phone companion for writing, selecting, exporting and removing checklists.
- Redraw suppression: the display is written only when the view actually changed.
- Automatic page rebuild after a glasses reconnect.
- 79 unit tests covering parsing, run logic, branching, view composition,
  gesture decoding and dispatch.

### Fixed
- **Taps were ignored entirely.** Verified in the simulator: a tap arrives as
  `{"sysEvent":{"eventSource":1}}` with **no `eventType` field**, because
  proto3 omits fields holding their default value and `CLICK_EVENT` is `0`.
  The decoder treated the absence as an unknown gesture. An absent event type
  now resolves to CLICK, with a regression test using the exact payload.

### Known limitations
- No editing on the glasses (no keyboard); checklists are written on the phone.
- Voice commands are not implemented in 0.1.0. See README, "Roadmap".
- Real-hardware swipe direction has not yet been measured by Quietglass.
