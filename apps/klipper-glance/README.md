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
> **Ausführliche Einrichtung (Bridge, Dienst, Tailscale, 3D-Ansicht):** [docs/SETUP.md](docs/SETUP.md) · *Full setup guide in English there too.*
>
> **In 3 Schritten loslegen**
> 1. Auf einem Rechner im Drucker-Netz: `node examples/klipper-bridge.mjs`
>    starten und über https erreichbar machen (z. B. `tailscale serve 8898`).
> 2. In der Even-App bei Klipper Glance die https-Adresse eintragen.
> 3. Auf der Brille: **tippen** öffnet die Steuerung (falls erlaubt),
>    **Wischen** zeigt das Schicht-Modell, **2×** fragt, ob die App beendet werden soll.
>    (Halten am optionalen R1-Ring öffnet zusätzlich die Hilfe; am Bügel öffnet Halten das Systemmenü.)

Without a bridge address the app starts on its own in a simulated printer
(labelled `DEMO`, hint line `Demo · set up the connection on the phone`); `?demo=1` on
the development URL forces it.

---

## On the glasses

```
KLIPPER · printing
bracket_v3

●●●●●●●●○○○○○○○○○○○○  42 %
Layer 76/180 · 2 h 19 min left
Nozzle 219/220 °C · bed 60/60 °C
Speed 100 %
Tap = control · Swipe = model · 2× = exit
```

While printing, the progress ring on the left is replaced by the slicer's
preview picture of the part when the file has one (OrcaSlicer, PrusaSlicer,
Cura and SuperSlicer embed it): the printed share lights up from the bottom,
layer by layer, the rest stays faint. Without a preview the ring stays.

**Swipe** opens the layer view: the print as a 3D picture across the whole
display, built from the G-code by the bridge — printed layers lit, the current
layer brightest, the layers still to come as a faint outline. Swipe rotates it,
tap reloads, 2× goes back. The HUD also shows the finish time and, with
Spoolman connected to Moonraker, the active spool (material, vendor, grams left).

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
(*"Tap again = cancel print · Swipe/2× = cancel"*). A swipe or 2× only drops the armed
command (the highlight stays where it was), so the tap after a swipe can never run
what was highlighted before, and an armed command lapses after four seconds.
Cancel is always last in the list.

| Gesture | HUD | Control screen |
|---|---|---|
| Tap | open control (or refresh, when control is off) | arm, then confirm |
| Swipe | look at the layer model | move the row (cancels a pending confirmation instead) |
| 2× | **leave the app** (the system asks first) | cancels a pending confirmation, else back to the HUD |

Everything works with tap, swipe and 2×. A hold reaches the app only from the optional R1 ring
(on the temple the glasses open their system menu); there it opens the help as an extra.

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

## Tested printers

- Creality K1 (tested by the author)
- Ender 3 Pro rebuilt as a Voron Switchwire, running Mainsail (user report)

Any Klipper printer with Moonraker should work. Reports for other printers are welcome.
Deutsch: siehe [docs/SETUP.md](docs/SETUP.md).

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

Verified in tests (against the mock Moonraker), the Even Hub simulator and on
physical G2 hardware. It has not yet been verified against every Klipper
distribution — the bridge reads Moonraker's standard `print_stats`,
`display_status`, `virtual_sdcard`, `extruder`, `heater_bed` and `gcode_move`
objects. Layer numbers appear only when the slicer reports them.

## Privacy

See [docs/PRIVACY.md](docs/PRIVACY.md). The app talks only to the bridge you
enter; there is no account and no tracking.

## License

MIT — see [LICENSE](LICENSE).
