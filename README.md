# Quietglass — applications for Even Realities G2

Eighteen apps for the [Even Realities G2](https://www.evenrealities.com) smart
glasses, built on the official Even Hub SDK. Every app speaks German and
English and follows the phone's language; you can switch it on the phone.

> **Kurz auf Deutsch:** 18 kostenlose Apps für die Even Realities G2, alle auf
> Deutsch und Englisch. Zehn laufen sofort ohne Einrichtung, acht verbinden sich
> mit einem eigenen Server. Keine Konten, keine API-Schlüssel, kein Abo.

They come in two groups:

- **Ready to use** — install and go. Nothing to set up, no account, no key.
  Where an app needs data from the internet (weather, timetables, routing), it
  uses a free public service and credits it.
- **Self-hosted** — for people who run their own server. These apps connect to
  something you host (speech recognition, Home Assistant, a coding agent), and
  each ships a reference server you can copy.

> **Nothing leaves your hands unless you choose it.** No mandatory cloud, no
> API keys, no subscription. Apps that could build a history of you
> deliberately do not.

We only build what the G2 does not already do. Teleprompter, calendar,
assistant and map apps were [archived](archive/) because the glasses ship with
Teleprompt, Dashboard, Even AI and Navigate.

Every app lives in its own directory, builds on its own, and is releasable on
its own. **There is no shared runtime library** — conventions are shared by
copying, so no app can break another.

See the native-resolution simulator captures in the [screenshot gallery](docs/GALLERY.md).

Einrichtung (Deutsch, Schritt für Schritt, pro App): [docs/SETUP.md](docs/SETUP.md)

## Ready to use — no setup

| App | What it does | Tests |
|---|---|---|
| [**FlowList**](apps/flowlist) | Hands-free checklists with branching and critical steps that ask twice. Ships with example lists. | 141 |
| [**PostureLens**](apps/posture-lens) | Private posture reminder: save your upright position with one tap; it warns only after your head stays forward too long. No camera, no history. | 87 |
| [**DecibelGuard**](apps/decibel-guard) | Noise dose over time. Computes a level and discards the audio; stores no history. | 109 |
| [**Cadence**](apps/cadence) | Visual metronome and practice log. The G2 has no speaker, so the beat is visible. | 102 |
| [**ShiftClock**](apps/shift-clock) | One-tap time tracking onto projects, split correctly at midnight, CSV export. | 135 |
| [**FieldLog**](apps/field-log) | Walk an inspection hands-free: quick notes, photos from the phone, report export. Dictation is an optional extra (own speech server). | 121 |
| [**RainLens**](apps/rain-lens) | Weather now, by the hour and for 3 days. Uses your location or a place you type. Data: [Open-Meteo](https://open-meteo.com). | 121 |
| [**NextStop**](apps/nextstop) | Departures at the stop you are standing at, and the next stop while riding. Works worldwide via [Transitous](https://transitous.org); live Austrian delays (ÖBB) are an optional extra. | 133 |
| [**OpenGlance**](apps/openglance-nav) | Turn-by-turn navigation with a route overview. Search a place by name; walking, cycling or driving. Routing: [FOSSGIS Valhalla](https://valhalla1.openstreetmap.de), search: [Photon](https://photon.komoot.io), map data © OpenStreetMap contributors. | 216 |
| [**PodCaption**](apps/podcaption) | Podcast captions from a subtitle file or pasted text. Reading a podcast's RSS transcript is an optional extra. | 90 |

## Self-hosted — for your own server

| App | What it does | You run | Tests |
|---|---|---|---|
| [**Babel Glass**](apps/babel-glass) | Live captions and translation — including **Belarusian**, which the G2's built-in Translate does not offer, and Russian into German. | [`whisper-server.py`](apps/babel-glass/examples/whisper-server.py) plus an LLM (vLLM, Ollama) or [`translate-server.py`](apps/babel-glass/examples/translate-server.py) (NLLB) | 181 |
| [**Status Glass + Home Assistant**](apps/status-glass#home-assistant) | Home Assistant dashboard and allow-listed controls, plus homelab monitoring. The HA token stays in the adapter. | [`home-assistant-adapter.mjs`](apps/status-glass/examples/home-assistant-adapter.mjs) or [`reference-server.mjs`](apps/status-glass/examples/reference-server.mjs) | 129 |
| [**Agent Glass**](apps/agent-glass) | Use Claude Code, Codex, Hermes or OpenClaw from the G2, with headphone speech and swipe permission decisions. **Proof of concept.** | Even Terminal, Hermes bridge or OpenClaw gateway | 120 |
| [**Lumen Glass**](apps/lumen-glass) | Your [LUMEN](apps/lumen-glass) moth, the quest, and the minutes to golden hour. | A LUMEN server | 73 |
| [**Endurance HUD**](apps/endurance-hud) | Live running and cycling metrics from Garmin Connect IQ, a bike computer or any JSON source. | [`telemetry-bridge.mjs`](apps/endurance-hud/examples/telemetry-bridge.mjs) | 51 |
| [**Market Glance**](apps/market-glance) | Read-only Polymarket and Kalshi positions with live prices and open P/L; no trading. | [`market-bridge.mjs`](apps/market-glance/examples/market-bridge.mjs) | 72 |
| [**Shoot Day**](apps/shoot-day) | A film shoot on your glasses: take log by voice, teleprompter for the scene, today's schedule with what's on now and next, and the packing list. | [`shoot-day-server.mjs`](apps/shoot-day/examples/shoot-day-server.mjs) with a web terminal; optional [MCP server](apps/shoot-day/examples/dreh_mcp.py) for agents | 108 |
| [**Klipper Glance**](apps/klipper-glance) | Your 3D printer at a glance: progress, layer, time left and temperatures; pause, resume or cancel with a confirming second tap. | [`klipper-bridge.mjs`](apps/klipper-glance/examples/klipper-bridge.mjs) for Moonraker/Klipper | 57 |

```
2046 tests · 18 builds · every app confirmed rendering in the Even Hub simulator
```

**Nothing here has been verified on physical G2 hardware yet.** Each README
says exactly what that means for that app; where behaviour is known only from
community reports, it is labelled as such.

### Pixel-first glance UI

Apps use real monochrome G2 image containers where a symbol makes the screen
faster to understand: PostureLens, DecibelGuard, Cadence, ShiftClock,
OpenGlance (turn arrow, distance bar and a route overview with real streets),
FlowList (step progress), Lumen Glass, RainLens (12-hour rain and temperature
chart) and Endurance HUD.
Text-critical apps — Babel Glass, PodCaption, FlowList, FieldLog, NextStop,
Agent Glass, Status Glass, Market Glance, Shoot Day and Klipper Glance — keep
the full width for words,
rows or safety-critical values.

The simulator draws Latin text with umlauts, Cyrillic (incl. Belarusian `ў`
and `і`), and `● → … · ○ €`. It does **not** draw `▸`.

## Start here

**[docs/SDK-CAPABILITIES.md](docs/SDK-CAPABILITIES.md)** — what the Even Hub SDK
actually provides, read from the shipped type definitions of
`@evenrealities/even_hub_sdk@0.0.16` rather than from prose. It lists what
exists, the limits its own validators enforce, what does not exist at all, and
the pitfalls we hit.

It is useful to anyone building for the G2. The most expensive one:

> **A tap arrives with no `eventType` field.** proto3 omits fields holding
> their default value, and `CLICK_EVENT` is `0`. Decode a missing event type as
> "unknown" and your app receives events while silently ignoring every tap.

## Shared conventions

Applied by every app, carried as its own copy:

- **One screen, updated in place.** Page rebuilds are expensive on real
  hardware; text updates are cheap. No multi-step dialogs.
- **Identical gesture vocabulary** (`src/input/gestures.ts`): tap, double tap,
  swipe, long press — with the R1 ring reported as a distinct source and a
  user-toggleable swipe inversion.
- **Pure logic, thin SDK adapter.** Everything testable imports no SDK types.
  That is where all 2046 tests live.
- **Redraw suppression.** The display is written only when the view changed.
- **Privacy-first defaults.** No permission is declared unless used. Apps that
  open the microphone show an indicator that cannot be hidden. Apps that could
  build a history of you deliberately do not.
- **Demo data is labelled.** Where an app shows sample data, the glasses say
  `DEMO` (or `MOCK`) so it is never mistaken for real.
- **Strict TypeScript**: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noUnusedLocals`.
- **No credentials in source.** Endpoints and tokens are entered at runtime,
  sent as headers rather than in URLs, never logged, never shown in full.

## Working on an app

```bash
cd apps/<name>
npm install
npm run dev        # phone UI + app for the simulator
npm run build      # typecheck + production bundle
npm test           # unit tests
npm run sim        # Even Hub simulator pointed at the dev server
npm run pack       # Even Hub bundle
```

Run **one simulator at a time** — several at once can make page creation fail
as `invalid` and render blank. See the SDK notes.

Starting a new app:

```bash
node tools/scaffold.mjs <dir> "<Display Name>" <devPort> "<description>"
```

## Status

Even Hub opened as a public app catalogue in April 2026. These apps are built
against SDK `0.0.16`, every `app.json` passes `evenhub pack`, and each app has
been confirmed rendering in the official simulator.

## License

MIT, per app.
