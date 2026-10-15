# Star Glass — privacy

## Kurzfassung (Deutsch)

Star Glass spricht nur mit der Bridge, die du selbst neben N.I.N.A. betreibst
und am Handy einträgst (oder die ein privater Build mitbringt). Die App liest den
Aufnahmestatus und das neueste Vorschaubild und schickt „Sequenz anhalten /
fortsetzen“ nur nach Bestätigung – und nur, wenn die Bridge Steuern erlaubt.
Kein Konto, kein Tracking, kein Mikrofon.

Wetter-Warnungen (abschaltbar am Handy): Für die Vorhersage fragt die App
Open-Meteo (api.open-meteo.com) mit auf 2 Nachkommastellen (~1 km) gerundeten
Koordinaten. Woher sie kommen: aus N.I.N.A. nur, wenn du die Bridge mit
`STAR_SITE=1` startest (sonst gibt sie den Standort nicht weiter), sonst aus den
am Handy eingetragenen Koordinaten, sonst einmal pro Start der Handy-Standort.

## Short version

The app talks to the bridge you run and enter and - with weather warnings on
(default; can be turned off on the phone) - to Open-Meteo for the forecast,
with coordinates rounded to two decimals (~1 km). Nothing is collected. The
bridge forwards N.I.N.A.'s site coordinates only with `STAR_SITE=1`, rounded.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `network` (`http://*`, `https://*` and `https://api.open-meteo.com` in the public build; exact origins in a private build) | Read the status from **your** bridge every 4 s while the app is open, the newest frame preview when the image page is shown, and send stop/resume after you confirm. With weather warnings on: the forecast from Open-Meteo every 15 min (rounded coordinates only) | No other host is contacted. |
| `location` (optional) | The forecast for where you are, asked once per start - only when N.I.N.A. does not share its site and no coordinates are entered | Never stored, only rounded coordinates leave the phone (to Open-Meteo). |

No microphone, camera or album permission is declared or used.

## What is stored on the phone

| Data | Key | Leaves the device |
|---|---|---|
| Bridge address, swipe direction, weather limits and typed coordinates | `quietglass.starglass.v1` | No (coordinates go rounded to Open-Meteo) |
| Token (optional) | same | Only to your bridge, as an `Authorization` header — never in a URL, never logged, never shown in full |
| Language choice | `quietglass.locale` | No |

Readings and the preview picture are held in memory only.
