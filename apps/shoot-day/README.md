# Shoot Day

**Quietglass** · Customers, storyboards, take log, teleprompter, schedule, packing list and the light of the day for a film or photo shoot — from your own server.

> **Auf Deutsch, kurz:** Shoot Day ist dein Drehtag auf der Brille. Ganz oben
> stehen deine **Kunden** (nach Name sortiert; neuer Kunde auch per Sprache an der
> Brille), darunter je Kunde die **Projekte** und die Karte **„Kunde vor dem
> Termin“** (Notizen, offene Ideen, letzte Änderung, auf Wunsch Babels
> Gesprächsnotizen). Im Projekt wählst du ein Modul: **Storyboard** (Szenenkarten
> beim Dreh: Szene n/gesamt, Zeit, Titel, Kamerahinweis, Texteinblendung; Wischen
> = nächste Szene, Tippen = erledigt), **Takes** (Take OK/NG pro Shot mitschreiben, mit Notiz),
> **Teleprompter** (Sprechtext des Projekts abrollen), **Tagesplan** (was läuft
> jetzt, was kommt gleich) und **Packliste** (abhaken, was im Auto liegt – auch
> per Sprache: „Gimbal eingepackt“, „Was fehlt noch?“) und **Licht & Sonne**
> („GOLDENE STUNDE in 42 min“, Sonne mit Kompassrose, Sonnenbogen, Untergang,
> blaue Stunde und das Licht beim nächsten Shooting – offline am Handy
> berechnet, auch ohne Server). Die Daten liegen auf
> deinem eigenen Rechner; dort pflegst du im Web-Terminal Kunden (Name, Firma,
> Telefon, E-Mail, Notizen), Projekte und deren Inhalte: Storyboard (auch als
> Vorschlag aus einer PDF), Shotlist, Ideen mit Stichwörtern, Skript, Tagesplan,
> Packliste und Dateien (PDF/PNG/JPEG). Die App folgt der Handy-Sprache
> (Deutsch/Englisch).
>
> **In 3 Schritten loslegen**
> 1. Auf deinem Rechner: `node examples/shoot-day-server.mjs` starten und über
>    https erreichbar machen (z. B. `tailscale serve 8899`).
> 2. In der Even-App bei Shoot Day die https-Adresse eintragen.
> 3. Auf der Brille: **wischen** wählt, **tippen** öffnet, **doppeltippen** geht
>    eine Ebene zurück (Modul → Menü → Projekte → Kunden); in der Kundenliste
>    fragt doppeltippen, ob die App beendet werden soll.
>    *Hilfe* ist die letzte Zeile der Liste, *Letzten Take löschen* eine Zeile
>    im Take-Menü (vormerken, nochmal tippen). Beim Sprechen **bricht 2×** die
>    Aufnahme ab. Das Seitenmenü der Brille ist aus (`SIDE_MENU = false`): seine
>    Klicks kommen auf der echten Brille nicht an.
>    Ohne Server-Adresse startet die App als **Demo** mit Beispieldaten.
>
> **Sprache (optional):** Für Sprachbefehle braucht der Server eine
> Whisper-kompatible Spracherkennung (`WHISPER_URL`). Ohne sie funktioniert
> alles per Tippen.

Use `?demo=1` on the development URL to run against built-in sample data
(labelled `DEMO` on the glasses, nothing stored, no server needed).

---

## What it does

Three levels on the glasses (with a server from 0.5.0 on; an older server
simply shows the module menu as before):

1. **Customers**, sorted by name, with *+ New customer* on top — tap it (or
   hold anywhere in the list) and say the name; the glasses show it and ask
   before anything is saved (tap = create, hold = say it again, 2× = back
   without saving). A name that exists already selects that customer instead.
2. **The customer's projects** (newest date first, `●` = the one the glasses
   work on), headed by **Customer before the appointment**: company, phone,
   e-mail, last change, the notes, the open ideas with their keywords, and —
   if the server has `SHOOT_BABEL_URL` — the last matching entries of Babel's
   memory. Swipe pages through it.
3. **The project's modules**:

| Module | On the glasses |
|---|---|
| **Storyboard** | One card per scene while shooting: `SCENE 2/7 · 0:05–0:12`, `●`/`○` and the title, what happens, the camera hint, the text overlay and the goal. Swipe = next/previous scene, tap = mark done (or open again; saved on the server, taken back if it does not get there), 2× = other storyboard (if there are several) or the menu. |
| **Takes** | Shot `n/total`, scene, description and size; OK/NG counts and the last take. Tap opens *Take OK · Take NG · Note on last take · Speak · Delete last take · Back*. Swipe changes shot. *Take OK* is a single tap and can be undone with the take action *Delete last take*. |
| **Teleprompter** | The project's script, seven lines at a time. Tap plays/pauses, swipe changes speed. |
| **Schedule** | Date and call time, **NOW** and **NEXT** by the clock (with minutes to go), location, contact and the timetable. |
| **Packing list** | Only the items needed for this shoot, `●` packed / `○` open. Tap ticks; **hold to speak**, release to apply. *"What's missing?"* lists the rest. |
| **Light & sun** | Full-screen picture: **GOLDEN HOUR in 42 min (19:12–19:48)** (or the blue hour; *now · 18 min left* while it runs), a compass rose with the sun on it, a small sun-path arc of the day with the current position, sunset and blue hour, sunrise and the sun's highest point, the moon phase, and the next shoot: *Shoot 18:30: sun 12° WSW, golden hour from 19:12*. Swipe looks ±30 min ahead/back, tap returns to now. Works without a server. |

Everything is edited in the server's **web terminal** (open the server address
in a browser): on the left the customers, sorted by name, with a search field
and *New customer*; a customer page with every field (name, company, phone,
e-mail, notes), the projects and *New project*; a project page with name, date,
place, its customer (to move it) and *Show on the glasses*, and tabs for
**Storyboard · Shot list · Ideas · Script · Schedule · Packing list · Files**.
Files (PDF, PNG, JPEG, up to `SHOOT_MAX_UPLOAD_MB`) are dropped onto the page.
Every project carries its own content, so switching projects never leaves last
week's text on the glasses. Deleting asks first; a customer with projects is
only deleted after you said whether its projects go too or move to
*Ohne Zuordnung / Unassigned*.

### Storyboard from a PDF

*Storyboard from PDF* (Storyboard tab, or next to a PDF in Files) reads the
text out of the PDF on the server — a small dependency-free extractor:
FlateDecode streams, object streams, `Tj`/`TJ`/`'`/`"` with ToUnicode maps
(what Canva, Word and most layout programs write). It cannot read scanned
pages (pictures of text), encrypted PDFs, filters other than Flate, or Type3
fonts; then it says so. The text goes to your own language model
(`SHOOT_LLM_URL`, OpenAI-compatible, `chat_template_kwargs.enable_thinking =
false`) with the request to answer with the scenes as strict JSON (number,
from/to seconds, title, what happens, camera, text overlay, goal). The
proposal opens as an editable table — nothing is stored until you check it and
press *Save*. Without `SHOOT_LLM_URL`, or when the model's answer is not
usable, the table starts empty and the PDF's text is shown below it for
entering the scenes by hand.

### Ideas for Babel

Every project keeps ideas with keywords. `GET /api/ideas?customer=<id or
name>` (optional `&open=1`) returns them as
`{ ideas: [{ id, text, tags, done, created, project, projectId, customer, customerId }] }`,
so a later Babel version can show matching ideas during a client conversation.
The customer is matched by id, name or company (case does not matter); without
`customer` all ideas come back.

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
after at most 2 minutes (a guard against a lost release).

**Live text (private builds).** With `VITE_LIVE_STT_URL` set at build time (a
Quietglass streaming recogniser, `wss://…`), the audio is also streamed to that
server while you speak: the command appears on the glasses as you say it, and on
release it runs at once from that text, with the same command matching as
before. If the live connection does not open within 3 s, drops, or heard
nothing, the recording goes to `/api/stt` as before, so nothing is lost. Public
builds leave the variable empty and behave exactly as before.

### Light & sun

Computed on the phone, offline (NOAA / Meeus solar position): azimuth and
elevation, sunrise/sunset (−0.833°), **golden hour −4° … +6°**, **blue hour
−6° … −4°**, solar noon and the moon phase. 24-hour clock, German compass
letters (N, NO, O, OSO …) in German. Tested against independent astropy values
for Salzburg (47.8° N, 13.04° E) on four dates (±2 min, ±0.5°) and for polar
day and night.

The place comes from the phone's location (asked only when you open *Light*,
in the background with a 10 s limit, so the glasses never wait for it), else
from the shoot's place in the schedule, else from the last known place (rounded
to about 1 km, stored on the phone only). To give the shoot a place, add
coordinates to the schedule your server returns from `/api/dispo`:

```json
{ "date": "Mo 15.09.", "call": "07:30", "lat": 47.80, "lon": 13.04, "schedule": [{ "time": "18:30", "what": "Bridge" }] }
```

The next schedule row by the clock (today) is shown as the next shoot; the
phone's *Light* tab lists the light at every row and today's timeline.

### Offline on set

A take logged while the server cannot be reached is kept on the phone and sent
the next time the server answers. The menu shows how many are waiting. A tick
on the packing list that does not reach the server is taken back on the
glasses, so what you see is what is stored.

*Delete last take* (row of the take actions, Takes module only) removes the newest take of the
shot on screen: a take still waiting in the outbox simply disappears; a sent one
is removed on the server with `POST /api/take/delete {scene, shot, n}` (optional
`?project=<id>`; answers `{ok:true, deleted:{…}}`, or 404 if no such take — it
removes that one take and nothing else). The call is armed like every risky
action: first tap shows `Tap again = delete take`, the second within 4 s runs it.

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
| `DATA_FILE` | `./shoot-day-data.json` | where customers and projects are stored |
| `SHOOT_FILES_DIR` | `shoot-day-files/` next to `DATA_FILE` | uploaded PDFs and pictures (one folder per project, file names from ids only) |
| `SHOOT_MAX_UPLOAD_MB` | `20` | largest upload |
| `SHOOT_LLM_URL` | – | OpenAI-compatible model (`…/v1` or `…/v1/chat/completions`) for *Storyboard from PDF*; without it: manual entry |
| `SHOOT_LLM_MODEL` | – | model name sent to it (optional) |
| `SHOOT_LLM_TOKEN` | – | bearer token for it (optional) |
| `SHOOT_BABEL_URL` | – | babel-llm-proxy (`https://host:port` or `…/v1`); the card before the appointment then shows Babel's memory entries for the customer (`POST /memory/search`, called by the server). Without it nothing about Babel is shown |
| `SHOOT_BABEL_TOKEN` | – | bearer token for the Babel proxy (optional) |
| `WHISPER_URL` | – | OpenAI-compatible `/v1/audio/transcriptions` endpoint; voice is off without it |
| `WHISPER_MODEL` | `whisper-1` | model name sent to it |
| `PRESET_LANG` | `en` | language of the packing-list template and of the *Ohne Zuordnung* / *Unassigned* customer (`de` or `en`) |

It ships with a neutral example customer and project and a generic
packing-list template; rename, add and remove items in the web terminal.

**Data file and update to 0.5.0.** The data file now holds customers
(`{ version: 2, active, customers, projects }`). On the first start with an
older file (projects by name) the server first copies it byte for byte to
`DATA_FILE.bak-v1-<date-time>` and then puts every project under the customer
*Ohne Zuordnung* / *Unassigned*; move them to their customers in the web
terminal. If the backup cannot be written, the server does not start. A data
file it cannot read is moved aside (`.broken-<date-time>`), never overwritten.
Every write goes to a temporary file, is flushed to disk and then renamed.
Back up `DATA_FILE` **and** `SHOOT_FILES_DIR`.

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

| Gesture | Customers | Projects / card | Menu | Inside a module |
|---|---|---|---|---|
| Swipe | choose | choose / page | choose a module | next scene, change shot / speed / selection; in *Light*: time ±30 min |
| Tap | open (*+ New customer*: speak) | open | open | scene done, log, tick, play/pause, reload; in *Light*: back to now |
| Hold | new customer by voice | – | – | speak (packing list, take card); release = done |
| 2× | **leave the app** (the system asks first) | back to customers | back to the projects | back to the menu; while speaking: cancels the recording |

With a server older than 0.5.0 there are no customers: the menu is the top
level and 2× there leaves the app, as before.

**Quietglass Interaction Standard (QIS v1).** Header `SHOOT DAY · <state>`, footer
always in the order Tap → Swipe → Hold → 2× and ending `2× = back` (or `exit`
on the root). 2× only ever goes back. Anything that cancels or resets is armed
first: *Cancel take* and a voice *everything packed / unpacked* show
`Tap again = … · Swipe/2× = cancel`; a second tap within 4 s carries it out,
swipe, hold, 2× or 4 s without input cancel. A running take is never lost by
swiping or leaving the screen. *Help* is the last entry of the customer list
(of the menu on a server without customers). The swipe direction can be
inverted on the phone page (tab *Glasses*); the tabs run Shoot day · Light ·
Glasses · Connection · More.

**Side menu (off since 0.7.2).** The glasses' side menu (QIS v1.2: *Help*, *Delete last
take*, *Send recording*, *Discard recording*) is switched off with `SIDE_MENU = false`:
on the real glasses its clicks never reached the app and a hold opened it instead of
dictating (step log 15.10.2026). The menu code stays. Without it: *Help* is a list row
again, *Delete last take* a (armed) row of the take actions, and 2× while speaking
cancels the recording. A recognised but not yet created customer name is not lost by
2× either: 2× only arms the discard, tap confirms.

**Armed actions.** Everything that cancels, resets or deletes shows
`Tap again = … · Swipe/2× = cancel` first: *Cancel take*, *Take NG*, *Delete last
take*, and the voice commands *everything packed / unpacked*.

**Customer list and demo.** The customer list is the top level (name order,
*+ New customer* first). Without a server address the app starts as a **demo** with
sample data and the line "Demo · set up the connection on the phone"; nothing is
sent or stored. Saving an address on the phone ends the demo (`?demo=1` still forces
it for presentations). Errors are shown without HTTP numbers ("server reports an
error"); the phone tab *Connection* shows the status.

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
tested against the 7 × 46 display limit in both languages; `src/sun/` holds the
solar math (`solar.ts`), the photographer's view of it (`light.ts`, `model.ts`)
and the full-screen picture (`compose.ts`, drawn with the kit in `src/screen/`);
`src/voice/` holds
the speech grammars (`customer-voice.ts` for "Neuer Kunde Anna Beispiel");
`src/api/` validates everything the server sends. The server is
`examples/shoot-day-server.mjs` with `examples/shoot-day-pdf.mjs` (PDF text and
the storyboard proposal) next to it.

## Status

Verified in tests, the Even Hub simulator and on physical G2 hardware,
including the glasses controls and the phone-side setup flow. Speech quality
and location accuracy still depend on the environment and phone permissions.

## Privacy

See [docs/PRIVACY.md](docs/PRIVACY.md). In short: the app talks only to the
server you enter; audio is recorded only while you speak and goes only there.

## License

MIT — see [LICENSE](LICENSE).
