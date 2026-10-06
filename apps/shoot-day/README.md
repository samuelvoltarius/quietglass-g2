# Shoot Day

**Quietglass** · Take log, teleprompter, schedule and packing list for a film shoot — from your own server.

> **Auf Deutsch, kurz:** Shoot Day ist dein Drehtag auf der Brille. Im Startmenü
> wählst du ein Modul: **Takes** (Take OK/NG pro Shot mitschreiben, mit Notiz),
> **Teleprompter** (Sprechtext des Projekts abrollen), **Tagesplan** (was läuft
> jetzt, was kommt gleich) und **Packliste** (abhaken, was im Auto liegt – auch
> per Sprache: „Gimbal eingepackt“, „Was fehlt noch?“). Die Daten liegen auf
> deinem eigenen Rechner; dort pflegst du Shotlist, Text, Zeitplan und Packliste
> im Web-Terminal. Die App folgt der Handy-Sprache (Deutsch/Englisch).
>
> **In 3 Schritten loslegen**
> 1. Auf deinem Rechner: `node examples/shoot-day-server.mjs` starten und über
>    https erreichbar machen (z. B. `tailscale serve 8899`).
> 2. In der Even-App bei Shoot Day die https-Adresse eintragen.
> 3. Auf der Brille: **wischen** wählt, **tippen** öffnet, **doppeltippen** geht
>    zurück ins Menü; im Menü fragt doppeltippen, ob die App beendet werden soll.
>
> **Sprache (optional):** Für Sprachbefehle braucht der Server eine
> Whisper-kompatible Spracherkennung (`WHISPER_URL`). Ohne sie funktioniert
> alles per Tippen.

Use `?demo=1` on the development URL to run against built-in sample data
(labelled `DEMO` on the glasses, nothing stored, no server needed).

---

## What it does

One app, four modules, picked from a start menu:

| Module | On the glasses |
|---|---|
| **Takes** | Shot `n/total`, scene, description and size; OK/NG counts and the last take. Tap opens *Take OK · Take NG · Note on last take · Speak · Back*. Swipe changes shot. |
| **Teleprompter** | The project's script, seven lines at a time. Tap plays/pauses, swipe changes speed. |
| **Schedule** | Date and call time, **NOW** and **NEXT** by the clock (with minutes to go), location, contact and the timetable. |
| **Packing list** | Only the items needed for this shoot, `●` packed / `○` open. Tap ticks; **hold to speak**, release to apply. *"What's missing?"* lists the rest. |

Projects, shot list, script, schedule and packing list are edited in the
server's **web terminal** (open the server address in a browser). Every project
carries its own script, schedule and list, so switching projects never leaves
last week's text on the glasses.

### Voice commands

German and English are understood at the same time:

| Packing list | Takes |
|---|---|
| "Gimbal eingepackt" · "the gimbal is packed" | "Szene 2 B OK unscharf" · "scene 2 B OK out of focus" |
| "Regenschutz fehlt" · "rain cover missing" | "NG nochmal" · "no good" |
| "Was fehlt noch?" · "what's missing?" | "nächster" · "next" (moves without logging) |
| "Alles eingepackt" · "everything packed" | |

The microphone opens only while you hold (packing list, take card) or after
you choose *Speak*; the glasses show **● MIC** the whole time, and it closes
after at most 15 seconds.

### Offline on set

A take logged while the server cannot be reached is kept on the phone and sent
the next time the server answers. The menu shows how many are waiting. A tick
on the packing list that does not reach the server is taken back on the
glasses, so what you see is what is stored.

## Setup

### 1. Run the server

```bash
node examples/shoot-day-server.mjs               # http://127.0.0.1:8899/
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8899` | port |
| `HOST` | `127.0.0.1` | bind address. Anything beyond this machine **requires** `TOKEN` |
| `TOKEN` | – | bearer token for every `/api` request (enter it in the phone app and in the web terminal) |
| `DATA_FILE` | `./shoot-day-data.json` | where projects are stored |
| `WHISPER_URL` | – | OpenAI-compatible `/v1/audio/transcriptions` endpoint; voice is off without it |
| `WHISPER_MODEL` | `whisper-1` | model name sent to it |
| `PRESET_LANG` | `en` | language of the packing-list template (`de` or `en`) |

It ships with a neutral example project and a generic packing-list template;
rename, add and remove items in the web terminal.

### 2. Make it reachable over HTTPS

**The app is loaded over HTTPS on the phone, so the server must be reachable
over `https://`.** A plain `http://` address is blocked by the Even app as
mixed content (the phone page warns about it). The simplest way is Tailscale:

```bash
tailscale serve --bg 8899          # → https://<machine>.<tailnet>.ts.net
```

A reverse proxy with a certificate works just as well. `http://127.0.0.1`
works only for local development in the simulator.

### 3. Enter the address on the phone

Open Shoot Day in the Even app, enter the https address (and the token, if
set) and tap **Save and connect**. The status line shows the active project.

### Optional: let an AI agent see the shoot

[`examples/dreh_mcp.py`](examples/dreh_mcp.py) is a dependency-free MCP server
(stdio) with tools for status, schedule, shot list, takes and packing list, plus
"tick an item" and "log a take". Configure it in your MCP client:

```json
{ "command": "python3", "args": ["examples/dreh_mcp.py"],
  "env": { "SHOOTDAY_URL": "http://127.0.0.1:8899", "SHOOTDAY_TOKEN": "…", "SHOOTDAY_LANG": "en" } }
```

## Controls

| Gesture | Menu | Inside a module |
|---|---|---|
| Swipe | choose a module | change shot / speed / selection |
| Tap | open | log, tick, play/pause, reload |
| Hold | – | speak (packing list, take card); release = done |
| Double tap | **leave the app** (the system asks first) | back to the menu |

The swipe direction can be inverted on the phone page.

## Development

```bash
npm install
npm run dev          # http://127.0.0.1:5218  (add ?demo=1 for sample data)
npm run sim          # simulator, automation port 9918
npm test             # vitest
npm run build
npm run pack         # shoot-day.ehpk
npm run server       # the example server
```

Structure: `src/glasses/views.ts` builds every screen as a pure function and is
tested against the 7 × 46 display limit in both languages; `src/voice/` holds
the speech grammars; `src/api/` validates everything the server sends.

## Status

Verified in tests and the Even Hub simulator only. **Not yet verified on
physical G2 hardware** — in particular the long-press/release timing for
speaking, and microphone quality on set.

## Privacy

See [docs/PRIVACY.md](docs/PRIVACY.md). In short: the app talks only to the
server you enter; audio is recorded only while you speak and goes only there.

## License

MIT — see [LICENSE](LICENSE).
