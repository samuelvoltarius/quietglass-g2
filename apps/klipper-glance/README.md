# Klipper Glance

**Quietglass** · Your Klipper printer at a glance — progress, layer, time left, temperatures. Pause, resume and cancel only after two taps.

> **Auf Deutsch, kurz:** Klipper Glance zeigt auf der Brille, was dein
> 3D-Drucker (Klipper/Moonraker) gerade macht: Datei, Fortschrittsbalken,
> Schicht, Restzeit, Düse und Bett, Tempo. Eine kleine Bridge auf einem Rechner
> in deinem Netz fragt den Drucker und reicht den Status weiter – den Drucker
> findet sie selbst. Wenn du es an der Bridge erlaubst, kannst du pausieren,
> weiterdrucken oder abbrechen – jeder Befehl braucht zwei Tipper. Die App
> folgt der Handy-Sprache (Deutsch/Englisch).
>
> **In 3 Schritten loslegen**
> 1. Auf einem Rechner im Drucker-Netz: `node examples/klipper-bridge.mjs`
>    starten und über https erreichbar machen (z. B. `tailscale serve 8898`).
> 2. In der Even-App bei Klipper Glance die https-Adresse eintragen.
> 3. Auf der Brille: **tippen** öffnet die Steuerung (falls erlaubt),
>    **doppeltippen** fragt, ob die App beendet werden soll.

Use `?demo=1` on the development URL for a simulated printer (labelled `DEMO`,
no bridge needed).

---

## On the glasses

```
KLIPPER · printing
bracket_v3

●●●●●●●●○○○○○○○○○○○○  42 %
Layer 76/180 · 2 h 19 min left
Nozzle 219/220 °C · bed 60/60 °C
Speed 100 %
tap = control · 2× = close
```

When the last reading is older than 15 s, the header says `stale 30 s`, so old
numbers are never mistaken for live ones. When the printer is off, the glasses
say so and when the bridge will look again.

### Controls (optional)

Tap opens the control screen — only when the bridge allows control and the
printer is printing or paused:

| Printing | Paused |
|---|---|
| Pause · Cancel print · Back | Resume · Cancel print · Back |

**Every command needs a second, confirming tap.** The first tap only arms it
(*"Tap again = CANCEL the print"*). Swiping drops the armed command, so the tap
after a swipe can never run what was highlighted before, and an armed command
lapses after six seconds. Cancel is always last in the list.

| Gesture | HUD | Control screen |
|---|---|---|
| Tap | open control (or refresh, when control is off) | arm, then confirm |
| Swipe | – | choose (drops a pending confirmation) |
| Double tap | **leave the app** (the system asks first) | back to the HUD |

## Setup

### 1. Run the bridge

On a machine that can see the printer on the LAN (a Raspberry Pi, a NAS, your
desktop):

```bash
node examples/klipper-bridge.mjs                          # finds the printer itself
KL_MOONRAKER=http://printer.local:7125 node examples/klipper-bridge.mjs
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8898` | port |
| `HOST` | `127.0.0.1` | bind address |
| `TOKEN` | – | bearer token for every `/api` request; compared in constant time |
| `KL_MOONRAKER` | – | fixed Moonraker address; without it the bridge searches |
| `KL_SCAN_NET` | this machine's private networks | `/24` to search, e.g. `192.168.1` (comma-separated for several) |
| `KL_MOONRAKER_PORT` | `7125` | Moonraker port |
| `KL_RESCAN_MS` | `45000` | pause after a search that found nothing |
| `KL_ALLOW_CONTROL` | off | `1` allows pause/resume/cancel — **refused anyway** unless a `TOKEN` is set or `HOST` is loopback |

The search runs in the background; the glasses see *"Looking for the printer
…"* meanwhile instead of a hanging request.

No printer at hand? `node examples/mock-moonraker.mjs` simulates one:

```bash
node examples/mock-moonraker.mjs &
KL_MOONRAKER=http://127.0.0.1:7125 KL_ALLOW_CONTROL=1 node examples/klipper-bridge.mjs
```

### 2. Make it reachable over HTTPS

**The app is loaded over HTTPS on the phone, so the bridge must be reachable
over `https://`.** A plain `http://` address is blocked by the Even app as
mixed content (the phone page warns about it). For example:

```bash
tailscale serve --bg 8898          # → https://<machine>.<tailnet>.ts.net
```

`tailscale serve` forwards to `127.0.0.1`, so the bridge can stay bound to
loopback. If you bind it to another address instead, set a `TOKEN` — without
one, control stays off. Note that control on a loopback bridge without a token
is reachable by any web page opened in a browser on that same machine; set a
`TOKEN` whenever control is on.

### 3. Enter the address on the phone

Open Klipper Glance in the Even app, enter the https address (and the token,
if set) and tap **Save and connect**. The page shows the printer state and
whether control is allowed.

## Development

```bash
npm install
npm run dev          # http://127.0.0.1:5219  (add ?demo=1 for a simulated printer)
npm run sim          # simulator, automation port 9919
npm test
npm run build
npm run pack         # klipper-glance.ehpk
npm run mock         # simulated Moonraker on :7125
npm run bridge
```

## Status

Verified in tests (against the mock Moonraker) and the Even Hub simulator only.
**Not yet verified on physical G2 hardware, and not yet against every Klipper
distribution** — the bridge reads Moonraker's standard `print_stats`,
`display_status`, `virtual_sdcard`, `extruder`, `heater_bed` and `gcode_move`
objects. Layer numbers appear only when the slicer reports them.

## Privacy

See [docs/PRIVACY.md](docs/PRIVACY.md). The app talks only to the bridge you
enter; there is no account and no tracking.

## License

MIT — see [LICENSE](LICENSE).
