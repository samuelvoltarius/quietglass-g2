# Klipper Glance — privacy

## Kurzfassung (Deutsch)

Klipper Glance spricht nur mit der Bridge, die du selbst betreibst und am Handy
einträgst. Die App liest den Druckstatus und schickt Pause, Weiter oder Abbruch
nur nach zweifacher Bestätigung – und nur, wenn die Bridge Steuern erlaubt.
Kein Konto, kein Tracking, kein Mikrofon, kein Standort.

## Short version

The app talks only to the bridge you run and enter. Nothing else is contacted,
nothing is collected.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `network` (`http://*`, `https://*`) | Read the printer status from **your** bridge every 5 s while the app is open, and send pause/resume/cancel after you confirm twice | No other host is contacted. The wildcard exists only because the address is yours to choose. Without an address nothing is sent. |

No microphone, camera, album or location permission is declared or used.

## What is stored on the phone

| Data | Key | Leaves the device |
|---|---|---|
| Bridge address, swipe direction | `quietglass.klipperglance.v1` | No |
| Token (optional) | same | Only to your bridge, as an `Authorization` header — never in a URL, never logged, never shown in full |
| Language choice | `quietglass.locale` (browser storage) | No |

Printer readings are held in memory only. No history is written.

## The bridge

The example bridge keeps nothing on disk. It contacts only your printer's
Moonraker API: at the address you set, or — if none is set — by probing port
7125 on the private networks of the machine it runs on. It binds to
`127.0.0.1` by default; control is off unless `KL_ALLOW_CONTROL=1`, and beyond
loopback it also requires a `TOKEN`.

## What is not collected

- No analytics, telemetry or crash reporting.
- No account, login or device identifier.
- No advertising or third-party SDKs.

## Removing your data

Clear the bridge address on the phone and uninstall the app to remove
everything.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle. The bridge and the mock printer
use only the Node.js standard library.
