Deutsche Fassung: [SETUP.de.md](SETUP.de.md)

# Setup – step by step

This guide tells you, app by app, **what to enter where** so the app works.
The field names are written exactly as you see them in the app on your phone
(English interface).

## How an app gets onto the glasses

1. Open the **Even app** on your phone.
2. Open **Me → Apps**.
3. Find the app in the **Store** list and install it. Apps that are not in the
   store yet come in through **Private Builds** (enter the app's link or its
   `.ehpk` file there).
4. Open the app. The app's **phone page** appears on the phone (you enter
   everything there), and the display appears on the glasses.

The language follows the phone. You can change it at the top of the phone
page.

## Important for your own servers: addresses must be `https://` or `wss://`

The app is loaded over **HTTPS** on the phone. For that reason the Even app
blocks everything that is only `http://` or `ws://` ("mixed content"). A
server in your home network or on your own computer therefore needs an
encrypted address. The easiest way is **Tailscale**:

1. Install Tailscale on the phone **and** on the server machine, and sign in
   to the same account.
2. On the server machine, publish an address for the app:

   ```bash
   tailscale serve --bg --https=8445 8899
   ```

   This means: "Take the server that runs internally on port 8899 and offer
   it at `https://<your-machine>.<your-tailnet>.ts.net:8445`." The address
   can only be reached inside your Tailscale network.
3. Every app gets its **own** `--https=` number (for example 8445, 8446 …).
   First check with `tailscale serve status` what is already taken.
4. If the server does not run on the machine itself but at another address,
   give that address in full, for example
   `tailscale serve --bg --https=8446 http://127.0.0.1:8765`.
5. The same applies to WebSocket servers (speech/agent servers): in the app,
   the address then starts with `wss://` instead of `https://`.

> **Never run `tailscale serve reset`.** It deletes **all** published
> addresses on the machine, including those used by other services. With
> `tailscale serve status` you see the current state, and with
> `tailscale serve --https=<number> off` you remove just one address.

> **Host everything yourself?** In [`selfhost/`](../selfhost/README.md) you find the server services with systemd units
> and config templates, plus the script `build-private.mjs`, which builds the **private builds** from your Tailscale
> addresses (on the glasses only **exact addresses** are allowed in the network permission, no wildcards like
> `https://*`). Everything runs on your own machines and can only be reached through your Tailscale; you sign in
> through the Tailscale login, so you do not have to type a token.

Wherever the text below says `<your-machine>.<your-tailnet>.ts.net`, insert
the name of your server in the Tailscale network.

## Overview

| App | Setup needed? |
|---|---|
| [FlowList](#flowlist) | no |
| [PostureLens](#posturelens) | no |
| [DecibelGuard](#decibelguard) | no |
| [Cadence](#cadence) | no |
| [ShiftClock](#shiftclock) | no |
| [RainLens](#rainlens) | no (allow location) |
| [OpenGlance](#openglance) | no (allow location) |
| [NextStop](#nextstop) | no (ÖBB live times: optional, separate add-on program) |
| [FieldLog](#fieldlog) | no (speaking notes: optional, own speech server) |
| [Babel Glass](#babel-glass) | **yes**: speech server (and optionally a translator) |
| [Agent Glass](#agent-glass) | **yes**: server of your AI agent |
| [Quiet Hub](#quiet-hub) | **yes**: hub daemon (+ a relay on each machine with agents) |
| [Shoot Day](#shoot-day) | **yes**: own server |
| [Klipper Glance](#klipper-glance) | at home **no** (enter the printer address); on the go: bridge |
| [Sugar Glass](#sugar-glass) | **yes**: your Nightscout (+ the Sugar Glass bridge is recommended) |
| [Star Glass](#star-glass) | **yes**: bridge next to N.I.N.A. |
| [Xaventra HUD](#xaventra-hud) | **yes**: your Xaventra machine (Even G2 service) |
| [Status Glass](#status-glass) | **yes**: a status source |
| [Lumen Glass](#lumen-glass) | **yes**: your LUMEN |
| [PodCaption](#podcaption) | no (file or text); feed bridge optional – *not in the store yet* |
| [Market Glance](#market-glance) | **yes**: local bridge – *not in the store yet* |
| [Endurance HUD](#endurance-hud) | **yes**: local bridge – *not in the store yet* |

---

## No setup needed

### FlowList

**What you need:** nothing.

**Enter on the phone:** only if you want your own checklist.

| Field in the app | What to enter | Example |
|---|---|---|
| One step per line, starting with "- " … | Name of the list with `#`, steps with `-` | `# Einkaufen` + `- Milch` |
| Button **Add checklist** | tap | – |

The example lists "Leaving the house" and "Packing for a trip" are already
there. (`(!)` after a step = important, it is confirmed twice.)

**How to check that it works:** Open the app and tap once on the glasses – the
first step is ticked off.

### PostureLens

**What you need:** nothing.

**Enter on the phone:** nothing. Sit up straight and **tap the temple once** –
that saves your upright posture.

**How to check that it works:** On the phone page, a saved value appears under
"Your upright posture".

### DecibelGuard

**What you need:** nothing. The app asks once for the microphone of the
glasses.

**Enter on the phone:** nothing. Optionally, under "Measure more precisely
(optional)", set the "Calibration offset" value if you have a real sound level
meter.

**How to check that it works:** Tap once on the glasses – it shows
**● MIC** and a level appears. Tapping again stops it.

### Cadence

**What you need:** nothing.

**Enter on the phone:** optional.

| Field in the app | What to enter | Example |
|---|---|---|
| Speed | Beats per minute (slider) | 90 |
| Time signature | Beats per bar | 4/4 |
| Add an item | What you are practising, then **Add** | Scales |

**How to check that it works:** Tap on the glasses – the beat runs.

### ShiftClock

**What you need:** nothing.

**Enter on the phone:** optionally one more project.

| Field in the app | What to enter | Example |
|---|---|---|
| Add a project | Client, job or task, then **Add** | Client Huber |

The project "Work" already exists.

**How to check that it works:** Tap on the glasses – the time runs.
Tap again to stop.

### RainLens

**What you need:** Internet on the phone. No account, no key.

**Enter on the phone:** Allow location in the Even app – or type a place.

| Field in the app | What to enter | Example |
|---|---|---|
| Use my phone's location | Tick the box (default) | – |
| Or enter a place | Name of the place, then **Find place** and tap the result | Hallein |
| Latitude / Longitude (under **Advanced**) | only if the search does not know your place | 47.68 / 13.10 |

**How to check that it works:** On the phone page, "Now: …" shows your place,
and the glasses show the weather.

### OpenGlance

**What you need:** Internet and GPS (allow location). No account.

**Enter on the phone:**

| Field in the app | What to enter | Example |
|---|---|---|
| Search address or place | Destination, then **Search** and, on a result, **Go here** | Mirabellplatz Salzburg |
| How do you travel? | On foot / Bike / Car | On foot |

Leave the fields "Routing server (Valhalla)" and "Place search server
(Photon)" under **Advanced** empty – then the free public servers are used.

**How to check that it works:** Tap on the glasses – the arrow with the
distance to the next turn appears. (There is no GPS indoors.)

### NextStop

**What you need:** Internet and location permission. No account.

**Enter on the phone:** nothing. "Where do the departures come from?" is set
to **Anywhere – timetable** and works right away.

**Optional: ÖBB live times (delays in Austria)**

| Field in the app | What to enter | Example |
|---|---|---|
| Where do the departures come from? | **ÖBB – live times in Austria** | – |
| Address of the ÖBB add-on (under **Advanced**) | https address of the add-on program **with** `/oebb` at the end | `https://<your-machine>.<your-tailnet>.ts.net:8450/oebb` |

**Start the server** (in the folder `apps/nextstop`):

```bash
node examples/oebb-cors-proxy.mjs          # runs on 127.0.0.1:8079
tailscale serve --bg --https=8450 8079     # makes it reachable over https
```

**How to check that it works:** On the glasses, `●` (live) appears next to the
departures. If it says "ÖBB not reachable", the address is wrong or the add-on
program is not running.

**Optional: your own map server.** If the walking map shows only the route
without streets, the public Overpass servers are overloaded. Under
**Advanced** → **Own map server (Overpass)**, enter the https address of your
own Overpass server (the app adds `/api/interpreter`). It is asked first; if
it is not reachable, the app uses the public ones. Leave empty = public
servers.

### FieldLog

**What you need:** nothing. You choose notes by tapping/swiping, and the
phone takes the photos.

**Enter on the phone:** optionally a name for the walk-through.

| Field in the app | What to enter | Example |
|---|---|---|
| Name (optional) | Name of the walk-through, then **Start inspection** | Handover flat 3 |
| Area (optional) | Room or place | Kitchen |

**Optional: speaking notes.** For this you need a Whisper speech server with an
OpenAI-compatible `/v1/audio/transcriptions` endpoint (e.g. faster-whisper-server
or speaches), reachable over https. Then, under **Advanced: dictate notes (optional)**:

| Field in the app | What to enter | Example |
|---|---|---|
| Whisper server (https) | https address of the speech server (the app adds `/v1/audio/transcriptions`) | `https://<your-machine>.<your-tailnet>.ts.net:8447` |
| Token (optional) | only if the server has one | – |
| Spoken language | Language you speak | German |

Then **Save**.

**How to check that it works:** Under the field it says "Active now:
dictation through your server." (instead of "quick notes").

---

## With your own server

### Babel Glass

Captions and translation on the glasses. Without a server, the app shows fixed
demo sentences and `MOCK` – that is only for trying it out.

**What you need:**

- a **speech server** (Whisper) – required for real captions,
- optionally a **translator** (LibreTranslate-compatible, or an
  OpenAI-compatible language model such as vLLM/Ollama).

**Start the server – speech server** (in the folder `apps/babel-glass`):

```bash
pip install faster-whisper websockets
MODEL=large-v3 DEVICE=cuda COMPUTE=float16 python examples/whisper-server.py
# CPU only (slow): MODEL=small COMPUTE=int8 python examples/whisper-server.py
```

It runs on port 9000 (`PORT=…` changes that; `TOKEN=secret` protects it).
Then make it reachable over https/wss:

```bash
tailscale serve --bg --https=8447 http://127.0.0.1:9000
```

**Start the server – translator** (only if you do not have an LLM server):

```bash
pip install transformers torch sentencepiece
python examples/translate-server.py        # port 5000, path /translate
tailscale serve --bg --https=8448 5000
```

**Enter on the phone:**

| Field in the app | What to enter | Example |
|---|---|---|
| Spoken language | The language being spoken. For Belarusian/Russian, **choose it explicitly**, not "Detect automatically" | Russian |
| Server (WebSocket) (under **Advanced: Server**) | `wss://` address of the speech server | `wss://<your-machine>.<your-tailnet>.ts.net:8447` |
| Token (optional) | only if you set `TOKEN=` | – |
| Translate into | Target language | German |
| Translation server | *LibreTranslate-compatible* **or** *OpenAI-compatible LLM* | – |
| Endpoint (for LibreTranslate) | full address including `/translate` | `https://<your-machine>.<your-tailnet>.ts.net:8448/translate` |
| API key (optional) | only if the translator requires one | – |
| Server base URL (for LLM) | address up to `/v1` | `https://<your-machine>.<your-tailnet>.ts.net:8451/v1` |
| Model (for LLM) | Name of the model on the server | `qwen` |
| Bearer token (optional) (for LLM) | only if needed | – |
| Mode | Conversation / Lecture / Travel / Caption only | Conversation |

Then **Save**.

The translation server must allow requests from the app ("CORS"). The
supplied `translate-server.py` does this itself; with Ollama you start with
`OLLAMA_ORIGINS="*"`, and in LM Studio you switch CORS on.

**How to check that it works:** On the phone page, the yellow "Demo mode" box
disappears. Tap once on the glasses: **● MIC** appears, and captions arrive
while you speak – not `MOCK`.

### Agent Glass

Shows what your AI agent is doing right now and lets you give approvals.

**What you need:** one of the three agent servers – **Claude/Codex** (through
Even Terminal), **Hermes** (hermes-evenhub-bridge) or **OpenClaw**.

**Start the server:**

| Service | Command / requirement |
|---|---|
| Claude / Codex · Even Terminal | `even-terminal start --tailscale --allow-cors` (the device stays inside your Tailscale network) |
| Hermes · EvenHub Bridge | The bridge already runs in your Hermes setup; make it reachable over `wss://` (`tailscale serve`, see above). The token is called `EVENHUB_BRIDGE_TOKEN`. |
| OpenClaw · Gateway | in the gateway, set `gateway.http.endpoints.chatCompletions.enabled=true`; the address is usually port 18789 |

**Enter on the phone:**

| Field in the app | What to enter | Example |
|---|---|---|
| Provider | *Claude / Codex · Even Terminal*, *Hermes · EvenHub Bridge* or *OpenClaw · Gateway* | Hermes · EvenHub Bridge |
| Server address | Even Terminal: the **complete pairing URL** that Even Terminal prints at start (address and token are separated automatically). Hermes: `wss://` address. OpenClaw: `https://` address | `wss://<your-machine>.<your-tailnet>.ts.net:8446` |
| Bearer / bridge token | for Hermes the `EVENHUB_BRIDGE_TOKEN`, for OpenClaw the gateway token; for Even Terminal leave empty if you used the pairing URL | – |

Then **Save and connect**. Optionally, under "Spoken output": **Enable spoken
output**, speech language, voice, speed.

**How to check that it works:** Under "Live status" it says
"… sessions · active: …" instead of "No sessions loaded" or "Error: …".
The active session appears on the glasses.

### Quiet Hub

One hub for all your agents (Hermes, OpenClaw, Codex, Claude Code – also on
other machines), your home (Home Assistant) and your printer (Moonraker).
Approvals ("may Claude run this?") and voice questions go straight through the
glasses.

**What you need:** a small always-on machine (for example a Raspberry Pi) for
the daemon. On every further machine with agents, a **relay** runs.

**Start the daemon** (in the folder `apps/quiet-hub`, details in the README
there):

```bash
npm run pi:start          # creates .env-hub with a random token, starts everything, shows a QR code
```

Make it reachable over https (own number, never `reset`):

```bash
tailscale serve --bg --https=8453 8787
```

**Enter on the phone:** scan the QR code, or

| Field in the app | What to enter | Example |
|---|---|---|
| Server address | the https address | `https://<your-machine>.<your-tailnet>.ts.net:8453` |
| Access token | `HUB_TOKEN` from `.env-hub` | – |

**Connect another machine/agent:** create `relay.json` (template
`apps/quiet-hub/examples/relay.example.json`) and start:

```bash
HUB_TOKEN=<token> node quiet-hub-relay.mjs --hub https://<your-machine>.<your-tailnet>.ts.net:8453 --config relay.json
```

The agent appears on the glasses under "Agent" with a green dot. Mode `ask`
asks on the glasses for every action, `auto` never asks.

**Optional in `.env-hub`:**

| Variable | Meaning |
|---|---|
| `WHISPER_URL` | Speech-to-text (OpenAI-compatible, `/v1/audio/transcriptions`) |
| `HA_URL`, `HA_TOKEN`, `HA_DEVICES` | Home Assistant (token: profile → security → long-lived access token); `HA_DEVICES` is the allow list |
| `MOONRAKER_URL` | Printer, for example `http://<drucker>:7125` (`node scripts/find-moonraker.mjs` finds it) |

Without HA/Moonraker, "Home" and "Printer" show clearly marked DEMO data.

**How to check that it works:** Under "Agent", every agent is listed with a
dot (on = online). Holding on the glasses records a voice question.

### Shoot Day

Take log, teleprompter, day schedule and packing list for the shooting day.

**What you need:** the Shoot Day server (Node.js).

**Start the server** (in the folder `apps/shoot-day`):

```bash
PORT=8899 HOST=127.0.0.1 PRESET_LANG=de node examples/shoot-day-server.mjs
```

| Variable | Meaning |
|---|---|
| `PORT` | Port (default 8899) |
| `HOST` | `127.0.0.1` = this machine only. Anything else **requires** `TOKEN` |
| `TOKEN` | Password for the app and the web terminal (optional with `127.0.0.1`) |
| `DATA_FILE` | where the projects are stored |
| `WHISPER_URL` | Speech recognition (OpenAI-compatible, `…/v1/audio/transcriptions`); without it there are no voice commands |
| `PRESET_LANG` | `de` = German packing-list template |

Then make it reachable over https:

```bash
tailscale serve --bg --https=8445 8899
```

**Enter on the phone:**

| Field in the app | What to enter | Example |
|---|---|---|
| Server address | the https address | `https://<your-machine>.<your-tailnet>.ts.net:8445` |
| Token (optional) | only if you set `TOKEN=` | – |

Then **Save and connect**. You manage the shot list, spoken text, day
schedule and packing list in the **web terminal**: open the same address in a
browser.

**How to check that it works:** Under "Connection" it says "Connected –
project: …". The address in the phone's browser shows the web terminal.

### Klipper Glance

Print status of your Klipper/Moonraker printer.

**At home (same Wi-Fi as the printer): no bridge.** On the phone, under
"Printer", simply enter the printer's address (for example `192.168.1.50`,
port 7125 is added) or tap **Find printer**. The app then talks to Moonraker
directly – including the 3D view.

**On the go** you need the bridge: a machine in the printer's network that
runs it and makes it reachable through Tailscale. Detailed instructions:
[`apps/klipper-glance/docs/SETUP.md`](../apps/klipper-glance/docs/SETUP.md).

**Start the server** (in the folder `apps/klipper-glance`):

```bash
node examples/klipper-bridge.mjs                                   # finds the printer by itself
KL_MOONRAKER=http://<printer-address>:7125 node examples/klipper-bridge.mjs
```

| Variable | Meaning |
|---|---|
| `PORT` | Port (default 8898) |
| `HOST` | Bind address (default `127.0.0.1`) |
| `TOKEN` | Password for the bridge (needed if you want to allow control) |
| `KL_MOONRAKER` | fixed Moonraker address; without it the bridge searches |
| `KL_ALLOW_CONTROL=1` | allows pause/resume/cancel – **only together with `TOKEN`** |

To practise without a printer: `node examples/mock-moonraker.mjs` starts a
fake printer.

Make it reachable over https:

```bash
tailscale serve --bg --https=8452 8898
```

**Enter on the phone:**

| Field in the app | What to enter | Example |
|---|---|---|
| Printer IP or bridge address | the https address | `https://<your-machine>.<your-tailnet>.ts.net:8452` |
| API key / token (optional) | your `TOKEN`, if set | – |

Then **Save and connect**.

**How to check that it works:** Under "Printer" you see the state, percent
and file name; below that, whether control is allowed. "Bridge reachable,
printer offline" means: the bridge is running, the printer is switched off.

### Star Glass

Your astrophotography night with N.I.N.A. on the glasses: exposure, image
n/m, guiding, HFR, cooling, meridian flip and a preview of the newest image.

**What you need:** N.I.N.A. with the **Advanced API** plugin (default port
1888) and Node.js on the same machine.

**Start the server** (in the folder `apps/star-glass`):

```bash
node examples/star-bridge.mjs                                      # queries http://127.0.0.1:1888
STAR_TAILSCALE_USERS=your-login@example.com node examples/star-bridge.mjs
```

| Variable | Meaning |
|---|---|
| `PORT` / `HOST` | Port (default 8893) / bind address (default `127.0.0.1`) |
| `STAR_TAILSCALE_USERS` | Tailscale logins that are allowed without a token |
| `TOKEN` | Password as an alternative to Tailscale |
| `STAR_ALLOW_CONTROL=1` | allows pausing/resuming the sequence – **only with a login or `TOKEN`** |

To practise without a telescope: `node examples/mock-nina.mjs` and
`STAR_NINA=http://127.0.0.1:1889`. Autostart on Windows:
[`selfhost/services/star-bridge`](../selfhost/services/star-bridge).

Make it reachable over https (read `tailscale serve status` first):

```bash
tailscale serve --bg --https=8460 http://127.0.0.1:8893
```

**Enter on the phone:** Bridge address `https://<your-machine>.<your-tailnet>.ts.net:8460`
(a private build with `VITE_STAR_URL` already includes it), then **Save and connect**.

**How to check that it works:** Under "Imaging" you see the state, target and
image n/m. "Bridge reachable, N.I.N.A. is not" means: N.I.N.A. or the plugin
is not running.

### Sugar Glass

Your glucose values from your own **Nightscout** on the glasses: value with
trend arrow, curve of the last 3 hours, alerts and pump status.

> For information only, not for therapy decisions – the pump and the sensor
> are what counts. Not a medical device, no alarm function.

**What you need:** your own Nightscout (for example via Docker) that your
uploader fills (CareLink bridge for MiniMed 780G, xDrip+, Dexcom Share …).
Recommended: `AUTH_DEFAULT_ROLES=denied`, so Nightscout does not read openly.

**Way 1 – recommended: with the Sugar Glass bridge** (then no token is stored in the app)

1. In Nightscout, under *Admin Tools*, create a subject with the role
   **`readable`** and copy its token.
2. Start the bridge next to Nightscout (in the folder `apps/sugar-glass`):

   ```bash
   NS_URL=http://127.0.0.1:1337 NS_TOKEN=<readable-token>    SUGAR_TAILSCALE_USERS=your-login@example.com node examples/sugar-bridge.mjs
   ```

   | Variable | Meaning |
   |---|---|
   | `NS_URL` | your Nightscout (default `http://127.0.0.1:1337`) |
   | `NS_TOKEN` | token with the role `readable` (never logged) |
   | `SUGAR_TAILSCALE_USERS` | Tailscale logins that may read |
   | `TOKEN` | Password as an alternative to Tailscale |

   Without `SUGAR_TAILSCALE_USERS` and without `TOKEN`, the bridge rejects
   everything. Service file for Linux: [`selfhost/services/sugar-bridge`](../selfhost/services/sugar-bridge).
3. Make it reachable over https (read `tailscale serve status` first):

   ```bash
   tailscale serve --bg --https=8462 http://127.0.0.1:8466
   ```

4. **Enter on the phone:** Address `https://<your-machine>.<your-tailnet>.ts.net:8462`,
   leave the token field empty, **Save**.

**Way 2 – without the bridge:** enter the https address of your Nightscout and
the `readable` token directly on the phone. The token is then stored in the
app and is sent as `?token=` (Nightscout's own way).

**How to check that it works:** On the glasses you see your current value with
trend arrow and "n min ago". Without a server, the app shows a demo (marked
`DEMO`). You set the unit (mg/dL or mmol/L), target range and alert limits on
the phone page.

More details (pages, gestures, alerts): [`apps/sugar-glass`](../apps/sugar-glass).

### Xaventra HUD

Shows on the glasses what your own Xaventra agent is working on, and answers
its follow-up questions: **tap = yes**, **double tap = no**, **swipe = next
question**. Actions that act on the outside world (print, switch, send) need a
**second tap**. **Hold = speak**: the recording goes to your Xaventra machine,
which understands it with its own speech recognition.

**What you need:** a Xaventra installation with the Even G2 service switched
on (`channels.evenG2.enabled`, token `NOVA_EVEN_G2_TOKEN`, default port
`18790`, listens on `127.0.0.1` only). For speech, your Xaventra must have the
voice endpoint `POST /hud/voice`. The setup on the Xaventra side is described
in its `docs/EVEN_G2.md`.

Make it reachable over https in the tailnet:

```bash
tailscale serve --bg --https=8790 http://127.0.0.1:18790
```

(Use a port that is free on your machine. **Never** `tailscale serve reset` –
it deletes all your other published addresses.)

**Enter on the phone:**

| Field in the app | What to enter | Example |
|---|---|---|
| Xaventra endpoint address | the https address | `https://<your-machine>.<your-tailnet>.ts.net:8790` |
| Token (NOVA_EVEN_G2_TOKEN) | the token of your Xaventra service | – |

Then **Save and connect**.

**How to check that it works:** Under "Connection" it says "Connected.", and
on the glasses the top line reads "Xaventra · time" (with "(offline)" if
there are problems). "Token rejected (401)" means: the token does not match
`NOVA_EVEN_G2_TOKEN`.

### Status Glass

Shows whether your NAS, server or Home Assistant are fine.

**What you need:** a **source** – an address that returns a small JSON
(format: `docs/PROTOCOL.md` in the app). Two ready-made examples are included.

**Start the server** (in the folder `apps/status-glass`):

```bash
node examples/reference-server.mjs                  # example, http://127.0.0.1:8099/status
```

For Home Assistant:

```bash
HA_URL=http://homeassistant.local:8123 HA_TOKEN=<long-lived-token> TOKEN=<your-secret-token> node examples/home-assistant-adapter.mjs
```

(Runs on port 8100. Without `TOKEN` the adapter is read-only. At the top of
the file you set what may be shown and what may be switched.)

Make it reachable over https, for example for the example server:

```bash
tailscale serve --bg --https=8449 8099
```

**Enter on the phone** (section "Add a source"):

| Field in the app | What to enter | Example |
|---|---|---|
| Name | your choice | NAS |
| URL | https address **including `/status`** | `https://<your-machine>.<your-tailnet>.ts.net:8449/status` |
| Bearer token (optional) (under **Advanced**) | your `TOKEN`, if set | – |

Then **Add source**.

**How to check that it works:** Under "Sources" the source appears; on the
glasses it says "… of … ok" or shows the problem list. A source that does not
answer counts as a problem (never as "ok").

### Lumen Glass

Shows the moth from your self-hosted LUMEN.

**What you need:** a running LUMEN (default `127.0.0.1:8077`) and access
permission ("CORS") in LUMEN – three lines, see
`apps/lumen-glass/examples/PATCH.md`. Alternatively, the supplied proxy:

```bash
node examples/lumen-cors-proxy.mjs          # port 8078, forwards to LUMEN
```

Make it reachable over https:

```bash
tailscale serve --bg --https=8454 8077       # or 8078 if you use the proxy
```

**Enter on the phone:**

| Field in the app | What to enter | Example |
|---|---|---|
| Address | https address of your LUMEN (or of the proxy) | `https://<your-machine>.<your-tailnet>.ts.net:8454` |
| Sign-in (name + password) | only needed if your LUMEN asks you to sign in; the password is sent once, the app keeps only the session key | – |

Then **Save**.

**How to check that it works:** The phone page shows your moth instead of a
connection error. If the glasses show "LUMEN unreachable", CORS is missing.

---

## Not in the Even Hub store yet

These three apps are finished in the repository but not in the store yet.
Install them through **Private Builds**.

> **Important:** In PodCaption (feed bridge), Market Glance and Endurance HUD,
> the app is hard-wired to talk only to a bridge on `127.0.0.1` /
> `localhost`. A bridge on a *different* machine is therefore not reachable
> for the app – at the moment that only works in the simulator or on the
> machine itself. For a real phone you would have to change the allowed
> address in the app's `app.json` and rebuild the app.

### PodCaption

**What you need:** nothing – a caption file (VTT, SRT, JSON or text) is
enough.

**Enter on the phone:**

| Field in the app | What to enter | Example |
|---|---|---|
| Pick a file on your phone (VTT, SRT, JSON or text) | Choose a file | `folge12.vtt` |
| Episode name (optional) | your choice | Episode 12 |
| Or paste text | Copy the transcript and paste it, then **Use this text** | – |

**Optional (Advanced):** captions from an RSS feed.

| Field in the app | What to enter | Example |
|---|---|---|
| Bridge address | Address of the bridge (default already filled in), then **Load feed** | `http://127.0.0.1:8789` |

**Start the server:**

```bash
PODCAST_FEED_URL=https://example.org/podcast.xml node examples/podcast-bridge.mjs
```

**How to check that it works:** "Captions loaded" appears instead of "Sample –
no file opened yet". Tap on the glasses = play.

### Market Glance

Read-only display of your Polymarket/Kalshi positions (no orders). Not
financial advice.

**What you need:** the bridge. Without settings it runs in demo mode.

**Start the server:**

```bash
POLYMARKET_WALLET=0x… node examples/market-bridge.mjs
# optional Kalshi: KALSHI_KEY_ID=… KALSHI_PRIVATE_KEY_PATH=/path/to/key.pem
```

Credentials stay in the bridge and never reach the glasses. Note on the
address: see the box above.

**Enter on the phone:**

| Field in the app | What to enter | Example |
|---|---|---|
| Local market bridge | Address of the bridge (default already filled in), then **Save** | `http://127.0.0.1:8793/positions` |

**How to check that it works:** `LIVE` appears instead of `DEMO`; the
positions appear in the list.

### Endurance HUD

Live values (speed/pace, power, heart rate, cadence) from Garmin, a bike
computer or a JSON source.

**What you need:** the bridge and something that sends values to it.

**Start the server:**

```bash
node examples/telemetry-bridge.mjs          # port 8792; ENDURANCE_TOKEN=… protects the input
```

Send test values:

```bash
curl -X POST http://127.0.0.1:8792/live -H "Content-Type: application/json" \
  -d '{"sport":"bike","speedKph":32.1,"powerWatts":245,"heartRate":151,"cadence":92,"distanceKm":18.4,"elapsedSeconds":2200,"source":"garmin"}'
```

**Enter on the phone:**

| Field in the app | What to enter | Example |
|---|---|---|
| Sport | Automatic (bridge) / Bike / Run | Automatic (bridge) |
| Telemetry bridge | Address of the bridge (default already filled in), then **Save** | `http://127.0.0.1:8792/live` |

**How to check that it works:** `LIVE WORKOUT` appears instead of `DEMO`. If
no values arrive for more than 10 seconds, the glasses show `STALE`.
