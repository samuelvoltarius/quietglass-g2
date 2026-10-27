# TV Glance — privacy

## Kurzfassung (Deutsch)

TV Glance spricht **nur** mit dem Home Assistant oder der TV-Glance-Bridge, deren Adresse du am Handy
einträgst. Es liest den Zustand deines Fernsehers (an/aus, App, Titel, Quelle, Lautstärke) und sendet
nur die Befehle, die du auf der Brille auslöst (Play/Pause, Lautstärke, Ton, Ein/Aus, Quelle/App,
Steuerkreuz). Kein Konto, kein Tracking, kein Mikrofon, kein Standort, kein Quietglass-Server.
Das Zugangstoken bleibt im Speicher der App auf dem Handy, wird nie protokolliert und nie vollständig
angezeigt. Ohne Einrichtung läuft ein Demo-Fernseher ganz ohne Netzwerk.

## Short version

The app talks only to the Home Assistant or TV Glance bridge you enter. It reads your TV's state and
sends only the commands you trigger on the glasses. Nothing else is contacted, nothing is collected.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `network` (`http://*`, `https://*` in the public build, because the address is typed by you; one exact origin in a private build) | Home Assistant: one WebSocket to `<address>/api/websocket` while the app is open (token only in its `auth` message; `subscribe_entities` for the TV and its remote, `get_states` only when you tap "Load", `call_service` when you trigger a command); REST (`/api/states/…`, `/api/services/…`) only as a fallback when the WebSocket cannot be reached. Bridge: `GET /state`, `POST /key`, `/app`, `/power`. | No other host is contacted. Without an address nothing is sent (demo TV). |

## What is stored on the phone

| Data | Key | Leaves the device |
|---|---|---|
| Connection type, Home Assistant / bridge address, chosen `media_player` and `remote` entity, app list, swipe direction | `quietglass.tvglance.v1` | No |
| Home Assistant long-lived access token | same | Only to your Home Assistant: in the WebSocket `auth` message (REST fallback: `Authorization` header); never logged, never shown in full, never built into the app |
| Bridge token (optional) | same | Only to your bridge, in the `Authorization` header; never logged, never shown in full |
| Language choice, last phone tab | `quietglass.locale`, `quietglass.tvglance.tab` | No |

The TV's state is held in memory only. Delete the token on the phone page (*Delete token*) or revoke
it in Home Assistant (*Profile → Security*) at any time.

## The bridge

`examples/androidtv-bridge.py` runs on your own machine. It keeps the pairing certificate in
`TV_CERT_DIR`, logs only method, path and time (never headers or tokens) and talks only to your TV.
