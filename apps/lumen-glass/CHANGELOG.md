# Changelog

All notable changes to Lumen Glass are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-25

First release.

### Added
- The LUMEN moth on the glasses, in five states matching LUMEN's own
  thresholds, drawn so the wings carry the state before any word is read.
- LUMEN's own wording for what the moth is doing, passed through rather than
  reinvented, so the glasses and the web app never disagree.
- The current quest with its actual instruction, not just its short name.
- Minutes until the next golden or blue hour — the one number that actually
  gets someone out the door.
- Photo capture through the phone camera, submitted straight to LUMEN as
  multipart/form-data on the same endpoint its own web form uses.
- The same action as a button in the phone companion, for when the phone is
  already in hand.
- Video quests are flagged on the display, because a still camera cannot
  answer them and finding that out after shooting is worse.
- Light bar and streak in the status line.
- Session cookie support for LUMEN in closed mode, sent as a header and never
  shown in full.
- CORS proxy and a documented three-line patch for LUMEN, either of which lets
  the browser hand LUMEN's answers to the app.
- 49 unit tests, using a status payload copied from a running LUMEN rather
  than invented.

### Verified against a live LUMEN
Field names were read from a running instance, not guessed. Two would have
been wrong: the light window is `naechstes_lichtfenster`, and a quest carries
both a short `titel` and the actual `aufgabe`.

### Known limitations
- LUMEN needs CORS headers or the included proxy; see examples/PATCH.md. The
  failure mode is misleading — "unreachable" while curl works fine — and
  `allow_origins=["*"]` does not fix it, because the app sends credentials.
- Video quests can be seen but not answered from the glasses.
- Feed, shop and series stay on the phone.
- Not yet verified on physical hardware.
