# Changelog

All notable changes to Babel Glass are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- OpenAI-compatible translation provider (vLLM, Ollama, LM Studio, llama.cpp
  server): strict prompt, temperature 0.1, timeout, optional bearer token,
  cleanup of quotes, preambles and reasoning blocks. Selectable next to
  LibreTranslate in the phone app; both configurations are kept.
- examples/translate-server.py: LibreTranslate-compatible server on Meta
  NLLB-200, covering Belarusian, which Argos/LibreTranslate does not.
- Language selects with Russian, Belarusian, Ukrainian, German, English and
  more, "auto" for the spoken language and a custom-code escape hatch.
  Free-text codes stored by 0.1.0 are normalised on load.
- "Show original as Latin transliteration" (Russian, Belarusian, Ukrainian;
  ASCII output), applied to the original line on the glasses only.
- With the spoken language on "auto", Whisper's detected language is passed
  to providers that need a concrete source (the LLM prompt).
- Translation failures are shown on the glasses (`translate: HTTP 400`)
  instead of being dropped silently.
- Captions already in the target language are not sent for translation.

### Fixed
- Phone app: changing the mode and then the swipe setting (or the reverse)
  silently reverted the first change, because each handler merged into the
  settings captured at render time.
- Phone app: a validation error re-rendered the form and discarded what had
  been typed.
- Wrapping counted UTF-16 units, so decomposed umlauts (u + U+0308) counted
  twice. Captions and translations are now NFC-normalised and wrapped by
  displayed characters.
- Changing the speech server or spoken language while listening had no effect
  until captioning was restarted; the connection is now reopened.
- whisper-server.py: Whisper's lazy segment generator was consumed on the
  event loop, blocking every connection while decoding; a region-tagged or
  unsupported language ("be-BY") made transcription raise and dropped the
  connection; a malformed text frame closed it. Replies keep non-ASCII text
  unescaped.

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
