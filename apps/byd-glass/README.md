# BYD Glass

**Quietglass** · Your BYD on the Even G2 — speed, battery, charging, tyres and warnings in your field of view,
climate and lock with a confirmation step. Built and tested with a BYD Dolphin Surf (DiLink 3).

> **Auf Deutsch, kurz:** BYD Glass zeigt dein BYD auf der Even G2: Tempo, Akku, Laden, Reifen und Warnungen,
> dazu Klima und Schloss mit doppelter Bestätigung. Die App wählt die Startseite selbst (Fahren, Laden, Geparkt).
> Sie liest nur, was deine eigene **byd-bridge** liefert; ohne Adresse läuft eine Demo mit erfundenen Werten.

> **Unofficial, not affiliated with BYD.** The app only reads what your own **byd-bridge** provides
> ([`selfhost/services/byd-bridge`](../../selfhost/services/byd-bridge/README.md)). Remote commands can arrive late,
> not at all, or twice — check the result in the car or in the BYD app.
> While driving, keep your eyes on the road. The Drive page only shows what the car already displays itself.

BYD Glass picks the start page by itself. **While driving** it shows large speed (from the car), the speed warning,
battery % + range, a power bar (regeneration to the left of zero, hatched), consumption over the last 50 km,
and indicator and high beam as a blinking symbol at the top right. **While charging** it shows a battery bar with a
running light, kW, time left, kWh added, AC/DC and "charging done". **When parked** it shows the status: locked?, doors,
all four tyres with pressure (bar) and pressure loss, 12 V, SoH, cell temperatures and outside temperature.
The **controls** (climate on with temperature, climate off, lock, unlock) always need two confirmations:
a question, then after a pause of about 1 s the final confirmation; 2× cancels. While the car is on, the controls are locked.
New warnings appear on top of every page.

**Get started in 3 steps**

1. The Overdrive app in the car sends the values to your broker via MQTT (`overdrive/vehicle/telemetry/#`).
2. Start `byd-bridge` next to it and expose it with `tailscale serve --bg --https=8471 http://127.0.0.1:8472`
   (access only for your Tailscale login, no token in the app).
3. In the Even app, enter the https address of the bridge in BYD Glass (a private build with `VITE_BYD_URL`
   already includes it). **Without an address, a demo runs** with made-up values ("DEMO" at the top).

`?demo=1` on the development address forces the demo; `&scene=tour|drive|charge|parked|warn` selects the scene
(default `tour`: 40 s driving, 40 s charging, 40 s parked), and `&page=drive|charge|status|control` pins one page.

---

## On the glasses

| Page | shows |
|---|---|
| Drive | On the left, speed in large pixel digits, `KM/H`, gear; `LIMIT!` + a frame when the car's speed warning is active. On the right, battery %, range, battery bar, power bar (+ drive to the right up to 100 kW, − regeneration to the left up to 40 kW, hatched, `REGEN`). Below: consumption (50 km) · trip km, outside · climate · 12 V |
| Charge | Battery % + range, kW + `DC`/`AC` + time left, battery bar with running light; below: time left · kWh added · charge type, range · cells; after charging, "DONE" |
| Status | Top view with four tyres (bar; `!` when low, inverted on pressure loss), lock (locked/open, `DOOR OPEN`); below: lock · doors · 12 V, SoH · cells · outside, climate · set temperature · data age |
| Control | Climate on 21° · Climate off · Lock · Unlock (car on: everything locked, with a note); confirmations are separate screens; last line: result from the bridge ("sent …", "BYD working …", "done", "BYD busy", "no reply") |

The car at the top right turns its wheels while driving, shows a lightning bolt while charging, a `P` when parked,
`!` for a critical warning, and a cross when the data is old (the car is asleep) or the bridge is missing. Indicators and
hazard lights blink as arrows on the left/right, the high beam as dashes.

**Warnings** (evaluated by the bridge) appear on top of every page when new (8 s or until you tap), after that
the worst one pulses in the header: pressure loss, tyre pressure low, door open (critical while driving), 12 V weak,
not locked for ≥ 10 min (parked), battery low, charging done (notice).

| Gesture | does |
|---|---|
| Swipe | next/previous page; in Control: selection (at the end of the list, on to the next page), on "Climate on": temperature ±1 °C |
| Tap | show warnings; in Control: choose → (temperature →) question → after a 1 s pause the final confirmation = send (each step ≤ 8 s) |
| Hold | help (the gestures); in a question: cancel |
| 2× | cancel the confirmation at any step, otherwise close the app |

When the car changes mode (starts driving, is plugged in, is parked), the app jumps to the matching page — unless you
are busy in Control.

## What the app requests

Only "simple requests" without custom headers (no CORS preflight):

| Request | when |
|---|---|
| `GET /state` and then `GET /state?since=<rev>&wait=25` | continuously as a long poll: the bridge answers at once on changes, otherwise after 25 s |
| `POST /command` with `{"action":"climate_on","value":21}` as text/plain | only after two confirmations on the glasses and only when `car_on` is not `true` |

On errors the app waits 2 s, then twice as long up to 30 s, and shows "Bridge: … – showing last data".

## Commands

| Entry | sends | Note |
|---|---|---|
| Climate on 21° | `climate_on` 16–28 | without an extension of the pybyd-mqtt bridge it sends a fixed 26 °C (from 22°) or 19 °C — the list then shows "(sends 26°)" |
| Climate off | `climate_off` | |
| Lock | `lock` | only if a lock route is set up on the bridge |
| Unlock | `unlock` | disabled on the bridge by default; otherwise only when stationary (parked, 0 km/h) |

The bridge checks everything again (allowlist, values, standstill, one command at a time, at most one every 20 s)
and logs every command.

## Build

```bash
npm install
npm test            # vitest
npm run build       # tsc + vite
npx evenhub pack app.json dist -o byd-glass.ehpk --sdk-ver 0.0.16
python3 ../../selfhost/services/byd-bridge/byd_bridge.py --selftest   # bridge evaluation
```

Private build with your bridge: `VITE_BYD_URL=https://<host>.<tailnet>.ts.net:8471 npm run build`, and pack with
an `app.private.json` whose `whitelist` contains exactly this origin (the glasses block wildcards).

## License

MIT
