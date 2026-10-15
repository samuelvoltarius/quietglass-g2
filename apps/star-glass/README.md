# Star Glass

**Quietglass** · Your N.I.N.A. imaging night on the Even G2 — exposure countdown, frame n/m, guiding, focus, cooling, meridian flip and the newest frame.

> **Auf Deutsch, kurz:** Star Glass zeigt auf der Brille, was deine
> Astrofotografie-Sitzung in [N.I.N.A.](https://nighttime-imaging.eu/) gerade
> macht: Ziel, Filter, Bild n/m und ein Ring, der die laufende Belichtung
> herunterzählt; Guiding-RMS und HFR als große Zahl mit Verlauf; Kamera-Temperatur
> und Kühlung, Nachführung, Höhe und Minuten bis zum Meridian-Flip; Fokussierer;
> eine kleine Vorschau des neuesten Bildes. Oben stehen Meldungen (Sequenz fertig,
> Guiding verloren, Kühlung aus, Flip bald). Eine kleine Bridge am Aufnahme-Rechner
> fragt das N.I.N.A.-Plugin „Advanced API“ und reicht einen kompakten Status weiter.
> Optional (Schalter an der Bridge, standardmäßig aus) lässt sich die Sequenz
> anhalten und fortsetzen – jeweils mit zweitem Tippen.
>
> **In 3 Schritten loslegen**
> 1. In N.I.N.A. das Plugin **Advanced API** installieren (Port 1888, API v2).
> 2. Am Aufnahme-Rechner `node examples/star-bridge.mjs` starten und über https
>    erreichbar machen: `tailscale serve --bg --https=8460 http://127.0.0.1:8893`.
> 3. In der Even-App bei Star Glass die https-Adresse eintragen (ein privater
>    Build mit `VITE_STAR_URL` bringt sie schon mit).

Use `?demo=1` on the development URL for a simulated imaging night (labelled
`DEMO`, no bridge needed). `&scene=flip|lost|warm|done` shows the alert lines,
`&page=1..5` opens a page (2 = weather).

---

## On the glasses

Swipe moves between five pages; the telescope sign in the top-right corner
animates while a frame is exposed (twinkling star, filling dots), sits still
when idle and shows a pulsing `!` on a problem.

| Page | Left | Right |
|---|---|---|
| 1 Overview | exposure ring: seconds left in large digits, frame length below | target, filter · exposure · frame n/m, time left · step, camera temp · guiding RMS, flip · altitude |
| 2 Weather | cloud cover for the next 12 h (limit dotted, chance of rain as a strip, labels every 3 h) | clear until ~02:30 / cloudy · clear from ~03:00, clouds now with low/mid/high layers, rain · dew spread, wind · gusts, SQM · safety monitor, up to two warnings |
| 3 Guiding & focus | RMS (") large with its history, HFR large with its history | guiding state, RA/Dec RMS, HFR · stars, focuser position and temperature |
| 4 Equipment | full width: camera (temp → set point · cooler %), mount (tracking, alt/az), meridian flip and pier side, focuser, filter, guider, API version | |
| 5 Last frame | 288 × 144 grayscale preview, stretched for the glasses | target, type · filter, exposure, HFR · stars, frames in this session, age |

An alert replaces the header on every page (worst first, `(+n)` for more):
`! Guiding verloren`, `! Kühlung aus`, `Meridian-Flip in 6 min`, `Sequenz fertig`,
`! Kamera getrennt`, `! Fehler: PLATESOLVE`. When the last reading is older than
20 s the header says `veraltet 30 s`.

### Weather warnings

N.I.N.A. first: a connected weather device (ASCOM ObservingConditions: cloud
cover, rain rate, humidity, dew point, wind, sky quality) speaks for *now*, the
safety monitor's `IsSafe=false` is a red alert. The
[Open-Meteo](https://open-meteo.com/) forecast (free, no key) speaks for the
next hours: total and low/mid/high cloud cover, chance and amount of
precipitation, humidity, dew point, temperature, wind and gusts.

| Warning | Default limit | Example |
|---|---|---|
| Clouds coming (within 2 h) | cloud cover ≥ 60 % | `Wolken in ~40 min (75 %)` |
| Rain risk / rain | chance ≥ 40 % or ≥ 0.2 mm/h, rain sensor > 0 | `Regen 45 % in ~1 h 10`, `! Regen (Sensor)` |
| Dew | temperature − dew point ≤ 2 °C | `Taugefahr: 1,4 °C` |
| Wind | wind or gusts ≥ 30 km/h | `Wind 42 km/h in ~50 min` |

A new warning pops up in the header of every page for 15 s; the same warning
pops up at most once in 30 minutes. Hysteresis keeps a warning on until the
value is clearly back (10 % clouds / rain chance, 1 °C dew spread, 5 km/h wind).
Limits are set on the phone page.

Location, in this order: the site from N.I.N.A. (only if the bridge runs with
`STAR_SITE=1`), coordinates typed on the phone page, the phone's location (asked
once per start). Coordinates are rounded to two decimals (~1 km) before they go
to Open-Meteo.

| Gesture | Does |
|---|---|
| Swipe | next / previous page |
| Tap | open *control* if the bridge allows it, otherwise refresh |
| Tap, then tap again on a command | stop / resume the sequence (the first tap only arms it; a second single tap within 4 s runs it; swipe, 2× or 4 s cancel) |
| Hold | opens the help (the glasses' side menu is off, `SIDE_MENU`); refresh is Tap, the swipe direction is set on the phone |
| 2× | back (from control or help); on a page: closes the app |

## The bridge (`examples/star-bridge.mjs`)

Node ≥ 18, no dependencies (the optional websocket listener needs Node 22+).
It runs on the computer with N.I.N.A., polls the Advanced API every 2 s and
serves:

| Route | |
|---|---|
| `GET /api/star` | one compact JSON (below) |
| `GET /api/star/preview.png` | the newest frame, 288 × 144, 8-bit gray, letterboxed and stretched |
| `POST /api/star/cmd` `{"command":"stop"\|"start"}` | only with `STAR_ALLOW_CONTROL=1` **and** a login (token or Tailscale) |
| `GET /health` | `{ok, nina}` |

Advanced API endpoints it reads: `version`, `equipment/{camera,mount,focuser,filterwheel,guider}/info`,
`sequence/state`, `event-history`, `image-history?all=true`, `image/{i}?resize=true&size=WxH&stream=true`;
for control `sequence/stop` and `sequence/start`. The websocket (`/v2/socket`) only triggers an earlier refresh.

```json
{ "online": true, "sequence": { "state": "running", "target": "M 31", "step": "Take Exposure", "frame": 4, "frames": 12 },
  "exposure": { "active": true, "total": 180, "remaining": 63.2, "progress": 65 }, "filter": "Ha",
  "camera": { "temp": -10, "setpoint": -10, "cooler": true, "power": 38, "canCool": true },
  "mount": { "tracking": true, "alt": 64.2, "az": 118.6, "flipMinutes": 42, "pier": "east" },
  "focuser": { "position": 25310, "temp": 8.4 }, "guider": { "connected": true, "guiding": true, "rms": 0.62, "ra": 0.41, "dec": 0.47 },
  "last": { "filter": "Ha", "exposure": 180, "hfr": 2.31, "stars": 1842, "target": "M 31" },
  "history": { "hfr": [], "temp": [], "rms": [] }, "events": [{ "name": "GUIDER-STOP", "ageSeconds": 40 }],
  "preview": "3f2a…", "controllable": false }
```

The site coordinates N.I.N.A. reports are **not** passed on, nor file paths.
Frame n/m comes from the nearest *Loop for iterations* condition of the running
item; the exposure length from the running *Take Exposure* (otherwise estimated).
Stopping keeps N.I.N.A.'s progress: *resume* continues with the next frame.

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `8893` / `127.0.0.1` | keep loopback and publish with `tailscale serve` |
| `STAR_NINA` | `http://127.0.0.1:1888` | Advanced API base |
| `STAR_TAILSCALE_USERS` | – | Tailscale logins that need no token (header trusted from loopback only) |
| `TOKEN` | – | bearer token, the alternative to Tailscale |
| `STAR_ALLOW_CONTROL` | off | `1` allows stop / resume (refused anyway without a login) |
| `STAR_SITE` | off | `1` shares the site from N.I.N.A. (mount, else profile), rounded to 2 decimals, for the weather forecast |
| `STAR_POLL_MS`, `STAR_PREVIEW=0`, `STAR_WS=0` | 2000, on, on | |

CORS: a preflight gets `204` without a body and the request's origin echoed,
`Authorization, Content-Type` allowed. Without a token the app sends no custom
header at all (simple requests, no preflight). A 401 is logged with the kind of
credential only (`auth=none|tailscale|len… fp=…`), never its value.

Self-hosting (service files, Windows autostart): [`selfhost/services/star-bridge`](../../selfhost/services/star-bridge).
Test without a telescope: `node examples/mock-nina.mjs` and `STAR_NINA=http://127.0.0.1:1889`.

## Private build

```bash
VITE_STAR_URL=https://<pc>.<tailnet>.ts.net:8460 npm run build > build.log 2>&1 \
  && npx evenhub pack app.private.json dist -o ../../release/star-glass/star-glass-0.1.0.ehpk --sdk-ver 0.0.16
```

`app.private.json` (git-ignored) is `app.json` with the exact bridge origin in the
whitelist — the real glasses block wildcards. Or use `selfhost/build-private.mjs`
with `"star": "https://…:8460"` in `selfhost/config.json`.

## Development

```bash
npm install
npm run dev          # http://127.0.0.1:5234/?demo=1
npm run sim          # simulator, automation port 9934
npm test             # vitest: views, alerts, lifecycle, bridge against the mock
npm run typecheck
```

MIT licence. N.I.N.A. and the Advanced API plugin are separate projects by their authors.
