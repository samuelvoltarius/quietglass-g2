# Changelog

All notable changes to PromptFlow are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-24

First release.

### Added
- Teleprompter for Even Realities G2 with a fixed three-zone layout
  (section header, script body, status line).
- Four reading modes — Presenter, Speech, Video, Notes — each with its own
  speed and line-count preset.
- Word-based pacing: speed is held in words per minute and stays accurate
  regardless of how the text wraps.
- Markdown and plain-text scripts. `# Heading` becomes the title,
  `## Heading` opens a section; emphasis is stripped, list items are kept
  as separate beats.
- Glasses controls: tap to start/pause, swipe to move through the script
  while paused or to trim speed while reading, long press to jump a section,
  double tap to leave.
- R1 ring support — the ring is recognised as a distinct input source and
  behaves identically to the temple pads.
- Swipe inversion setting, for the reported direction difference between the
  simulator and real hardware.
- Phone companion for pasting scripts, managing a script library and
  adjusting speed, line count, line width and cursor display.
- Redraw suppression: the display is only written when the rendered view
  actually changes.
- Automatic page rebuild after a glasses reconnect.
- 87 unit tests across parsing, layout, pacing, gestures, dispatch, view
  composition and storage.

### Known limitations
- Voice-follow mode is not implemented in 0.1.0. See README, "Roadmap".
- Real-hardware behaviour (swipe direction, page rebuild cost) is documented
  from community reports and has not yet been measured by Aigner Labs.
