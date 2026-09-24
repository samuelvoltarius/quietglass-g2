# DecibelGuard — privacy

## Short version

No audio is recorded. No level history is kept. Nothing leaves the phone.

## The microphone

DecibelGuard opens the glasses microphone **only when you tap to start**. It
never starts on its own, never on launch, never on a schedule.

While the microphone is open the glasses display **● MIC**. This indicator is
not configurable and there is no code path that measures without it.

## What happens to the audio

Each block of PCM is used to compute one number — the root-mean-square level —
and is then discarded. The audio is never written to storage, never buffered
beyond the block being processed, and never transmitted. DecibelGuard has no
network code at all.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Calibration offset | Even app per-app storage, on the phone | No |
| Dose thresholds | same | No |

Written through `setLocalStorage()` under `aignerlabs.decibelguard.v1`.

## What is deliberately not stored

The accumulated dose and the level readings exist **in memory only**. Closing
the app discards them.

This is a design decision. A timeline of ambient loudness is a timeline of
where a person was and what they were doing — a concert, a workshop, a
nightclub, a quiet office. There is no file recording that, so there is nothing
to leak or hand over.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login or device identifier.
- No advertising or third-party SDKs.
- No location.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle.
