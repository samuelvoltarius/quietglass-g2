# Changelog

All notable changes to DecibelGuard are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-25

First release.

### Added
- Sound level from the glasses microphone: exact dBFS computed from raw
  little-endian s16 PCM, with an odd trailing byte ignored rather than misread.
- Noise dose accumulation using the level-and-duration model, with both the
  3 dB (EU) and 5 dB (OSHA) exchange rates and a configurable threshold below
  which sound does not accrue.
- Warning at 50% of the daily dose, not only once it is exceeded.
- Remaining permitted time at the current level.
- User-supplied calibration offset to approximate SPL, with uncalibrated
  readings marked `uncal.` on the glasses so a number is never mistaken for a
  measurement it is not.
- Dose accumulated over the wall-clock gap between audio blocks, so a dropped
  block does not silently shorten measured exposure.
- Microphone opens only on an explicit tap; `● MIC` is displayed for as long as
  it is open and cannot be hidden.
- Phone companion for calibration, dose rules and the live dBFS readout.
- 58 unit tests covering PCM decoding, dBFS conversion, the dose model,
  exchange rates, display escalation and storage validation.

### Known limitations
- **Not a certified sound level meter.** Uncalibrated microphone, user-supplied
  offset, no frequency weighting.
- No A-weighting, so readings over-report low-frequency energy relative to a
  dB(A) meter.
- No peak or impulse assessment.
- The dose resets when the app closes; no history is kept, by design.
- Not yet verified on physical hardware; the simulator provides no real audio.
