# Quiet Hub — agent, home and printer on one screen

One glance app instead of three: completion alerts from Hermes, Claude, Codex
and OpenClaw, your Home Assistant devices, and your Klipper printer come from a
**single self-hosted daemon**. No accounts, no API keys on the device, no
subscription.

**Kurz auf Deutsch:** Fünf Seiten in einer App — Übersicht, Agent, Zuhause,
Drucker und Meldungen. Ein
eigener Daemon bündelt viele Agenten (Hermes, OpenClaw, Codex, Claude Code – auch auf
anderen Rechnern, mit Freigaben per Tipp auf der Brille und Sprache), Home Assistant
und Moonraker; die Brille spricht nur mit ihm. Riskante Home- und Druckeraktionen brauchen ein zweites Tippen.

## Why one app

On the glasses, switching apps costs more than it does on a phone. Status you
want *now* — is the printer done, is the light on — belongs on one surface.
The no-setup apps of Quietglass stay standalone; only the self-hosted group
merges, because those already share the "your own server" shape.

## Screenshots

Simulator captures at the native 576 x 288 resolution (`?demo=1`, scenes via `&scene=card|busy|long|empty|alerts`).

| Overview | Agent list | Sessions |
| --- | --- | --- |
| ![Overview](docs/v05_overview.png) | ![Agents](docs/v05_agent_list.png) | ![Sessions](docs/v05_sessions.png) |

| Permission card | Long answer (page 1/3) | Tool line while running |
| --- | --- | --- |
| ![Card](docs/v05_permission_card.png) | ![Answer](docs/v05_answer_page.png) | ![Tool](docs/v05_tool_line.png) |

| Voice: recording | Voice: confirm | Alerts |
| --- | --- | --- |
| ![Recording](docs/v05_voice_recording.png) | ![Confirm](docs/v05_voice_confirm.png) | ![Alerts](docs/v05_alerts.png) |

| Busy agent on the overview | Nothing set up yet | English |
| --- | --- | --- |
| ![Busy](docs/v05_overview_busy.png) | ![Empty](docs/v05_overview_empty.png) | ![English](docs/v05_overview_en.png) |

The contextual menu is drawn by the glasses OS on top of the page, so the
simulator capture endpoint does not show it.

The phone companion includes QR setup, manual connection settings, language
choice, notification behaviour and a concise control reference:

![Phone settings](docs/phone-settings.png)

## Controls (Even QA compliant)

Quiet Hub starts on a real root overview. The glasses' native side menu is **off
for now** (`SIDE_MENU = false`, step log from the real glasses, 15.10.2026: its clicks never
reach the app and a hold opens the menu instead of reaching the app), so everything is reachable by gesture.
Every action answers with a short line in the footer, and every page keeps a one-line gesture hint there.

| Input | Glasses (touchpad) | R1 ring |
| --- | --- | --- |
| Swipe up/down | select / turn the page of a long answer | same |
| Tap | open, run, **send** a confirmed voice note; risky actions (**stop** the agent, **allow / deny** a card, device / printer actions) are armed by a tap and carried out by a second tap within 4 s | same |
| 2× (double tap) | back, **only** back (never stops, answers or sends; a voice note is kept); **Overview: Even's native exit dialog** | **page picker** (never exits) |
| Hold | speak into the open session (max 18 s); on Zuhause: details; on a voice note: arms "discard" (one tap confirms); elsewhere: refresh | - |

Help is the last row of the Overview; any gesture closes it. Risky actions (Stop,
Allow / Deny, device, printer, discarding a voice note) only arm; the next tap confirms.
"Quiet while the agent works" and "Mark all read" are set on the phone only.
The code of the side menu (per-page verbs) is kept and can be switched back on.

- **Double tap on Overview** opens `shutDownPageContainer(1)`, the native
  system exit-confirmation dialog. It never silently exits and never substitutes
  a custom dialog.
- **Voice** (hold on the Agent page): `● Aufnahme …` while recording; on release
  the transcript is shown as `Verstanden: …` and **tap sends, double tap
  discards**. "Send immediately" is a phone setting and off by default.
- **R1 ring** (event source 2): swipe selects, tap acts like the glasses; a
  double tap opens the **page picker** (waiting permission cards first, then the
  pages) so the ring can never end the app by accident.
- **Long answers** are split into pages of six rows; swipe turns the page, the
  last page is the question list, a tap on a text page jumps to it. Tool calls
  are one line (`» Bash: npm test`).
- **Permission card**: who asks, `Tool: Bash`, the command, then Erlauben / Ablehnen and the vLLM's replies
  for this card (a deny reply goes to the agent as its next message);
  `Tippen = senden · Wischen = wählen · 2× = zurück` - a tap arms the row (`Nochmal tippen = Erlauben`), a second tap
  sends it; swipe, 2× or 4 s without input disarm (2× leaves the card waiting).
- Input is read defensively: a missing `eventType` is a CLICK, a missing
  `currentSelectItemIndex` is 0, one swipe (a burst of scroll events) counts
  once (300 ms cooldown), selections live in the app state.
- Opening the app from the glasses launcher (`glassesMenu`) lands on the
  Overview; from the phone app menu it resumes the last page.

Lifecycle events 4-7 are handled explicitly. State is persisted before
backgrounding, microphone/timers/subscriptions are released only after a real
system or abnormal exit, and reconnect never calls the one-shot startup-page
API a second time.

## Pages

| Page | What it shows | Tap action |
| --- | --- | --- |
| **Overview** | Online agents with dots (`●` idle, `*` busy, `!` waiting, `○` offline), unread alerts, lights on, printer progress, what needs you | Open the selected page |
| **Agent** | Agents -> sessions -> session; streaming answer in pages, tool line, permission cards | Open / ask / allow (tap arms, second tap confirms) |
| **Zuhause** | Home Assistant: favourites, then areas (list left, state right); per area "Alle Lichter" / "Alle Rollos", sensors read-only | Switch / run a scene / open an area; hold = light or blind detail |
| **Drucker** | Job, progress, layer, time left, temperatures | Pause, resume, cancel |
| **Meldungen** | Finished/waiting/error events from any agent (with the agent id) | Mark as read |
| **Tagesstart** | Morning briefing: today's calendar, weather + rain nowcast, last night's glucose, car, printer, servers | Reload (swipe = next page) |

The Overview is a real menu: swipe to select and tap to open. Nothing has to
be set up for it: agents appear by themselves as soon as a relay connects, and an
empty page says in one line what is missing. The header is a fixed status line:
`page · connection · unread · busy agents · waiting`. On internal
pages, swipe selects and tap acts. Printer changes are armed by one tap and
executed by a second tap within four seconds; on Zuhause a tap switches at once,
only locks, alarm and garage need a second tap (see below). Double tap always goes
back, except on Overview where it opens Even's native exit dialog.

## The daemon

One process, one token. The glasses see these endpoints and nothing else:

```
GET  /report                 the whole HubReport (agents + approvals + home + printer + inbox)
GET  /report?since=<rev>&boot=<id>&wait=25   long-poll: held until the report changes (rev/boot/live in every report)
GET  /agents                 every agent with online/busy/answer
POST /agent/ask              {agentId, question, wait?}   (wait:false = answer streams into /report)
POST /agent/voice?agentId=   WAV body (or JSON base64) -> Whisper -> ask (ask=0: transcript only)
POST /agent/approve          {cardId, decision: allow|deny}
POST /agent/cancel           {agentId}                    (real stop, see Sessions)
GET  /agent/sessions?agentId=                              (session list of an agent)
POST /agent/session/new      {agentId}
POST /agent/session/select   {agentId,sessionId,title}
POST /events                 {provider,status,title,detail}  (completion hook)
POST /events/read            {id}
POST /home/toggle            {device}                     (Home Assistant, allow-listed; older apps)
GET  /home                   the Zuhause view (also in /report as `homeView`)
POST /home/action            {target, action, value?}     (toggle|turn_on|turn_off|brightness|open|close|stop|run)
POST /home/confirm           {token}                      (second step for lock / alarm / garage)
POST /printer                {action: pause|resume|cancel} (Moonraker)
GET  /brief                  Tagesstart (cached ~2 min; ?refresh=1 asks every source again; also in /report as `brief`)
GET  /brief/appointments     today's appointments only, with coordinates (for OpenGlance; calendar + geocoding, no weather)
```

The relays use a few more (`/relay/register`, `/relay/poll`, `/relay/result`,
`/relay/reply`, `/relay/permission`), all with the same bearer token.

Fast path: `/report` is served from cached state, so the glance is instant. The
agent path is the only one that thinks.

Without `HA_URL`/`HA_TOKEN` and `MOONRAKER_URL` the Home and Printer pages show
stand-ins that are clearly labelled **DEMO**.

## Tagesstart (0.8.0)

**Deutsch.** Die Seite *Tagesstart* ist das Morgen-Briefing: ein Tippen, alles auf
einen Blick. Der **Daemon** holt alle Quellen selbst – Adressen und Tokens bleiben
in seiner Env-Datei, die Brille bekommt nur fertige Werte. Jeder Block ist
optional (nicht gesetzt = ausgeblendet; nur der Kalender sagt „keine
Kalenderquelle“), hat ein eigenes Zeitlimit (`BRIEF_TIMEOUT_MS`, Standard 6 s)
und wird ~2 min zwischengespeichert (`BRIEF_CACHE_MS`). Fällt eine Quelle aus,
zeigt der Block bis 30 min lang die letzten Werte mit „alt“, danach „nicht
erreichbar“ – die anderen Blöcke bleiben unberührt.

```
Termine · 4 heute
  ganztags · Geburtstag Lena
  09:00–09:15 · Stand-up
  11:30–12:15 · Zahnarzt
Wetter · 9° bedeckt · 6–15° · Regen ab 14:00
Zucker · 118 mg/dL → · vor 3 min · nur Info
  Nacht 84–192 · <70: 0 min · >180: 25 min
Auto · 78 % · 296 km · geladen · zu
Drucker · druckt 72 % · noch 41 min · esp32_gehaeuse
Server · alle 3 ok · 1 neues Gerät
```

| Geste | Tagesstart |
| --- | --- |
| Wischen | nächste / vorige Seite (ganze Blöcke, Fußzeile „1/2“) |
| Tippen / Halten | neu laden (alle Quellen) |
| 2× | zurück zur Übersicht |

Erreichbar über die fünfte Zeile der Übersicht und die Seitenwahl (Ring). Am Handy: Tab **Tagesstart** mit denselben Blöcken und
der Einstellung **„Tagesstart als Startseite bis 11:00“** – dann öffnet die App
vormittags direkt den Tagesstart (auch beim Start aus dem Brillen-Launcher).

| Block | Env (Daemon) | Quelle | Zeigt |
| --- | --- | --- | --- |
| Termine | `BRIEF_ICS_URLS` (Komma-Liste, `webcal://` geht) | ICS/iCal-Abo (z. B. „private Adresse“ von Google/iCloud/Nextcloud) | heutige Termine; ganztägig/mehrtägig, TZID, Serien DAILY/WEEKLY (INTERVAL, COUNT, UNTIL, BYDAY), einfache MONTHLY/YEARLY, EXDATE, verschobene Einzeltermine |
| Termine (Shoot Day) | `BRIEF_SHOOT_URL` (+ `BRIEF_SHOOT_TOKEN`) | Shoot-Day-Server `GET /api/projects` und `/api/customers` | heutige Projekte (Datum `2026-10-14 10:30`, `2026-10-14` oder `14.10.2026 10:30`) als „Kunde – Projekt“ mit Ort, gemischt mit den ICS-Terminen (gleiche Zeit + ähnlicher Titel = einmal) |
| Wetter | `BRIEF_TZ`; `BRIEF_LAT`/`BRIEF_LON` nur noch als Ausweichort; `BRIEF_GEOCODE_URL` | Open-Meteo (ohne Schlüssel) | **hier** (Handy-Standort, auf ~1 km gerundet, kommt als `?lat=&lon=`; ohne Standort der Ausweichort) – jetzt, Min/Max, „Regen ab 14:00“ – plus je Termin heute mit Ort (max. 3) die Vorhersage **zur Terminstunde am Terminort**: `10:30 Musterdorf 9° · Regen 60%` (Wind ab 30 km/h). Termine < 10 km vom Standort bekommen keine eigene Zeile. Der Ort (ICS `LOCATION`, Shoot-Day-Ort) wird über die Open-Meteo-Ortssuche gefunden (erst ganzer Text, dann Teil nach dem letzten Komma, dann Ort ohne PLZ; nur der Ortstext verlässt den Daemon; 7 Tage gemerkt); eine Vorhersage je Ort, ~10 min gemerkt |
| Auto | `BRIEF_BYD_URL` (+ `BRIEF_BYD_TOKEN`) | BYD-Bridge `GET /state` (`selfhost/services/byd-bridge`) | Akku %, Reichweite, lädt/geladen, zu/offen |
| Zucker | `BRIEF_SUGAR_URL` (+ `BRIEF_SUGAR_TOKEN`) | Sugar-Bridge `GET /api/v1/entries/sgv.json` (`selfhost/services/sugar-bridge`) | Wert, Trend, Alter; Nacht 22–07: Min/Max, Minuten <70 / >180 |
| Drucker | `BRIEF_KLIPPER_URL` (+ `BRIEF_KLIPPER_TOKEN`) | Klipper-Glance-Bridge `GET /api/printer`; ohne: `MOONRAKER_URL` des Daemons | Zustand, Datei, %, Restzeit |
| Server | `BRIEF_STATUS_URLS` = `Name\|URL,…` (+ `BRIEF_STATUS_TOKEN`) | Status-Glass-Referenzserver `/status` | ok/weg je Rechner, neue Geräte im Heimnetz |

Standort: Die App fragt das Handy beim Laden des Tagesstarts (Berechtigung
`location`, einmal gefragt; 4 s Zeitlimit, 30 min gemerkt) und sendet nur die auf
2 Nachkommastellen (~1 km) gerundeten Werte. Der Daemon prüft sie (Zahlen, Bereich;
sonst `400`), schreibt sie nie ins Zugriffsprotokoll und gibt im Wetterblock
`place: "here"|"default"` zurück („Wetter hier“ / „Wetter (Standard)“).

Weitere: `BRIEF_TZ` (Tagesgrenzen und Uhrzeiten; Standard = Zeitzone des
Rechners), `BRIEF_CACHE_MS=120000`, `BRIEF_TIMEOUT_MS=6000`,
`BRIEF_WEATHER_URL` (eigene Open-Meteo-Instanz), `BRIEF=off` schaltet `/brief`
ab. Die Bridges erlauben Tailscale-Logins nur über `tailscale serve`; ruft der
Daemon sie über ihre `https://<host>.<tailnet>.ts.net:<port>`-Adresse auf und
gehört der Daemon-Rechner nicht demselben Login, den Bridge-Token als
`BRIEF_*_TOKEN` setzen (nie ins Repo).

> **Zuckerwerte nur zur Information – keine Therapieentscheidungen.** Maßgeblich
> sind Pumpe, Sensor und deren Alarme.

**Deploy (Daemon-Update).** Der Daemon importiert das neue
`examples/quiet-hub-brief.mjs` – mit der Selfhost-Unit (läuft aus dem
Repo-Checkout) bringt es `git pull`, sonst alle `examples/quiet-hub-*.mjs` neben
`quiet-hub-daemon.mjs` kopieren. Die `BRIEF_*`-Variablen in die Env-Datei des
Daemons (`.env-hub`, Vorlage `.env-hub.example`) eintragen, dann
`systemctl --user restart quiet-hub-daemon` und prüfen:
`curl -s -H "Authorization: Bearer $HUB_TOKEN" http://127.0.0.1:8787/brief | head -c 400`
(jeder Block `"status":"ok"` oder `"off"`; `"error"` nennt den Grund ohne
Adresse). Die Startzeile des Daemons listet die aktiven Blöcke (`brief: calendar+weather+…`).
Die Brillen-App (0.8.0) braucht keine neue Whitelist: sie spricht nur mit dem
Daemon.

**English.** *Tagesstart* (day start) is a morning briefing collected by the
daemon (`GET /brief`, same auth as `/report`, cached ~2 min, `?refresh=1`
forces). Blocks: calendar from ICS URLs, Open-Meteo weather with a rain
nowcast, glucose from the sugar bridge (last night 22–07: min/max, minutes
below 70 / above 180 – information only), car from the BYD bridge, printer from
the Klipper bridge or the daemon's Moonraker, servers from Status Glass
reference servers. Every block is optional with its own timeout. On the
glasses swipe pages, tap reloads, double tap goes back; the phone has a
*Tagesstart* tab and the setting "day start as the start page until 11:00".

### Termine für OpenGlance (`GET /brief/appointments`)

Jeder Termin im Kalenderblock trägt jetzt `startIso` (ISO mit Offset, z. B.
`2026-10-14T10:30:00+02:00`) und `allDay`; hat er einen Ort, den die
Ortssuche findet, außerdem `lat`, `lon` und `placeLabel` (gleicher 7-Tage-Speicher
wie das Wetter am Terminort, eine Anfrage je Ort). `GET /brief/appointments`
(gleiche Anmeldung wie `/report`) antwortet nur mit
`{date, at, status, events: [{time, end, title, place, allDay, startIso, lat?, lon?, placeLabel?}]}`
– aus der letzten Liste, solange sie jünger als 2 min ist, sonst Kalender +
Ortssuche neu (kein Wetter, keine anderen Blöcke; eine Abfrage zur Zeit). Die
Ortssuche wartet höchstens 3 s, ein späterer Treffer kommt beim nächsten Mal.
Koordinaten und Titel stehen in keinem Protokoll (Zugriffsprotokoll: nur Pfad,
Status, Dauer). Prüfen:
`curl -s -H "Authorization: Bearer $HUB_TOKEN" http://127.0.0.1:8787/brief/appointments | head -c 400`.
Deploy wie oben (die `examples/quiet-hub-*.mjs` + Neustart).

**English.** `GET /brief/appointments` returns today's appointments with
`startIso`, `allDay` and, when the place is found, `lat`/`lon`/`placeLabel`,
for the OpenGlance navigation app. Calendar + geocoding only, cached 2 min,
same bearer auth; coordinates are never logged.

## Agenten verbinden / Connect agents

**Deutsch.** Der Daemon spricht selbst nur mit seinem eigenen Hermes
(Standard-ID `hermes-pi5`). Alle weiteren Agenten – mehrere Hermes, OpenClaw,
Codex, Claude Code, auch auf anderen Rechnern (Windows, Linux, macOS) – hängen
sich über ein **Relay** an: `examples/quiet-hub-relay.mjs` (Node ≥ 22, keine
Abhängigkeiten). Das Relay baut nur eine **ausgehende** HTTPS-Verbindung zum
Daemon auf (Long-Poll mit `HUB_TOKEN`), braucht also keinen offenen Port.

**English.** The daemon itself only talks to its own Hermes (default id
`hermes-pi5`). Every other agent — more Hermes, OpenClaw, Codex, Claude Code,
also on other machines (Windows, Linux, macOS) — attaches through a **relay**:
`examples/quiet-hub-relay.mjs` (Node >= 22, no dependencies). It only makes an
**outbound** HTTPS connection (long-poll with `HUB_TOKEN`), so no open port is
needed.

### relay.json

```json
{
  "machine": "windows-pc",
  "agents": [
    { "id": "claude-win",   "kind": "claude",   "cwd": "C:/work/project", "mode": "ask" },
    { "id": "codex-win",    "kind": "codex",    "cwd": "C:/work/project", "mode": "ask" },
    { "id": "hermes-spark", "kind": "hermes",   "bin": "hermes" },
    { "id": "claw",         "kind": "openclaw", "url": "http://127.0.0.1:18789", "tokenEnv": "OPENCLAW_TOKEN" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `machine` | Name of this PC; shown in the agent list. One relay per machine. |
| `id` | Unique across the whole hub (letters, digits, `.`, `_`, `-`). Shown on the glasses and as the inbox "provider". |
| `kind` | `claude`, `codex`, `hermes` or `openclaw`. |
| `cwd` | Working folder of the agent (claude/codex/hermes). On Windows use `C:/work` or `C:\\work`. |
| `mode` | `ask` (default for claude/codex): every write/command waits for a yes/no on the glasses. `auto`: no questions (Claude `bypassPermissions`, Codex `workspace-write`, never ask). `plan`/`readonly`: read-only. `full` (Codex): no sandbox at all. **You opt in per agent.** |
| `bin` | Executable if it is not on `PATH`. |
| `model`, `args`, `timeoutMs`, `brief` | Optional. `brief:false` stops the relay from asking for glasses-sized answers. |
| `url`, `token` / `tokenEnv` | OpenClaw gateway (OpenAI-compatible `/v1/chat/completions`, bearer token). Prefer `tokenEnv` so no token sits in the file. |
| `bridge` | Hermes only: `{"url":"ws://127.0.0.1:8765","tokenEnv":"EVENHUB_BRIDGE_TOKEN"}` — the hermes-evenhub-bridge plugin. Real sessions and a real stop. The token is read at runtime from the relay's environment or `~/.hermes/.env` (or `bridge.envFile`) and never stored in `relay.json`. Without a bridge, or while it is down, the relay falls back to `hermes chat -q`. |
| `continue` | Claude only: `true` makes a prompt without a chosen session use `claude -p --continue`. |
| `engine` | Codex only: `"exec"` uses `codex exec` (cannot ask; read-only for `ask`). Default is `codex app-server`, which can ask. |

`relay*.json` is git-ignored (only `relay.example.json` is tracked).

### Run it on Windows

```powershell
$env:HUB_TOKEN = '<token from the Pi: grep HUB_TOKEN ~/quietglass-g2/apps/quiet-hub/.env-hub>'
node quiet-hub-relay.mjs --hub https://<hub>.<tailnet>.ts.net --config relay.json
```

(`--token <value>` and `--token-file <path>` also work; the env variable keeps the
token out of the process list.) Copy `quiet-hub-relay.mjs`, `quiet-hub-agents.mjs` **and**
`quiet-hub-approve-mcp.mjs` into the same folder if you do not clone the repo.
The relay survives hub restarts and network drops (it re-registers with
back-off), caps all output (4 kB to the hub), never prints the token, and stops
a running agent when you double-tap on the glasses.

Autostart is deliberately not installed. On Windows you can create a Task
Scheduler entry that runs the command above at logon; on Linux use the user
service `deploy/quiet-hub-relay.service` (instructions at the top of the file):

```bash
systemctl --user enable --now quiet-hub-relay
loginctl enable-linger $USER
```

### How approvals work

- **Claude Code** runs as `claude -p ... --output-format stream-json --verbose`
  in `cwd`. In mode `ask` the relay adds `--permission-prompt-tool
  mcp__quiethub__approve` and a tiny stdio MCP server
  (`quiet-hub-approve-mcp.mjs`). Each permission request becomes a **card** on
  the glasses (`Bash: npm test`, `Edit: src/a.ts`): **tap = allow, swipe + tap =
  deny or a reply, double tap = back (card keeps waiting)**, no answer for 2 minutes = deny. Follow-up questions resume the same
  Claude session. The MCP config file holds no secret (`${QUIET_HUB_TOKEN}` is
  expanded from the child environment).
- **Codex** runs through `codex app-server` (JSON-RPC, no PTY) with
  `approvalPolicy on-request` + `workspace-write` in mode `ask`; command, file
  change and permission requests become the same cards. Protocol handling is
  adapted from sunasaji/terminal-mode-console (MIT), see `NOTICE.md`. With
  `"engine": "exec"` Codex cannot ask and stays read-only.
- **Hermes** and **OpenClaw** have no per-action permission prompts; they run
  as configured on their machine.

### Sessions and Stop

Every agent has sessions you can see, create and select on the glasses
(agent list → session page → open session). The session page lists
`+ New session`, `» Continue: <title>` and the agent's recent sessions.

| Agent | List | New | Continue | Stop |
| --- | --- | --- | --- | --- |
| Hermes via bridge | `sessions.list` | `sessions.new` | `sessions.switch` | `{"t":"stop"}` |
| Hermes via CLI (fallback) | `hermes sessions list` | next prompt starts one | `hermes chat -q … --resume <id>` | process-tree kill |
| Claude Code | `~/.claude/projects/<cwd>/*.jsonl` | no flag | `claude -p --resume <id>` (or `--continue`) | process-tree kill |
| Codex (app-server) | `thread/list` | `thread/start` | `thread/resume` | `turn/interrupt` + process-tree kill |
| OpenClaw | — | clears the history | — | aborts the request |

Stop is **armed by a tap** while an agent is running and
carried out by a second tap within 4 s; the footer reads `Nochmal tippen = stoppen`.
Swipe, 2× and 4 s without input cancel. The double tap never stops (QIS v1). The daemon answers at once
(`stopped:true` in `/report`, shown as `[gestoppt]`) and the relay confirms
when the process or turn is really gone (`stopConfirmed`). Process trees are
ended with `taskkill /T /F /PID` on Windows and by signalling the process group
(children are started detached) on Linux/macOS. The glasses footer always
follows QIS v1 (`docs/BEDIENSTANDARD.md`): `Tippen = ... · Wischen = ... · Halten = ... · 2× = zurück`
(`2× = Ende` on the overview), header `QUIET HUB · state`.

Voice: hold the touchpad on the open session (max 18 s). The G2 microphone
(16 kHz, 16 bit, mono) becomes a WAV, the daemon transcribes it with the
Whisper endpoint (`WHISPER_URL`) and shows `Verstanden: …`; a tap sends the text
into the selected session, a double tap discards it. While recording, tap ends
and double tap discards the recording. Errors
are spelled out on the glasses (`Mikrofon nicht freigegeben`,
`Spracherkennung nicht erreichbar`, `Nichts verstanden`).

### Completion events from your own sessions

The relay reports finished/failed answers by itself. For sessions you start
by hand, hook the CLIs (cross-platform script `examples/notify-agent-event.mjs`,
or `notify-agent-event.sh` on Linux):

Claude Code, `~/.claude/settings.json`:

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command",
  "command": "node /path/to/notify-agent-event.mjs claude-win done \"Claude fertig\"" } ] } ] } }
```

Codex, `~/.codex/config.toml`:

```toml
notify = ["node", "/path/to/notify-agent-event.mjs", "codex-win", "done", "Codex fertig"]
```

with `HUB_TOKEN` and `QUIET_HUB_URL` set in the environment of those sessions.

### Voice

Hold on the Agent page: the glasses record, the daemon sends the WAV to
`WHISPER_URL` (OpenAI-compatible, default `http://127.0.0.1:8017/v1/audio/transcriptions`)
and returns the transcript (`POST /agent/voice?ask=0` = transcribe only); the
glasses show it and ask the **selected** agent after your tap. Without `ask=0`
(older apps, or "send immediately" on the phone) the daemon asks right away.

## Home Assistant

1. In Home Assistant open your **profile** (bottom left) -> **Security** ->
   **Long-lived access tokens** -> **Create token**; copy it once.
2. In the Pi's `.env-hub` (never committed):

```dotenv
HA_URL=http://homeassistant.local:8123
HA_TOKEN=<the token>
HA_DEVICES=light.office=Büro Licht,switch.printer_plug=Drucker Steckdose,sensor.living_temp=Wohnzimmer
```

`HA_DEVICES` is the **allow-list** of the old flat device list (older apps):
only those entity ids are shown, and only `light`, `switch`, `fan`,
`input_boolean`, `automation`, `cover`, `climate`, `lock`, `media_player`,
`script`, `scene` can be switched (sensors are read-only). The token never
leaves the daemon.

### Zuhause page (0.7.0)

**Deutsch.** Die Seite *Zuhause* zeigt links eine Liste – zuerst die
**Favoriten**, dann die **Räume** – und rechts den Zustand der gewählten Zeile.
Ein Raum enthält oben „Alle Lichter“ / „Alle Rollos“ (ab zwei Geräten), dann
Lichter, Schalter, Rollos, Szenen und zuletzt Sensoren (Temperatur, Feuchte,
Bewegung, Akku – nur Anzeige). Der Daemon holt den Zustand alle paar Sekunden
von Home Assistant (`HA_POLL_MS`, Standard 5000) und gibt Änderungen über den
bestehenden Long-Poll von `/report` sofort an die Brille weiter. URL und Token
bleiben im Daemon; die Brille sieht nur die kuratierte Ansicht.

| Geste | Liste / Raum | Licht-Detail | Rollo-Detail |
| --- | --- | --- | --- |
| Wischen | Zeile wählen | heller / dunkler (10 %) | auf / zu |
| Tippen | schalten, Szene starten, Raum öffnen | an / aus | Stopp |
| Halten | Licht/Rollo: Detail öffnen (sonst: aktualisieren) | – | – |
| 2× | Raum → Liste → Übersicht | zurück | zurück |

Schlösser, Alarmanlage und Garagentor/Tor sind **ausgeblendet**, solange
`HA_SENSITIVE` sie nicht nennt. Eingeschaltet brauchen sie immer zwei Schritte:
das erste Tippen holt beim Daemon nur einen Bestätigungs-Code (einmalig,
30 s gültig), die Fußzeile zeigt „Nochmals tippen: Haustür: aufsperren (9s)“,
erst das zweite Tippen auf dieselbe Zeile führt aus. Wischen oder 2× verwirft.

Daemon-Konfiguration (`.env-hub` bzw. `~/.config/quietglass/quiet-hub-daemon.env`):

```dotenv
HA_URL=http://homeassistant.local:8123
HA_TOKEN=<long-lived token>
# Favourites in this order (entity_id[=label]); empty = HA_DEVICES
HA_FAVORITES=scene.abend=Abendlicht,light.buero,cover.wohnzimmer,sensor.aussen_temperatur
# auto = every HA area (default) | off = favourites only | names or ids in this order
HA_AREAS=Wohnzimmer,Büro,Schlafzimmer
# never show these
HA_EXCLUDE=switch.server_power
# lock, alarm, garage: hidden unless named here; then always two-step
HA_SENSITIVE=
HA_POLL_MS=5000
# HA_HOME=off switches the page off (the old device list stays)
```

Areas come from one read-only template call (`POST /api/template` with
`areas()` / `area_entities()`), refreshed every 5 min; if your Home Assistant
refuses it, only the favourites are shown. Only `light`, `switch`,
`input_boolean`, `fan`, `cover`, `scene`, `script`, temperature / humidity /
battery sensors and motion / occupancy / presence binary sensors are ever
shown – plus `lock`, `alarm_control_panel` and garage/gate covers when
`HA_SENSITIVE` allows them. Actions are checked against the entity's kind and
the current view; the glasses can never call another HA service.

The favourites order lives in the daemon config (not on the phone); the phone's
**Zuhause** tab shows the same list read-only and says where to change it. In
the demo (`?demo=1`) the page has favourites, three areas and a demo lock.

**Deploy (daemon update).** The daemon imports the new
`examples/quiet-hub-home.mjs`, so it must sit next to `quiet-hub-daemon.mjs`:
with the selfhost unit (runs from the repo checkout) a `git pull` brings it,
otherwise copy the three `examples/quiet-hub-*.mjs` it imports. Add the
variables above to the daemon env file, then
`systemctl --user restart quiet-hub-daemon` and check
`curl -s -H "Authorization: Bearer $HUB_TOKEN" http://127.0.0.1:8787/home | head -c 300`
(`"configured":true`). The glasses app (0.7.0) falls back to the old device list
with older daemons.

### Phone mirror (optional)

When Home Assistant is configured, **waiting / done / error** events and a
**finished print** are also sent to HA's notify service, so the phone
notification can be mirrored to the glasses by the Even app. `HA_NOTIFY_SERVICE`
(e.g. `notify.mobile_app_pixel`) pins the service; otherwise the daemon finds
the first `notify.mobile_app_*` through a read-only `GET /api/services`. No
service found = nothing is sent. `HA_NOTIFY=off` disables it.

## Printer (Moonraker)

`MOONRAKER_URL=http://<printer-ip>:7125` in `.env-hub`. The Printer page shows
job, progress, layer, remaining time and temperatures; pause/resume/cancel go to
`/printer/print/*` after a second tap. To find the printer on a LAN
(read-only scan of port 7125):

```bash
node scripts/find-moonraker.mjs 192.168.0
```

## Limitations

- Claude and Codex approvals need a CLI that is **logged in** on that machine
  (`claude auth login`, `codex login`). An expired login shows up as the
  agent's answer/error on the glasses.
- Codex approvals use the experimental `codex app-server` protocol; a future
  Codex version can change it (`"engine": "exec"` is the fallback, read-only).
- Hermes without a bridge continues a session only when the CLI prints its id (`hermes chat --resume`); OpenClaw keeps a short in-memory history.
- Not yet verified on physical G2 hardware.

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

**Pairing must use the https URLs.** The installed Even Hub app runs on an
https origin, so the browser blocks an `http://` daemon as mixed content (the app
now says "Server muss https sein" instead of failing silently). `npm run pi:start`
reads `tailscale serve status --json` and puts the Tailscale HTTPS names in the QR
(the https port proxying to `127.0.0.1:8787` is the server, the one proxying to
`:5210` the app, e.g. `https://<pi>.<tailnet>.ts.net:8443`). Without those
mappings it falls back to `http://` with a printed warning - fine for the
simulator or a desktop browser, not for the installed app. The script never
changes your `tailscale serve` setup.

**Network whitelist.** Per the Even Hub docs the app's `app.json` network
whitelist takes one full origin per entry; bare hostnames and wildcards are not
supported, and the Even App blocks everything not listed (no traffic at all). The
repository ships generic `http://*` / `https://*` entries; for an installed build
repack with your exact server origin, e.g. `"https://<pi>.<tailnet>.ts.net:8443"`
(and the origin without port if you serve on 443), without committing it. On
failure the phone page shows the raw error text ("Technisch: ...") so a whitelist
block ("Load failed" with no request in the daemon's access log) can be told from
a network error.

The Overview never shows demo data when the daemon cannot be reached: it says
"Nicht verbunden", the exact reason (server missing, unreachable, wrong token,
timeout, not https) and the server host, retries by itself (2, 5, 10, then every
30 s) and on a tap. Demo data exists only behind `?demo=1`. The phone page shows
the same status, last success/error and a "Verbindung testen" button. The daemon
writes one access line per request (time, client IP, method, path, status, ms;
no tokens, relay heartbeats skipped) to the journal:
`journalctl --user -u quiet-hub-daemon -f | grep '\[access\]'`.

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
WHISPER_URL=http://<spark-tailscale-ip>:8017/v1/audio/transcriptions
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
