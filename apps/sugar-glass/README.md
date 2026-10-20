# Sugar Glass

**Quietglass** · Your Nightscout glucose on the Even G2 — big value with trend arrow, 3-hour curve, alerts and pump status.

> **Nur zur Information, keine Therapieentscheidungen – maßgeblich sind Pumpe und Sensor.**
> *For information only, not for treatment decisions – your pump and sensor are what count.*
> Sugar Glass is not a medical device and not an alarm. It can be late, wrong or silent
> (no network, sleeping phone, stale Nightscout). Keep the alarms of your pump/sensor app on.

> **Auf Deutsch, kurz:** Sugar Glass zeigt die Werte aus deinem eigenen
> [Nightscout](https://nightscout.github.io/) auf der Brille: den aktuellen Wert
> groß mit Trendpfeil, Änderung in 5 min, Minuten seit der Messung und die letzten
> 3 Stunden als Kurve mit Zielbereich (Standard 70–180 mg/dL). Oben stehen pulsierende
> Warnungen: sehr niedrig (< 54), niedrig (< 70), hoch (> 250), kein aktueller Wert
> (> 15 min), fällt schnell. Seite 2 zeigt die Pumpe (SmartGuard-Modus, aktives
> Insulin, Reservoir, Akkus, Sensor-Restzeit, letzte Mahlzeit/Bolus) – soweit dein
> Uploader das an Nightscout meldet. Einheit, Zielbereich und Grenzen stellst du auf
> der Handy-Seite ein.
>
> **In 3 Schritten loslegen**
> 1. Nightscout betreiben (Docker), gespeist von deinem Uploader (z. B. CareLink-Brücke
>    für MiniMed 780G, xDrip+, Dexcom-Share). `AUTH_DEFAULT_ROLES=denied` setzen.
> 2. In Nightscout einen Zugang mit Rolle `readable` anlegen und `examples/sugar-bridge.mjs`
>    daneben starten (`NS_TOKEN=…`, `SUGAR_TAILSCALE_USERS=du@…`), dann
>    `tailscale serve --bg --https=8462 http://127.0.0.1:8466`.
> 3. In der Even-App bei Sugar Glass die https-Adresse der Bridge eintragen (ein privater
>    Build mit `VITE_NS_URL` bringt sie schon mit). Kein Token in der App nötig.

Use `?demo=1` on the development URL for a simulated day (labelled `DEMO`, no server
needed). `&scene=low|urgent|high|stale|falling` shows the alerts, `&page=2` opens the pump page.

---

## On the glasses

| Page | Shows |
|---|---|
| 1 Glucose | left: value in large pixel digits, trend arrow (one, two or three arrows; `?` when unknown), change in 5 min, unit, minutes since the reading; right: the last 3 h as dots with the target band (dashed) and the urgent-low line (dotted); below: change · target, and IOB · reservoir · SmartGuard |
| 2 Pump | SmartGuard mode, insulin on board, reservoir and pump battery, sensor time left and state, phone battery and age of the report, last meal and bolus |

The drop in the top-right corner glints and drips while all is well, fills while
connecting, shows an outline with a cross without a server, and pulses `!` on an alert.

Alerts (worst first) replace the header on both pages and pulse (`!! NIEDRIG 63 mg/dL !!`);
the glucose alerts also label the value picture:

| Alert | Default | |
|---|---|---|
| very low | < 54 mg/dL | |
| low | < 70 mg/dL | |
| high | > 250 mg/dL | |
| no current value | newest reading older than 15 min | value is struck through, no low/high judgement |
| falling fast | `DoubleDown`/`TripleDown` or ≤ −15 mg/dL in 5 min | |

Start page (QUS v1): two entries, glucose and pump; the glucose and the pump page are a
cockpit image (curve with target band on the left, headline, trend and cells on the right).

| Gesture | Does |
|---|---|
| Tap | start page: open the entry; cockpit: refresh now |
| Swipe | start page: choose; cockpit: glucose ↔ pump |
| Hold | no function (the glasses' side menu is off, `SIDE_MENU`); the swipe direction is set on the phone |
| 2× | cockpit: back to the start page; start page: asks to close the app |

The app asks once a minute (a sensor reports every 5 min); the pictures are only
re-sent when a new value arrives.

## What it reads

Only GET requests without custom headers (CORS "simple requests", no preflight):

| Request | When |
|---|---|
| `/api/v1/entries/sgv.json?count=48` | every 60 s and on tap |
| `/api/v1/devicestatus.json?count=3` | with every reading poll (failures never hide the value) |
| `/api/v1/treatments.json?count=30&find[created_at][$gte]=…` (last 24 h) | every 5 min |

Pump fields read from `devicestatus`: `pump.iob.bolusiob|iob`, `pump.reservoir`,
`pump.battery.percent`, `uploader.battery`, `connect.sensorDurationHours`,
`connect.sensorState`, SmartGuard from `connect.therapyAlgorithmState.autoModeShieldState`
(not every CareLink bridge uploads it — then "not reported"), `openaps`/`loop` count as auto.

## The bridge (`examples/sugar-bridge.mjs`)

Node ≥ 18, no dependencies. A read-only proxy for exactly the paths above (plus
`status.json`, `profile.json`, `entries.json`): GET only, `count` clamped to 400,
only time and event-type filters passed on, any `token` from the caller dropped and the
bridge's own **readable** token added. Every other path is 404, every other method 405.

| Env | |
|---|---|
| `PORT` / `HOST` | default `8466` on `127.0.0.1` |
| `NS_URL` | Nightscout, default `http://127.0.0.1:1337` |
| `NS_TOKEN` | Nightscout access token with role `readable` (never logged) |
| `SUGAR_TAILSCALE_USERS` | Tailscale logins allowed through `tailscale serve` (trusted from loopback only) |
| `TOKEN` | optional bearer token as an alternative |

Without `SUGAR_TAILSCALE_USERS` and `TOKEN` the bridge refuses every request.
Service files and the Nightscout notes: [`selfhost/services/sugar-bridge`](../../selfhost/services/sugar-bridge/README.md).

Without the bridge, enter Nightscout's https address and a `readable` token on the
phone page; the token is then sent as `?token=` (Nightscout's own way).

## Build

```bash
npm install
npm test            # vitest
npm run build       # tsc + vite
npx evenhub pack app.json dist -o sugar-glass.ehpk --sdk-ver 0.0.16
```

A private build with your address: `VITE_NS_URL=https://<host>.<tailnet>.ts.net:8462 npm run build`,
and pack with an `app.private.json` whose `whitelist` holds exactly that origin
(the glasses block wildcards). Never put a token into a build.

## License

MIT
