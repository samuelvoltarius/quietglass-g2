# BYD Glass

**Quietglass** · Your BYD on the Even G2 — speed, battery, charging, tyres and warnings in your field of view.
**Commands only if your bridge allows them:** lock, unlock and preheat (10/20/30 min), each with a second tap, only
with the car switched off. Built and tested with a BYD Dolphin Surf (DiLink 3).

> **Auf Deutsch, kurz:** BYD Glass zeigt dein BYD auf der Even G2: Tempo, Akku, Laden, Reifen und Warnungen.
> Wenn deine Bridge es freigibt: Zusperren, Aufsperren und Vorheizen 10/20/30 min – je mit zweitem Tippen und nur bei
> ausgeschaltetem Auto. Kein Klima-aus. Die App wählt die Startseite selbst (Fahren, Laden, Geparkt).
> Sie liest nur, was deine eigene **byd-bridge** liefert; ohne Adresse läuft eine Demo mit erfundenen Werten.

> **Unofficial, not affiliated with BYD.** The app only reads what your own **byd-bridge** provides
> ([`selfhost/services/byd-bridge`](../../selfhost/services/byd-bridge/README.md)) and, if enabled there, asks it to
> pass on a command. The bridge holds every safety rule.
> While driving, keep your eyes on the road. The Drive page only shows what the car already displays itself.

BYD Glass picks the start page by itself. **While driving** it shows the speed large, with power, consumption over
the last 50 km, range, climate (on/off and fan level), outside temperature and trip. **While charging** it shows the
charging power, energy added, time left, AC/DC, cell temperatures and "done". **When parked** it shows the range,
lock, doors (incl. boot and bonnet), tyres, climate, odometer and how fresh the data is. New warnings appear on top
of every page.

**Commands (0.7.0, decided 23.10.2026 under the Panoptes coordination rules):** a small fourth page "Steuern /
Control" with exactly **Zusperren / Lock**, **Aufsperren / Unlock** and **Vorheizen / Preheat 10, 20, 30 min**. There
is no climate off (the session ends by itself) and no temperature. The page only exists while the bridge reports
control enabled (`BYD_CONTROL=1`), and only shows the entries the bridge accepts. All guards live **in the bridge**
and fail closed: a fresh `power_level` 0 (car off, ≤ 180 s, never a stored value), ≥ 15 s between commands, ≤ 6 per
hour, a Telegram message before every unlock (no message, no unlock), every command logged. With the car on, the
bridge refuses with "Auto ist an – am Display bedienen" / "Car is on – use the car's screen" and the glasses show
exactly that.

**Many BYD models:** the values come from the Panoptes car app, which runs on many BYD models. A value your model does
not report is left out (the next known value moves up) — it is never shown as `0` or as a made-up "OK".

**No cabin temperature:** the Dolphin Surf has no cabin temperature sensor. Panoptes' `climate_setpoint`
(17–33, 25 = neutral) is the climate *setpoint*, not a reading, so the app never shows an "inside temperature".
Climate is shown as on/off plus the fan level only.

**Get started in 3 steps**

1. The Panoptes app in the car publishes the values to your broker via MQTT (`surfmate/vehicle/telemetry/<field>`).
2. Start `byd-bridge` next to it and expose it with `tailscale serve --bg --https=8471 http://127.0.0.1:8472`
   (access only for your Tailscale login, no token in the app).
3. In the Even app, enter the https address of the bridge in BYD Glass (a private build with `VITE_BYD_URL`
   already includes it). **Without an address, a demo runs** with made-up values ("DEMO" at the top).

`?demo=1` on the development address forces the demo; `&scene=tour|drive|charge|parked|warn` selects the scene
(default `tour`: 40 s driving, 40 s charging, 40 s parked), and `&page=drive|charge|status` pins one page.

---

## On the glasses

All three pages are one cockpit image (QUS v1): the battery ring on the left, a big headline and up to six
label/value cells on the right. Cells whose value the car does not report are left out.

| Page | Headline | Cells (first six that are known) |
|---|---|---|
| Drive | speed `KM/H`, gear | power · consumption (50 km) · range · climate (`ON · FAN 2`) · outside · trip · (12 V) |
| Charge | kW + `CHARGING AC/DC`, or `DONE` | range · added · time left · type · cells · as of · (SoH) |
| Status | range | lock · doors · tyres · climate · km · as of · (12 V · outside · SoH) |

**Warnings** (evaluated by the bridge) appear on top of every page when new (8 s or until you tap), after that the
worst one shows in the caption and pulses in the header: pressure loss, tyre pressure low, door / boot / bonnet open
(critical while driving), 12 V weak, not locked for ≥ 10 min (parked), battery low, charging done (notice).

| Gesture | does |
|---|---|
| Swipe | next/previous page (drive · charge · status · control); on the control page: next entry |
| Tap | show the warnings; on the control page: see below |
| 2× | back (warnings, help, an open question), otherwise close the app |

**Control page** (plain text, QUS v1 list): header `BYD · STEUERN · Auto aus` (or `nur bei Auto aus`), the entries
with `●` on the selected one, one result line.

1. **Tap** an entry: the app asks the bridge (`step: arm`). The bridge checks every guard and sends **nothing**.
   A refusal shows the bridge's own text in the result line.
2. If the bridge agrees, the footer says `Nochmal tippen = Zusperren · Wischen/2× = abbrechen`. **Tap again within
   4 s** to send (`confirm`). A swipe or 2× cancels; after 4 s it lapses ("nicht gesendet").
3. The result line then shows `gesendet – warte auf das Auto …`, and later `bestätigt` or `nicht bestätigt` - taken
   only from the bridge, which confirms only from fresh car telemetry after the command (lock: door lock, preheat:
   climate on). If the second tap gets no answer, the line says "unclear whether sent" until the bridge's record shows
   what happened. Never a false success.

No footer offers a hold (from the temple a hold never reaches the app); the phone sends no commands, its "Auto" tab
only shows what the bridge allows and how the last command ended.

A hold only reaches the app from the R1 ring and opens a short help page; no footer offers it.
When the car changes mode (starts driving, is plugged in, is parked), the app jumps to the matching page.

## What the app requests

Only a "simple request" without custom headers (no CORS preflight):

| Request | when |
|---|---|
| `GET /state` and then `GET /state?since=<rev>&wait=25` | continuously as a long poll: the bridge answers at once on changes, otherwise after 25 s |
| `POST /command` `{"action","minutes"?,"step":"arm"}` (text/plain body) | first tap on the control page |
| `POST /command` `{"action","minutes"?,"confirm":"<one-time>"}` | second tap within 4 s |

On errors it waits 2 s, then twice as long up to 30 s, and shows "Bridge: … – showing last data".

## Build

```bash
npm install
npm test            # vitest
npm run build       # tsc + vite
npx evenhub pack app.json dist -o byd-glass.ehpk --sdk-ver 0.0.16
python3 ../../selfhost/services/byd-bridge/byd_bridge.py --selftest   # bridge evaluation
python3 ../../selfhost/services/byd-bridge/test_byd_bridge.py         # bridge topic mapping + every command guard
```

Private build with your bridge: `VITE_BYD_URL=https://<host>.<tailnet>.ts.net:8471 npm run build`, and pack with
an `app.private.json` whose `whitelist` contains exactly this origin (the glasses block wildcards).

Store previews: `QG_PREVIEW=1 npx vitest run tests/cockpit.test.ts` writes `store/preview-cockpit*.png`.

## License

MIT
