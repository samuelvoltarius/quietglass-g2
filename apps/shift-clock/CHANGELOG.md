# Changelog

All notable changes to ShiftClock are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-25

First release.

### Added
- Hands-free time tracking: tap to choose a project and start, tap to stop.
- Project switching in a single move — the open entry closes and the next one
  opens at the same instant, leaving no gap and no state where the clock runs
  against nothing.
- The open entry is persisted as it happens, so a crash, a flat phone or a
  dropped Bluetooth link cannot lose tracked time.
- Leaving the app does not stop the clock; ending a shift is always explicit.
- Entries under 10 seconds are discarded as fumbles.
- The day total on the glasses includes the entry still running.
- Project picker opens on the most recently used project.
- CSV export with decimal hours alongside seconds, for invoicing.
- Phone companion for projects, today's entries, all-time totals and export.
- 40 unit tests covering start/stop/switch semantics, fumble rejection, daily
  filtering, CSV quoting, storage validation and the display.

### Known limitations
- Entries cannot be edited on the glasses.
- Overlapping entries are not supported.
- No billing-increment rounding; raw seconds are recorded.
- Not yet verified on physical hardware.
