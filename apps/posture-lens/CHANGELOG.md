# Changelog

All notable changes to PostureLens are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-25

First release.

### Added
- Head-angle monitoring from the G2 IMU, sampled at 500 ms.
- Calibration-relative measurement: the angle is taken against a pose the user
  calibrates, not against vertical. This avoids interpreting the SDK's
  undocumented axis orientation and unit, and measures against the user's own
  upright rather than an assumed one.
- Sustain threshold, so a glance down never triggers a warning; only a
  continuously held lean does.
- Vector smoothing (EMA) before judgement, so nods and steps do not register.
- Snooze window after a warning, so it does not become noise.
- Near-empty display while upright — good posture costs no attention.
- Countdown while leaning, giving the user a chance to correct before the
  warning fires.
- Session tally of time upright versus leaning, held in memory only.
- Calibration persisted on the phone so it survives a restart.
- IMU reporting re-enabled automatically after a glasses reconnect.
- Phone companion for thresholds, smoothing and calibration management.
- 48 unit tests covering vector maths, payload decoding, the warning state
  machine, time accounting, view composition and storage validation.

### Known limitations
- **Not verified on physical hardware.** IMU scale, noise and drift on a real
  G2 have not been measured by Quietglass; thresholds may need tuning.
- The simulator provides no head-motion data, so the measurement chain cannot
  be exercised end to end there.
- Forward tilt and sideways tilt are not yet distinguished.
