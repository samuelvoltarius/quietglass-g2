# Quiet Hub — agent, home and printer on one screen

One glance app instead of three: completion alerts from Hermes, Claude, Codex
and OpenClaw, your Home Assistant devices, and your Klipper printer come from a
**single self-hosted daemon**. No accounts, no API keys on the device, no
subscription.

**Kurz auf Deutsch:** Fünf Seiten in einer App — Übersicht, Agent, Zuhause,
Drucker und Meldungen. Ein
eigener Daemon bündelt Hermes, Home Assistant und Moonraker; die Brille spricht
nur mit ihm. Riskante Home- und Druckeraktionen brauchen ein zweites Tippen.

## Why one app

On the glasses, switching apps costs more than it does on a phone. Status you
want *now* — is the printer done, is the light on — belongs on one surface.
The no-setup apps of Quietglass stay standalone; only the self-hosted group
merges, because those already share the "your own server" shape.

## Screenshots

| Overview | Agent | Alerts |
| --- | --- | --- |
| ![Overview](docs/s0_overview.png) | ![Agent](docs/s1_agent_v2.png) | ![Alerts](docs/s4_alerts.png) |

The phone companion includes QR setup, manual connection settings, language
choice, notification behaviour and a concise control reference:

![Phone settings](docs/phone-settings.png)

## Controls (Even QA compliant)

Quiet Hub starts on a real root overview. The controls follow Even's review
contract:

- **Double tap on Overview** opens `shutDownPageContainer(1)`, the native
  system exit-confirmation dialog. It never silently exits and never substitutes
  a custom dialog.
- **Swipe up/down** moves the selection in the current menu or page.
- **Single tap** opens the selected overview entry or runs the selected action.
- **Double tap on an internal page** returns to Overview; Home and Printer
  require a second single tap before a risky action is sent.
- **Hold on Agent** records from the G2 microphone; releasing sends the note.

Lifecycle events 4–7 are handled explicitly. State is persisted before
backgrounding, microphone/timers/subscriptions are released only after a real
system or abnormal exit, and reconnect never calls the one-shot startup-page
API a second time.

## Pages

| Page | What it shows | Tap action |
| --- | --- | --- |
| **Agent** | Saved tap-questions and the answer | Ask the agent |
| **Zuhause** | Home Assistant devices with state | Switch an allow-listed device |
| **Drucker** | Job, progress, layer, time left, temperatures | Pause, resume, cancel |
| **Meldungen** | Finished/waiting/error events from any agent | Mark as read |

The Overview is a real menu: swipe to select and tap to open. On internal
pages, swipe selects and tap acts. Home and printer changes are armed by one
tap and executed by a second tap within four seconds. Double tap always goes
back, except on Overview where it opens Even's native exit dialog.

## The daemon

One process, three adapters, one token. The glasses see six endpoints and
nothing else:

```
GET  /report          → the whole HubReport (agent + home + printer + inbox)
POST /agent/ask       {question} → {answer}      (routes to Hermes / Claude)
POST /events          {provider,status,title,detail} (completion hook)
POST /events/read     {id}                       (acknowledge event)
POST /home/toggle     {device}                   (routes to Home Assistant)
POST /printer         {action: pause|resume|cancel} (routes to Moonraker)
```

Fast path: `/report` is served from cached state, so the glance is instant —
no LLM sits between you and "72 %". The agent path is the only one that
thinks.

An example daemon lives in `examples/quiet-hub-daemon.mjs` — its agent adapter
is real: a question on the glasses runs `hermes chat -q` against the same
Hermes installation the user chats with (same profile, same memory, same
assistant), and the answer lands back on the display. Home Assistant and
Moonraker start as honest stand-ins behind the same endpoints.

## Status

Built against Even Hub SDK `0.0.16`, `app.json` passes `evenhub pack`,
rendered in the official simulator. **Not yet verified on physical G2
hardware** — see [docs/SDK-CAPABILITIES.md](../../docs/SDK-CAPABILITIES.md)
for what that means.

## Development

```bash
npm install
npm run dev     # vite on 127.0.0.1:5210
npm run sim     # evenhub-simulator (one at a time!)
npm test
npm run build
```

Open `http://127.0.0.1:5210/?demo=1` for the demo data.

## Completion hooks

The daemon stores the newest 50 completion events in
`~/.local/state/quiet-hub/state.json`, including unread state. A runner reports
completion with the generic hook:

```bash
export HUB_TOKEN='the token from .env-hub'
export QUIET_HUB_URL='http://127.0.0.1:8787'
./examples/notify-agent-event.sh Codex done "Tests finished" "42 tests passed"
./examples/notify-agent-event.sh Claude waiting "Approval needed"
```

The same endpoint works for Hermes gateway hooks and OpenClaw callbacks.

## One-command Pi start + QR setup

The repository is expected at `~/quietglass-g2` on the Pi. Then:

```bash
cd ~/quietglass-g2/apps/quiet-hub
npm run pi:start
```

The command creates a private token when needed, installs/enables the two user
services, starts the daemon and Vite server, and prints an Even App QR code.
Scanning it opens Quiet Hub and stores the daemon address plus token through the
SDK's persistent storage. Credentials are encoded in the URL fragment so they
are not sent to the Vite HTTP server.

The phone settings page can also scan that same QR later with the native phone
camera, accepts manual server/token entry, tests the connection, switches
German/English, and controls whether new agent events open automatically.

Useful service commands:

```bash
systemctl --user status quiet-hub-daemon quiet-hub-app
journalctl --user -u quiet-hub-daemon -f
systemctl --user restart quiet-hub-daemon quiet-hub-app
```

## DGX Spark speech and local AI

STT and follow-up generation remain self-hosted. Configure the Pi's private
`.env-hub` (never commit it):

```dotenv
WHISPER_URL=http://<spark-tailscale-ip>:8015/v1/audio/transcriptions
VLLM_URL=http://<spark-tailscale-ip>:8000/v1
VLLM_MODEL=qwen
```

The daemon sends recorded WAV audio to the OpenAI-compatible Whisper endpoint
and uses the Spark vLLM endpoint only for short follow-up suggestions.

## Privacy

The daemon holds every token (Home Assistant long-lived token, agent
credentials). The glasses store only the daemon address and its token. No
conversation history is built. Completion notifications are capped at 50 and
can be removed by deleting the local daemon state file.

## License

MIT.
