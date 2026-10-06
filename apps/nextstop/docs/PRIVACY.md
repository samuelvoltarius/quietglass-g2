# NextStop — privacy

## Kurzfassung (Deutsch)

NextStop braucht deinen Standort, um die nächsten Haltestellen und während der
Fahrt die nächste Station zu finden. Dafür schickt die App einen Kartenausschnitt
rund um deine Position an Transitous (Standard) — oder, wenn du es einstellst,
an deinen eigenen MOTIS-Server bzw. über dein eigenes ÖBB-Zusatzprogramm an die
ÖBB. Der Standort wird nirgends gespeichert und nicht weitergegeben. Gespeichert
werden nur deine Einstellungen (Anbieter, Server-Adressen, Aktualisierungs-
intervall). Kein Konto, kein Tracking. Deinstallieren löscht alles.

## Short version

Your position is used to find nearby stops and is sent only to the departure
service you selected. It is never stored.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `location` | Find the stops near you, and the next stop while riding | Not stored, not logged, not sent anywhere else |
| `network` (`https://api.transitous.org`, plus `http`/`https` for your own server) | Load stops and departures | Only the service you selected is contacted |

The `http://*` / `https://*` entries exist only so you can point NextStop at
your own MOTIS server or your own ÖBB add-on on your network.

## Where your data goes

| Service | What it receives | When |
|---|---|---|
| **Transitous** (`api.transitous.org`, default) — a non-profit, provider-neutral MOTIS instance | A small map area (bounding box) around your position; then stop ids and trip ids | Finding stops, loading departures, following a ride |
| **Your own MOTIS server** (optional) | The same, instead of Transitous | Only if you enter its address |
| **ÖBB** (`fahrplan.oebb.at`, optional) via your own proxy (`examples/oebb-cors-proxy.mjs`) | Your coordinates (search ring of 1.5 km), stop and journey ids | Only if you select ÖBB and run the proxy |

Each service's own privacy policy applies to those requests. NextStop adds no
identifier, account or token of its own.

## Location

- Location is requested from the Even app only while NextStop is open.
- During a ride, position updates are used to work out the next stop and are
  then discarded. There is no trip history.
- Location updates are stopped when you leave the app.
- Without location permission, NextStop says so and shows nothing else; it does
  not fall back to IP-based location.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Selected service (Transitous / MOTIS / ÖBB) | Even app per-app storage, on the phone | No |
| Your MOTIS and ÖBB proxy addresses | same | No |
| Refresh interval | same | No |

Written through `setLocalStorage()` under `quietglass.nextstop.v1`. Positions,
stops and departures are held **in memory only**.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login or device identifier.
- No advertising or third-party SDKs.
- No microphone, no camera.

## Removing your data

Uninstalling removes the stored settings. There is no location history to
delete.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle.
