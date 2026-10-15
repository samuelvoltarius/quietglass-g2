# PostureLens — privacy

## Kurzfassung (Deutsch)

PostureLens nutzt nur den Bewegungssensor (IMU) der Brille, hat keinen
Netzwerk-Code und speichert keinen Verlauf deiner Haltung. Gespeichert sind nur
die kalibrierte Ausgangslage und deine Einstellungen. Kein Mikrofon, keine
Kamera, kein Standort, kein Tracking. Deinstallieren löscht alles.

## Short version

PostureLens has no network code, and it keeps no history of how you sat.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Your calibrated upright direction | Even app per-app storage, on the phone | No |
| Thresholds and display settings | same | No |

Written through `setLocalStorage()` under the single key
`quietglass.posturelens.v1`.

## What is deliberately not stored

The tally of time spent upright versus leaning exists **in memory only**, for
the current session. Closing the app discards it.

This is a design decision, not an omission. Posture over time is health-adjacent
data. There is no file recording how you sat today, so there is nothing to leak,
subpoena, or sell.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login or device identifier.
- No advertising or third-party SDKs.

## Sensors

PostureLens uses the **IMU** (head motion) only. It does **not** use the
microphone, the camera or your location, and `app.json` requests no permissions
for them.

IMU samples are processed in memory and never written to storage — only the
single calibrated reference direction is saved.

The **sensor test** (0.5.0, "More" tab or hold on the glasses) can record 20 s
of raw samples when you press "Record 20 s". The recording stays in the page's
memory; it leaves the phone only if you download or copy the CSV yourself, and
it is gone when the test ends or the app closes.

## Removing your data

Uninstalling removes the per-app storage, and with it the calibration and
settings. "Clear calibration" in the phone companion removes the reference
without uninstalling.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools (Vite, TypeScript, Vitest) ship no code into the bundle.
