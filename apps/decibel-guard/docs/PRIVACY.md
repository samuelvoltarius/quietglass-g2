# DecibelGuard — privacy

## Kurzfassung (Deutsch)

DecibelGuard öffnet das Mikrofon der Brille nur nach deinem Tippen; solange
es offen ist, zeigt die Brille **● MIC**. Aus jedem Tonblock wird nur ein
Lautstärkewert berechnet, danach wird der Ton verworfen — nichts wird
aufgenommen, gespeichert oder gesendet. Die App hat keinen Netzwerk-Code.
Gespeichert sind nur Kalibrierung und Grenzwerte. Kein Tracking. Deinstallieren
löscht alles.

## Short version

No audio is recorded. No level history is kept. Nothing leaves the phone.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `g2-microphone` | Measure the sound level after you tap to start | The audio is reduced to one number per block and discarded; nothing is recorded |

`app.json` requests no network, location or camera permission.

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

Written through `setLocalStorage()` under `quietglass.decibelguard.v1`.

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

## Removing your data

Uninstalling removes the calibration and thresholds. Level readings and the
dose are never stored, so there is nothing else to delete.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle.
