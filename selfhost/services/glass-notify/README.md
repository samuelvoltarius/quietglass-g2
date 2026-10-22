# Glasses notifier (glass-notify)

Even Hub apps on the G2 only run while they are open. **Phone notifications, however, always reach the glasses.**
The glasses notifier watches your own services and sends a **short Telegram message** when something happens
(it becomes a phone notification, and so shows up on the glasses).

It runs as a systemd **user** service on the Raspberry Pi. Python standard library only (3.9+).
Self-test: `python3 glass_notify.py --selftest`.

> **Not a medical alarm.** The sugar messages are only an extra hint. They can arrive late or not at all
> (network, Telegram, Pi, uploader, phone sleep mode).
> **Always keep the alarms of your pump/CGM app switched on.** The pump and the sensor are what counts.

## What is sent

Plain text, at most 200 characters, without a link preview, with a marker at the start.
The message texts are sent in German. The examples below show them as sent.

| Watcher | Event | Example |
|---|---|---|
| Printer (`NOTIFY_KLIPPER_URL`, Klipper bridge `GET /api/printer`) | Print finished / canceled / error / paused | `🖨 Druck fertig: Halter_v2 (3 h 12 min)` · `🖨 Druck abgebrochen: Halter_v2 nach 45 min` · `🖨 Druckfehler: … – <Klipper-Meldung>` · `🖨 Druck pausiert: Halter_v2 (40 %)` |
| Car (`NOTIFY_BYD_URL`, BYD bridge `GET /state`) | Charging finished (mode *charging* → *parked*) | `🚗 Laden fertig: 96 %, 305 km` (from the charge target or ≥ 95 %), otherwise `🚗 Laden beendet: 62 %, 190 km`. Unplugging and driving off stays silent |
| | Bridge warning `unlocked` (parked, unlocked for > 10 min) | `🚗 Auto seit 12 min nicht abgesperrt` |
| Sugar (`NOTIFY_SUGAR_URL`, sugar-bridge `/api/v1/entries/sgv.json`) | Low: < 70, or < 80 and `SingleDown`/`DoubleDown` | `🩸 Zucker 68 ↓ – niedrig` · `🩸 Zucker 78 ⇊ – fällt schnell` |
| | Very low < 55 (immediately, even in the middle of a low phase) | `🩸 Zucker 53 ⇊ – sehr niedrig!` |
| | High > 250 | `🩸 Zucker 265 ↑ – hoch` |
| | Back in range (hysteresis: from 80, or below 230) | `🩸 Zucker 92 ↗ – wieder im Bereich` |
| | No value for > 20 min, although values came in before | `🩸 Seit 21 min keine Zuckerwerte` |
| Server (`NOTIFY_STATUS_URLS`, Status Glass server `GET /status`) | Not reachable for > 5 min / back again | `🖥 Spark nicht erreichbar seit 5 min` · `🖥 Spark wieder erreichbar (12 min weg)` |
| | New device in the home network (`network.devices[].new`) | `🌐 Neues Gerät im Netz: Galaxy-S24 (10.0.0.23)`; from 4 devices on, one combined message |

Repeats: low at most every 20 min while it stays low (below 55 immediately, once per drop below); high at most every
60 min. Every message has a key. The same message is never sent twice, not even after a restart (state in
`~/.local/state/glass-notify/state.json`, mode 600, written atomically). If Telegram cannot be reached, sending is
retried for up to 1 h.

**Quiet time** (`NOTIFY_QUIET=23:00-07:00`): during it, only sugar messages and "server not reachable" are sent.
Printer/car messages and "back again" are discarded. New devices in the network are reported after the quiet time
(the status page lists them as new for 24 h).

If a source is gone only briefly, nothing changes (stale BYD data, printer "offline" and missing answers are
ignored; the last state stays).

## Sending through Telegram

It uses the Telegram bot of the Hermes agent. On **every** send, it reads from `NOTIFY_HERMES_ENV`
(default `~/.hermes/.env`): `TELEGRAM_BOT_TOKEN` and `TELEGRAM_HOME_CHANNEL` (if the channel is missing:
the first number from `TELEGRAM_ALLOWED_USERS`; `NOTIFY_CHAT_ID` overrides).

- The token is never printed, logged or stored (not even in error messages).
- The service calls **only `sendMessage`**, never `getUpdates` or the like. Hermes polls the bot, and a second
  reader would take messages away from it.
- The journal only shows the kind and success ("gesendet: sugar", i.e. "sent: sugar"), no values.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `NOTIFY_KLIPPER_URL` | – (off) | Klipper bridge; host only → `/api/printer` is appended |
| `NOTIFY_BYD_URL` | – (off) | BYD bridge; host only → `/state` |
| `NOTIFY_SUGAR_URL` | – (off) | sugar-bridge; without `sgv.json` → `/api/v1/entries/sgv.json?count=3` |
| `NOTIFY_STATUS_URLS` | – (off) | `Name\|URL,Name\|URL` (in quotes); host only → `/status` |
| `NOTIFY_KLIPPER_TOKEN`, `NOTIFY_BYD_TOKEN`, `NOTIFY_SUGAR_TOKEN`, `NOTIFY_STATUS_TOKEN` | empty | Optional bearer token per watcher (usually unnecessary in the tailnet with `tailscale serve`) |
| `NOTIFY_HERMES_ENV` | `~/.hermes/.env` | File with the bot token and target chat |
| `NOTIFY_CHAT_ID` | empty | A different target chat |
| `NOTIFY_QUIET` | empty | Quiet time `HH:MM-HH:MM`, also across midnight |
| `NOTIFY_INTERVAL` / `NOTIFY_TIMEOUT` | 60 / 10 | Seconds between rounds / per request |
| `NOTIFY_STATE` | `~/.local/state/glass-notify/state.json` | State |
| `NOTIFY_BYD_TARGET` | 80 | Charge target in %, from which "charging finished" is reported |
| `NOTIFY_SUGAR_LOW` / `_URGENT` / `_HIGH` | 70 / 55 / 250 | Limits in mg/dL |
| `NOTIFY_SUGAR_STALE_MIN` | 20 | Minutes without a value until the message |
| `NOTIFY_DOWN_MIN` | 5 | Minutes not reachable until the message |

Template: [`.env.example`](.env.example) (placeholder addresses `*.example.ts.net` only).

## Set-up (Raspberry Pi, user service)

```bash
mkdir -p ~/glass-notify ~/.config/systemd/user
cp glass_notify.py ~/glass-notify/
cp .env.example ~/glass-notify/.env && chmod 600 ~/glass-notify/.env   # enter addresses
python3 ~/glass-notify/glass_notify.py --selftest                        # must say "alles gruen" ("all green")
set -a; . ~/glass-notify/.env; set +a
python3 ~/glass-notify/glass_notify.py --dry-run --once                  # preview only, send nothing
python3 ~/glass-notify/glass_notify.py --test-message                    # sends "✅ Brillen-Melder aktiv" ("glasses notifier active") to the phone
cp glass-notify.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now glass-notify
loginctl enable-linger "$USER"                                           # also runs without a login
journalctl --user -u glass-notify -n 20                                  # read it back
```

The Pi must be in the tailnet and reach the services through their `tailscale serve` addresses. The
Pi's Tailscale login must be on their access list (for example `SUGAR_TAILSCALE_USERS`).

Options: `--dry-run` (print messages instead of sending, do not save state), `--once` (one
round), `--test-message`, `--selftest` (all transitions with fake data, without a network; it also checks length,
quiet time, duplicates, resending and that the token never appears in the output).
