# Changelog

All notable changes to Status Glass are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-09-25

### Added
- **Actions.** A source may offer things to trigger from the glasses; sources
  remain read-only by default and must opt in by listing them.
- Actions live on a separate screen reached by holding the temple pad, so a
  stray tap while glancing at the dashboard can never trigger anything.
- Two-tap confirmation for actions the source marks as consequential. The
  source decides, because only it knows whether an action dims a lamp or
  unlocks a door. Moving the selection cancels a pending confirmation, so the
  tap after a swipe cannot run what was highlighted before it.
- Action ids are sent in the request body rather than the path, so they need no
  escaping and do not appear in server log lines.
- Duplicate and id-less actions are dropped with a warning; a duplicate would
  run the wrong thing.
- **Home Assistant adapter** in examples/: readings and control, configured
  with two lists. The Home Assistant token stays in the adapter and never
  reaches the glasses, and the action list is an allow-list — unknown ids are
  refused and a client cannot smuggle in its own service call. Verified against
  a stand-in Home Assistant, both success and both refusal paths.
- 87 unit tests (was 63).

## [0.1.0] — 2026-09-25

First release.

### Added
- An open JSON protocol small enough to emit from a shell script, documented in
  docs/PROTOCOL.md, with numeric metrics, explicit states, thresholds and an
  inverted comparison for metrics where low is bad.
- Dependency-free reference server in examples/, about a hundred lines, verified
  serving live values.
- Defensive parsing: a source returning rubbish degrades to "unknown" and never
  takes the dashboard down. Missing ids and labels are generated; metrics with
  neither value nor state are dropped with a warning.
- A healthy dashboard renders a single line; the display grows only in
  proportion to what is wrong, worst first.
- Unreachable and stale sources are reported as "unknown", never as healthy —
  the property that makes monitoring trustworthy, covered by explicit tests.
- Acknowledgement sinks a known problem to the bottom of the list without
  hiding it, and is cleared automatically when the metric recovers.
- Per-source polling timers with exponential backoff to a five-minute ceiling,
  so one dead host neither slows the others nor gets hammered.
- Bearer tokens sent as headers, never in URLs, never logged, and never shown
  in full in the phone app.
- Plain http permitted for LAN sources but marked as unencrypted.
- 63 unit tests covering protocol parsing, threshold logic, severity ordering,
  staleness, acknowledgement lifecycle, fetch behaviour, backoff and storage.

### Known limitations
- WebSocket push is specified but not implemented; polling only in 0.1.0.
- No history or graphs.
- Acknowledgements are not persisted across restarts.
- Not yet verified on physical hardware.
