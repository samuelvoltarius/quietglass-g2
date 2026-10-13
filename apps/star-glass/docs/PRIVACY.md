# Star Glass — privacy

## Kurzfassung (Deutsch)

Star Glass spricht nur mit der Bridge, die du selbst neben N.I.N.A. betreibst
und am Handy einträgst (oder die ein privater Build mitbringt). Die App liest den
Aufnahmestatus und das neueste Vorschaubild und schickt „Sequenz anhalten /
fortsetzen“ nur nach Bestätigung – und nur, wenn die Bridge Steuern erlaubt.
Kein Konto, kein Tracking, kein Mikrofon, kein Standort. Die Bridge gibt die
Standortkoordinaten, die N.I.N.A. kennt, nicht weiter.

## Short version

The app talks only to the bridge you run and enter. Nothing else is contacted,
nothing is collected. The bridge never forwards the site coordinates N.I.N.A. knows.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `network` (`http://*`, `https://*` in the public build; one exact origin in a private build) | Read the status from **your** bridge every 4 s while the app is open, the newest frame preview when the image page is shown, and send stop/resume after you confirm | No other host is contacted. Without an address nothing is sent. |

No microphone, camera, album or location permission is declared or used.

## What is stored on the phone

| Data | Key | Leaves the device |
|---|---|---|
| Bridge address, swipe direction | `quietglass.starglass.v1` | No |
| Token (optional) | same | Only to your bridge, as an `Authorization` header — never in a URL, never logged, never shown in full |
| Language choice | `quietglass.locale` | No |

Readings and the preview picture are held in memory only.
