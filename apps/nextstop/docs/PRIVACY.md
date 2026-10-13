# NextStop — privacy

## Kurzfassung (Deutsch)

NextStop braucht deinen Standort, um die nächsten Haltestellen und während der
Fahrt die nächste Station zu finden. Dafür schickt die App einen Kartenausschnitt
rund um deine Position an Transitous (Standard) — oder, wenn du es einstellst,
an deinen eigenen MOTIS-Server bzw. über dein eigenes ÖBB-Zusatzprogramm an die
ÖBB. Der Standort wird nirgends gespeichert und nicht weitergegeben. Gespeichert
werden deine Einstellungen (Anbieter, Server-Adressen, Aktualisierungs-
intervall) und — nur wenn du sie selbst anlegst — deine Favoriten (Name und
Koordinaten) und das „Ziel jetzt“ für die Routenplanung, alles nur auf dem Handy.
Beim Suchen eines Orts und beim Planen einer Route gehen der Suchtext bzw. die
Koordinaten von Start und Ziel an Transitous (oder deinen MOTIS-Server). Kein
Konto, kein Tracking. Deinstallieren löscht alles.

## Short version

Your position is used to find nearby stops and is sent only to the departure
service you selected. It is never stored.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `g2-microphone` | Record the destination you say, only while you hold the touchpad on the destinations page | Sent to the Whisper server you set up; not stored, not kept in memory after the answer |
| `location` | Find the stops near you, and the next stop while riding | Not stored, not logged, not sent anywhere else |
| `network` (`https://api.transitous.org`) | Load stops, departures, connections and place search | Only the service you selected is contacted |

The public build allows exactly one origin. To point NextStop at your own MOTIS
server or your own ÖBB add-on on the real glasses, pack it with your own
`app.private.json` that lists that exact address (wildcards are blocked on the
glasses); the simulator is more lenient.

## Where your data goes

| Service | What it receives | When |
|---|---|---|
| **Transitous** (`api.transitous.org`, default) — a non-profit, provider-neutral MOTIS instance | A small map area (bounding box) around your position; then stop ids and trip ids. For route planning: the search text of a place, and the coordinates of your position and of the destination | Finding stops, loading departures, following a ride, searching a place, planning a route and refreshing its times |
| **OpenStreetMap routing server of FOSSGIS e.V.** (`valhalla1.openstreetmap.de`, or your own Valhalla) | The coordinates of the start and end of each walk of a guided journey; again from your position when you leave the route | Only while a guide is running |
| **Your own Whisper server** (optional, speech to text; there is no default in the public build) | The recording (WAV, up to 8 s) of what you say, language code | Only when you hold the touchpad on the destinations page |
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
| Favourite destinations (name, coordinates) and the destination of "now" — only if you add them | same, mirrored in the WebView localStorage | No (only the coordinates of one destination, when you plan a route to it) |

Settings are written through `setLocalStorage()` under `quietglass.nextstop.v1`,
destinations under `quietglass.nextstop.places.v1`. Positions, stops,
connections and departures are held **in memory only**; there is no trip
history.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login or device identifier.
- No advertising or third-party SDKs.
- No microphone, no camera.

## Removing your data

Uninstalling removes the stored settings and destinations. Single favourites can
be removed on the phone page under "Destinations". There is no location history
to delete.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle.
