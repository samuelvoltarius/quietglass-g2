# Cadence — privacy

## Short version

Cadence has no network code. Your practice log stays on your phone.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Tempo and time signature | Even app per-app storage, on the phone | No |
| Your practice items | same | No |
| Practice session log | same | No |

Written through `setLocalStorage()` under the single key
`aignerlabs.cadence.v1`. The log is bounded to the most recent 500 sessions.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login or device identifier.
- No advertising or third-party SDKs.

## Sensors

Cadence uses **no sensors at all**. It does not use the microphone — including
for tap tempo, which is driven by taps on the touchpad, not by listening.
`app.json` requests no permissions.

## Export

CSV export hands the file to your phone's own share sheet. Cadence does not
upload it and has no server component.

## Removing your data

"Clear log" in the phone companion erases the practice history. Uninstalling
removes everything.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle.
