# TV Glance

**Quietglass** · A calm TV remote on the Even G2 — play/pause, volume, apps & inputs and a D-pad,
through **your own Home Assistant** or a **small Android TV bridge**. No Quietglass server, no account.

> **Auf Deutsch, kurz:** TV Glance ist eine ruhige Fernbedienung für die Brille. Die Startseite hat
> höchstens drei Einträge: **Fernbedienung** (Bild mit Fernseher, Lautstärkebalken, was läuft;
> Tippen = Play/Pause, Wischen hoch/runter = lauter/leiser, 2× = zurück), **Apps & Eingang**
> (Ein/Aus, Ton aus/an, Quellen und Apps) und **Steuerkreuz** (Hoch/Runter/Links/Rechts/OK/Zurück/Home,
> nur wenn dein Fernseher das kann). Ausschalten fragt nach: ein zweites Tippen innerhalb von 4 s.
> Halten wird nirgends gebraucht.
>
> **Zwei Wege zum Fernseher, am Handy wählbar:**
> 1. **Home Assistant** – nur Adresse (http im Heimnetz, https/Nabu Casa von unterwegs; ws/wss geht
>    auch) und ein *langlebiges Zugangstoken* eintragen, unter „Fernseher“ den `media_player` wählen.
>    TV Glance spricht über die **WebSocket-API** – in Home Assistant ist **nichts** einzustellen
>    (keine `configuration.yaml`, kein CORS). Für das Steuerkreuz braucht es eine `remote.*`-Entität
>    (Integration „Android TV Remote“).
> 2. **Android-TV-Bridge** – `examples/androidtv-bridge.py` auf einem Rechner im Heimnetz
>    (`pip install androidtvremote2`, einmal `--pair` mit dem Code vom Fernseher), dann deren Adresse
>    in TV Glance eintragen.
>
> **Mehrere Geräte (ab 0.2.0):** Mit Home Assistant kannst du mehrere Geräte anlegen (z. B. Fernseher und
> Beamer) und auf der Brille umschalten. Am Handy: *Fernseher*-Tab → **Media-Player laden** → Geräte antippen
> (nochmal tippen = entfernen), Namen ändern (Standard: der Home-Assistant-Name), Steuerkreuz-Entität wählen.
> Auf der Brille: Startseite → Zeile **Gerät: Name (1/2)** wählen (wischen) und **tippen** = nächstes Gerät
> (reihum). Die Zeile gibt es nur bei zwei oder mehr Geräten; der Gerätename steht in der Kopfzeile. Ist ein
> Gerät `unavailable` (Beamer im Standby), steht dort „nicht verfügbar“ und es wird nichts gesendet. Der alte
> Einzel-Fernseher wird beim ersten Start automatisch Gerät 1. Weiterhin nur Tippen, 2× und Wischen – kein Halten.
>
> Ohne Einrichtung läuft ein Demo-Fernseher (mit **DEMO** beschriftet).

Use `?demo=1` on the development URL for the demo TV, `&page=remote|apps|dpad` to open a page
directly (simulator screenshots), `&lang=de|en` to force the language.

---

## On the glasses (QUS v1)

| Page | Shows | Gestures |
|---|---|---|
| Start | `TV Glance · ● live`, at most three entries: Remote (with `on · Netflix · 18`), Apps & input, D-pad (only when the backend can send it); with two or more devices a fourth row `Device: Projector (2/2)` and the device name in the header | Tap = open (on the Device row: next device) · Swipe = choose · 2× = exit dialog |
| Remote (cockpit image, 4 tiles) | left: a TV showing play / pause / ready / off and the volume bar; right: the app big, the title below, cells State · Sound · Source | Tap = play/pause (while off: switch on) · Swipe up/down = volume +/− · 2× = back |
| Apps & input (list, ≤ 5 rows) | Switch on/off, Mute/Unmute, then the TV's sources, the bridge's apps and your app list | Tap = send · Swipe = choose · 2× = back |
| D-pad (list) | Up, Down, Left, Right, OK, Back, Home | Tap = send · Swipe = choose · 2× = back |

### Several devices (0.2.0)

With the Home Assistant backend you can set up up to six devices (a TV, a projector …), each a
`media_player.*` with an optional `remote.*` for the D-pad and a name.

- **Phone, *TV* tab:** *Load media players* lists what Home Assistant has; tap a player to add it as a device
  (tap again to remove it). The remote with the same object id (`media_player.x` → `remote.x`) is paired like
  before; change it, or rename the device, in the device card. Default name = the player's friendly name.
- **Glasses:** the start page gets a last row `Device: <name> (n/m)` **only when two or more devices exist**.
  Swipe to it, **tap** = switch to the next device (wraps around, 1 → 2 → 1 …). The active device name stands
  in the header of every page and in the remote's caption; the choice is remembered. No hold, no extra
  gesture: tap, swipe and 2× only.
- **Live state:** one WebSocket subscribes to *all* configured devices (`subscribe_entities`), so the device you
  switch to is already up to date; commands (play/pause, volume, mute, power, input/app, D-pad) go to the active
  device's `media_player.*` / `remote.*` only.
- **Unavailable devices** (Home Assistant state `unavailable`, e.g. a projector asleep): the glasses show
  `not available` / `UNAVAILABLE` plus the name instead of an error, nothing is sent, and the phone banner says so.
  As soon as the device is back, the live update continues.
- **Settings migration:** the single TV of 0.1.x (`entityId` + `remoteId`) becomes device 1 automatically; the
  Android TV bridge is one device and ignores the list.

German footers on the glasses:

- Start: `Tippen = öffnen · Wischen = wählen · 2× = Ende` (on the Device row: `Tippen = Gerät wechseln · …`)
- Remote: `Tippen = Play/Pause · Wischen = Lautstärke · 2× = zurück` (TV off: `Tippen = TV an · …`)
- Lists: `Tippen = senden · Wischen = wählen · 2× = zurück`
- Switch-off armed: `Nochmal tippen = ausschalten · Wischen/2× = abbrechen` plus the row `Ausschalten? Nochmal tippen (4 s)`

**Volume swipes are debounced:** each swipe moves the bar at once; the steps are sent together
350 ms after the last swipe (net up minus down, at most 5 per burst). The glasses' own gesture
filter already folds the 5–10 scroll events of one physical swipe into one.

**No hold anywhere** (a hold from the temple never reaches an app; only the R1 ring delivers it),
no side menu, no status codes on the glasses (the phone shows them). The exit dialog follows the
measured hardware order (sysEvent 4 = dialog up, draw nothing; 5 after "No" = page back the way of the
first one; the next 2× opens the dialog again).

With Home Assistant the TV's state arrives live over the WebSocket subscription; the screen is also
refreshed every 5 s while the app is open and 0.7 s after every command.

## Backend 1: Home Assistant (WebSocket API — no setup in Home Assistant)

You only enter the **address** and a **long-lived access token**. TV Glance opens one WebSocket to
`<address>/api/websocket` (`ws:` for an `http` address, `wss:` for `https`; you may also type
`ws://…`/`wss://…` or paste the full `…/api/websocket`). A Nabu Casa remote address
(`https://<id>.ui.nabu.casa`) works like any other https address.

| Message | For |
|---|---|
| `{"type":"auth","access_token":…}` | the token, only in this first message (never in the address, never logged) |
| `{"type":"subscribe_entities","entity_ids":[media_player, remote, …]}` | the state of every configured device, live (compressed diffs): on/off (`off`/`standby` = off, `unavailable` = not available), `app_name`, `media_title`, `source`, `volume_level`, `is_volume_muted`, `source_list` |
| `{"type":"get_states"}` | phone: list `media_player.*` (the TV) and `remote.*` (D-pad) to choose from |
| `call_service` `media_player.media_play_pause` | tap in the remote |
| `call_service` `media_player.volume_up` / `volume_down` | swipes (one call per step) |
| `call_service` `media_player.volume_mute` `{is_volume_muted}` | Mute / Unmute |
| `call_service` `media_player.turn_on` / `turn_off` | Switch on / off (off only after the second tap) |
| `call_service` `media_player.select_source` `{source}` | an entry of the TV's `source_list` |
| `call_service` `media_player.play_media` `{media_content_type: "app", media_content_id}` | an entry of your app list that is not in `source_list` (how the *Android TV Remote* integration starts apps) |
| `call_service` `remote.send_command` `{command}` → `remote.…` | D-pad: `DPAD_UP`, `DPAD_DOWN`, `DPAD_LEFT`, `DPAD_RIGHT`, `DPAD_CENTER`, `BACK`, `HOME` |

Setup:

1. In Home Assistant: **Profile → Security → Long-lived access tokens → Create token**. A dedicated
   (non-admin) user for TV Glance is a good idea.
2. Phone page → *Settings* → Connection **Home Assistant** → address + token → Save.
3. *TV* tab → **Load media players** → tap your TV (and, if you like, more devices such as a projector). The
   `remote.*` entity with the same name is picked for the D-pad automatically (or choose it / "none"). Without a
   remote entity the D-pad entry is hidden for that device.
4. Optional: *TV* tab → app list, one per line, `Name=id` (e.g. `Kodi=org.xbmc.kodi`).

Plain `http`/`ws` works only in your home network (the phone must reach the address); use `https`
(Nabu Casa or your own certificate) from outside. A self-signed certificate will usually fail in the WebView.

### Why no CORS entry is needed (and what Home Assistant checks)

Browsers apply CORS to `fetch`/XHR, not to WebSocket connections: there is no preflight, and the
server decides alone whether to accept a connection. Reading Home Assistant's source
(`homeassistant/components/websocket_api/http.py` and `auth.py`, dev branch, read 2026-10-27):

- `WebsocketAPIView` serves `/api/websocket` with `requires_auth = False` and no CORS settings;
  the `WebSocketResponse` is created with only a heartbeat and decoding options.
- Neither the connection handler nor the auth phase reads the `Origin` header. Access is decided only
  by the first message (`auth` with `access_token`); a wrong token gets `auth_invalid`, is counted as a
  failed login (the http ban mechanism) and the connection is closed.
- `http/cors.py` only adds CORS headers for configured origins; it does not reject requests.

So Home Assistant does not check the origin of WebSocket connections, and address + token is enough.
This is a reading of the source plus tests against a fake socket — **not yet verified against a live
Home Assistant from the Even app**. Proxies in front of Home Assistant must pass WebSocket upgrades
(Nabu Casa and the usual nginx/Caddy setups for Home Assistant do).

### Troubleshooting: REST fallback and `cors_allowed_origins`

Only when the WebSocket cannot be reached at all (connection refused or timed out — e.g. a proxy that
blocks upgrades) does TV Glance read the TV over the REST API (`GET /api/states/<media_player>`,
`POST /api/services/…`) and send commands that way; it tries the WebSocket again after a minute.
A refused token never falls back. REST sends the token in an `Authorization` header, so the WebView
makes a CORS preflight, and Home Assistant answers it only for origins listed in
`http: cors_allowed_origins` (none by default). The phone page shows the page's real origin
(`location.origin`) under *Settings → Home Assistant → Troubleshooting*, ready to copy:

```yaml
# configuration.yaml — only needed for the REST fallback
http:
  cors_allowed_origins:
    - http://127.0.0.1:12345   # <- exactly what TV Glance shows on the phone page
```

As far as we know the Even app serves plugin pages from a local web server inside the app
(`http://127.0.0.1:<port>`); the exact origin and whether the port is stable is not verified, which
is why the app shows it instead of guessing. Do not use `"*"`.

### Private builds: preset address

`VITE_HA_URL=<address> npm run build` presets the Home Assistant address (Home Assistant is then
preselected; leaving the field empty uses the preset). Public builds leave it empty, so the public
bundle contains no address. The token is never built in — it is always entered on the phone.

### Private builds: automatic connection through your own relay (0.2.1)

For a build that only you use: `VITE_HA_RELAY=<relay address> npm run build` connects TV Glance to a
[`ha-relay`](../../selfhost/services/ha-relay/README.md) on your tailnet. Nothing is typed on the phone:

- The relay speaks Home Assistant's WebSocket protocol and holds the real token itself; the app sends
  the placeholder `relay` as "token" (the relay accepts any value). Access is decided by your Tailscale login.
- On start the app fetches `<relay>/config` and, **only while the saved device list is empty**, stores
  those devices (the first one active). A list you changed on the phone is never overwritten.
- The settings tab shows "Connected automatically via your relay" and the current status instead of the
  address and token fields (also: relay not reachable, relay lists no devices). An unreachable relay is asked
  again every 15 s.
- The relay address comes from the build variable only, never from the source. Public builds leave it empty
  and behave exactly as before (address + token entered by the user). Build the private bundle with its own
  `app.private.json` (network whitelist for your relay) and never submit it to the store.

## Backend 2: Android TV bridge (`examples/androidtv-bridge.py`)

For people without Home Assistant. Python ≥ 3.8 and the
[`androidtvremote2`](https://github.com/tronikos/androidtvremote2) library (the protocol of the
Google TV remote app; works with Android TV / Google TV devices: Chromecast with Google TV, Shield,
Sony/Philips/TCL TVs with Google TV …).

```bash
pip install androidtvremote2
# once: pair (the TV shows a 6-character code)
TV_HOST=192.168.1.50 python3 examples/androidtv-bridge.py --pair
# run (localhost only, put tailscale serve in front):
TV_HOST=192.168.1.50 BRIDGE_TAILSCALE_USERS=you@example.com python3 examples/androidtv-bridge.py
tailscale serve --bg --https=8476 http://127.0.0.1:8477
# or in the LAN with a token:
TV_HOST=192.168.1.50 BRIDGE_HOST=0.0.0.0 BRIDGE_TOKEN=$(openssl rand -hex 24) python3 examples/androidtv-bridge.py
# self-test (fake TV, no network, no library needed):
python3 examples/androidtv-bridge.py --selftest
```

In TV Glance: *Settings* → Connection **Android TV bridge** → the bridge's address (the
`https://<machine>.<tailnet>.ts.net:8476` of tailscale serve, or `http://<LAN-IP>:8477`) and the
token if you set one.

| Endpoint | Body | Does |
|---|---|---|
| `GET /health` | – | alive (no login, no data) |
| `GET /state` | – | `{"name", "on", "app", "app_label", "volume" (0–100), "muted", "apps": [{label,id}], "connected"}` |
| `POST /key` | `{"key": "DPAD_UP"}` | one of `DPAD_UP DPAD_DOWN DPAD_LEFT DPAD_RIGHT DPAD_CENTER BACK HOME MEDIA_PLAY_PAUSE VOLUME_UP VOLUME_DOWN VOLUME_MUTE` (a `KEYCODE_` prefix is accepted); anything else 400 |
| `POST /app` | `{"app": "org.xbmc.kodi"}` | a package name, an app link, or a label/id of `TV_APPS` |
| `POST /power` | `{"on": false}` | sends POWER only when the TV is not already in that state (`unchanged: true` otherwise); without `on` it toggles |

- Bodies are JSON; TV Glance sends them as `text/plain`, so without a token these are CORS *simple
  requests* (no preflight). With a token, `Authorization: Bearer` is sent and the bridge answers the
  preflight with **204 and no body**, allowing `Authorization, Content-Type`.
- Login: `Tailscale-User-Login` trusted only from loopback and only for `BRIDGE_TAILSCALE_USERS`,
  or `Authorization: Bearer <BRIDGE_TOKEN>`. With neither configured the bridge refuses to start.
- CORS echoes the caller's origin; `BRIDGE_ORIGINS` restricts it to exact origins.
- Errors: 401 login, 400 bad key/app/body, 413 body > 2 KB, 502 TV not connected.

| Env | Default | |
|---|---|---|
| `TV_HOST` | – | the TV's IP (required) |
| `TV_CERT_DIR` | `~/.config/tv-glance-bridge` | client certificate from pairing (`cert.pem`, `key.pem`) — keep it private |
| `TV_CLIENT_NAME` | `TV Glance bridge` | shown on the TV during pairing |
| `TV_LABEL` | the TV's model | name on the glasses |
| `TV_APPS` | – | `YouTube=com.google.android.youtube.tv;Netflix=com.netflix.ninja` |
| `BRIDGE_HOST` / `BRIDGE_PORT` | `127.0.0.1` / `8477` | |
| `BRIDGE_TOKEN` | – | bearer token |
| `BRIDGE_TAILSCALE_USERS` | – | allowed Tailscale logins |
| `BRIDGE_ORIGINS` | – (echo) | exact CORS origins |

systemd: [`examples/tv-glance-bridge.service`](examples/tv-glance-bridge.service) (pair once as the
service user with the same `TV_CERT_DIR`). Then `systemctl is-active tv-glance-bridge`.

The bridge reports no media title (the protocol does not carry one) and only the app's package name;
`TV_APPS` gives it a readable label.

## Not verified without real hardware

- A WebSocket from the Even app's WebView to a live Home Assistant (no origin check per HA's source;
  tested only against a fake socket). The WebView's exact origin matters only for the REST fallback
  (TV Glance shows it at runtime).
- Real Home Assistant media players: which attributes a given TV integration fills (`app_name`,
  `source_list`, `volume_level` differ between integrations); volume steps are TV-specific, the bar
  is corrected by the next poll.
- `androidtvremote2` against a real TV (pairing, key names, launch); the self-test uses a fake TV.
  The API calls follow the library's documented interface.
- Gestures and the exit dialog on the real G2 follow the measured patterns of the other Quietglass
  apps but were tested here only with fakes.

## Build

```bash
npm install
npm test            # vitest (adapters against fakes, gestures, debounce, power arming, demo, i18n, no-URL check)
npm run build       # tsc + vite
node ../../tools/check-store-urls.mjs tv-glance   # from the repo root: must say ok
npx evenhub pack app.json dist -o tv-glance.ehpk --sdk-ver 0.0.16
QG_PREVIEW=1 npx vitest run tests/preview.test.ts # transparent store screenshots -> store/screenshots/
```

The public `app.json` whitelists `http://*` and `https://*` because every address is typed by the user;
the bundle contains no URL. A private build may pack an `app.private.json` with the exact origin.

## License

MIT
