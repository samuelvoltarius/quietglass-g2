# Changelog

All notable changes to Babel Glass are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-25

First release.

### Added
- Live captions from the glasses microphone, streamed to a speech recognition
  server the user configures — self-hosted by default rather than by exception.
- Separate, swappable speech and translation providers, so either can be
  self-hosted independently.
- Reference speech server (examples/whisper-server.py), about eighty lines on
  faster-whisper, documenting the wire format by implementing it.
- LibreTranslate-compatible translation, optional.
- Caption buffer that keeps exactly one in-progress line and replaces it on each
  partial result, so revisions do not make the display stutter; only final
  results are committed to history.
- Four modes — Conversation, Lecture, Travel, Caption only — differing in rows,
  width and whether the original is shown beneath the translation.
- Scroll-back through the transcript, with new speech returning to the live edge.
- Automatic reconnection with exponential backoff, because a dropped connection
  cannot be fixed by a user with no hands free.
- Mock speech and translation providers for development without infrastructure,
  labelled MOCK on the glasses so their output cannot be mistaken for real.
- Microphone opens only on explicit tap; MIC shown for as long as it is open,
  with no setting to hide it.
- Tolerant reply parsing accepting several common server response shapes.
- 64 unit tests covering revision handling, history bounds, translation
  attachment, scroll-back, reply parsing, backoff, provider behaviour and
  configuration validation.

### Known limitations
- Latency is dominated by the configured server and model.
- No speaker separation.
- Not yet verified on physical hardware.
