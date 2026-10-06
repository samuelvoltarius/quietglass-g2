# Endurance HUD — privacy

## Kurzfassung (Deutsch)

Endurance HUD liest Trainingswerte (Tempo, Leistung, Puls, Kadenz, Distanz)
nur von deiner eigenen lokalen Bridge auf `127.0.0.1:8792`. Die App selbst
spricht mit keinem anderen Server, braucht kein Garmin-Konto und speichert
keinen Trainingsverlauf. Gespeichert werden nur die Bridge-Adresse, die
gewählte Sportart und die Sprache. Kein Tracking, kein Mikrofon, kein Standort.
Deinstallieren löscht alles.

## Short version

Endurance HUD reads live workout values from a bridge you run yourself and
from nowhere else. It keeps no history.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `network` (`http://127.0.0.1:8792`, `http://localhost:8792`) | Poll the local telemetry bridge every 2 s | The whitelist allows no other host |

## Where your data goes

Nowhere. The app only **reads** from the bridge; it sends nothing but a plain
`GET` for the latest values.

The bridge (`examples/telemetry-bridge.mjs`) is a small program you run
yourself. What feeds it — a Garmin Connect IQ data field, a bike computer, a
Cloudflare Worker or your own sensor gateway — is your choice and outside this
app. Endurance HUD never sees Garmin or other account credentials.

## Health-related data

Heart rate and power are health-adjacent. They are shown and then dropped: the
latest reading lives **in memory only**, and there is no workout log, no file
and no upload. Endurance HUD is not a medical device.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Bridge address | WebView storage of the Even app, on the phone | No |
| Chosen sport (run / bike / automatic) | same | No |
| Display language | same | No |

Keys: `endurance.endpoint`, `endurance.sport`, `quietglass.locale`.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login or device identifier.
- No advertising or third-party SDKs.
- No microphone, no camera, no location.

## Removing your data

Choose "Automatic" to forget the sport, and save the default address to forget
yours. Uninstalling removes everything.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle.
