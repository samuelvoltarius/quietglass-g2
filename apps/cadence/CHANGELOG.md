# Changelog

All notable changes to Cadence are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-25

First release.

### Added
- Visual metronome for the G2: a row of markers, one per beat, with the
  downbeat drawn in its own shape so the top of the bar is identifiable
  without counting.
- Position derived from elapsed time on every redraw rather than accumulated
  per tick, so a late or dropped frame makes the display late but never wrong.
  A test asserts that sampling more often does not change the result.
- Redraws scheduled onto the next beat boundary instead of polled at a fixed
  rate, which keeps BLE traffic proportional to the tempo.
- "Downbeat only" marker mode for fast tempos, where per-beat marking over
  Bluetooth stops being readable.
- Time signatures including 3/4, 6/8, 5/4 and 7/8.
- Tap tempo, ignoring stale gaps from an abandoned attempt.
- Practice log: what was practised, at what tempo, for how long. Totals per
  item, best tempo per item, today's total, CSV export.
- Sessions under 10 seconds are not recorded; a best tempo needs 30 seconds at
  that speed, so a brief burst cannot inflate the record.
- Stored log is bounded, so per-app storage cannot grow without limit.
- Phone companion for tempo, signature, practice items and the log.
- 62 unit tests covering timing, drift resistance, tap tempo, log summaries,
  CSV quoting, storage validation and the beat display.

### Known limitations
- **Cadence makes no sound.** The G2 has no speaker; the beat is visual only.
- Display updates travel over Bluetooth and their jitter is outside the app's
  control. At fast tempos use "downbeat only". Cadence is a practice aid, not
  a timing reference.
- Not yet verified on physical hardware.
