# RainLens — privacy

## Kurzfassung (Deutsch)

RainLens holt die Wettervorhersage bei Open-Meteo. Dafür werden die
Koordinaten des Ortes gesendet, für den du das Wetter sehen willst — dein
aktueller Standort (wenn erlaubt), ein gesuchter Ort oder von dir eingegebene
Koordinaten. Ortsnamen, die du suchst, gehen an die Ortssuche von Open-Meteo
(Daten von GeoNames). Ein aktueller Standort wird nicht gespeichert; gespeichert
werden nur ein gewählter Ort oder eingegebene Koordinaten und die Sprache. Kein
Konto, kein Tracking. Deinstallieren löscht alles.

## Short version

RainLens sends the coordinates of the place you want weather for to Open-Meteo,
and place names you search for to Open-Meteo's geocoder. Nothing else leaves the
phone, and your current position is never stored.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `location` (optional) | Show the weather where you are | Not stored, not logged, sent only as forecast coordinates |
| `network` (`https://api.open-meteo.com`, `https://geocoding-api.open-meteo.com`) | Load the forecast; look up place names you type | The whitelist allows no other host |

Location is optional: you can type a place or enter coordinates instead.

## Where your data goes

| Service | What it receives | When |
|---|---|---|
| **Open-Meteo forecast API** (`api.open-meteo.com`) | Latitude and longitude of the chosen place, plus the requested weather fields | Each refresh (start, tap, or a changed place) |
| **Open-Meteo geocoding API** (`geocoding-api.open-meteo.com`), place names from **GeoNames** | The text you typed into the place search and the display language | Only when you search |

Open-Meteo is used without an API key or account; its own privacy policy
applies to those requests. Weather data: Open-Meteo.com (CC BY 4.0).

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Location mode (phone / place / coordinates) | WebView storage of the Even app, on the phone | No |
| A place you picked from search (name and coordinates) | same | Only its coordinates, to Open-Meteo |
| Coordinates you typed | same | Only to Open-Meteo |
| Display language | same | No |

Keys: `rainlens.mode`, `rainlens.place`, `rainlens.lat`, `rainlens.lon`,
`rainlens.auto` (older installs), `quietglass.locale`.

The phone's current position is **never stored**; it is asked for at refresh
time and used once. The forecast is held in memory only.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login or device identifier.
- No advertising or third-party SDKs.
- No microphone, no camera.

## Removing your data

Switch back to "phone location" to stop using a saved place. Uninstalling
removes everything.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle.
