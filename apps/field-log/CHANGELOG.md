# Changelog

All notable changes to FieldLog are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-25

First release.

### Added
- Hands-free inspection logging: dictate an entry, confirm the transcript,
  carry on.
- Every transcript is shown for confirmation before it is filed. An inspection
  report is a document someone acts on, so a misheard entry must be catchable
  at the moment it is made.
- Severity per entry (note / minor / major), cycled with a swipe.
- Sections set on the phone; entries inherit the current one so the report
  groups itself.
- Photo attachment through the SDK's phone-camera picker, attached to the entry
  just dictated. The glasses have no camera.
- Speech recognition against a server the user configures, using the same wire
  format as Babel Glass so one Whisper instance serves both. A mock runs when
  none is configured, labelled MOCK on the glasses.
- Markdown export grouped by section with majors in bold, a variant with photos
  embedded, and CSV.
- Photos referenced by size rather than embedded by default, because a report
  full of inline base64 is neither readable nor emailable.
- Stored-size estimate with a warning before per-app storage becomes a problem.
- Phone companion for starting and finishing inspections, reviewing and editing
  entries, and exporting.
- 44 unit tests covering entry building, section inheritance, attachment,
  severity changes, export formats and display phases.

### Known limitations
- Photos live in per-app storage, which is not a filesystem; export and remove
  old inspections.
- Entry text cannot be edited on the glasses.
- One inspection open at a time, deliberately.
- Not yet verified on physical hardware.
