# Quietglass — applications for Even Realities G2

Twenty apps for the [Even Realities G2](https://www.evenrealities.com) smart
glasses, built on the official Even Hub SDK.

Two things run through all of them:

> **They run on your own hardware.** No mandatory cloud, no API keys, no
> subscription. Where an app needs speech recognition or routing, you point it
> at your own server — and each of those ships with a reference server you can
> copy.
>
> **They use what is going unused.** Of roughly 150 community G2 projects, two
> touch the IMU. None measure noise dose. None track time, run a checklist, or
> speak a plain monitoring protocol.

Every app lives in its own directory, builds on its own, and is releasable on
its own. **There is no shared runtime library** — conventions are shared by
copying, so no app can break another.

## The apps

| App | What it does | Tests |
|---|---|---|
| [**PromptFlow**](apps/promptflow) | Teleprompter. Pacing counted in words read, not lines scrolled, so speed stays honest however the text wraps. | 90 |
| [**FlowList**](apps/flowlist) | Hands-free checklists with branching, critical steps that ask twice, and a shareable pack format. | 79 |
| [**PostureLens**](apps/posture-lens) | Neck angle over time from the IMU, measured against *your* upright rather than vertical. | 48 |
| [**DecibelGuard**](apps/decibel-guard) | Noise dose over time. Computes a level and discards the audio; stores no history at all. | 58 |
| [**FieldLog**](apps/field-log) | Walk an inspection hands-free: speak the defect, attach a photo, export the report. | 44 |
| [**Cadence**](apps/cadence) | Visual metronome and practice log. The G2 has no speaker, so the beat is visible. | 62 |
| [**ShiftClock**](apps/shift-clock) | Hands-free time tracking onto projects, CSV export with decimal hours. | 40 |
| [**Babel Glass**](apps/babel-glass) | Live captions and translation against **your own** Whisper. | 64 |
| [**OpenGlance**](apps/openglance-nav) | Turn-by-turn on OpenStreetMap data via Valhalla. No Mapbox, no key. | 68 |
| [**Status Glass**](apps/status-glass) | Homelab monitoring over a protocol small enough to emit from a shell script — now with actions and a Home Assistant adapter. | 87 |
| [**Lumen Glass**](apps/lumen-glass) | Your [LUMEN](apps/lumen-glass) moth, the quest, and the minutes to golden hour. Photo from the phone, straight back to LUMEN. | 49 |
| [**NextStop**](apps/nextstop) | Departures at the stop you are standing at, and the next stop while riding. Two keyless backends: ÖBB for live Austrian delays, Transitous/MOTIS for everywhere else. | 70 |
| [**Agent Glass**](apps/agent-glass) | Watch a coding agent from the glasses and answer its permission prompts with a swipe. Talks to Even Realities' own Even Terminal. **Proof of concept** — see its README. | 39 |
| [**RainLens**](apps/rain-lens) | Full Open-Meteo weather: current conditions, wind, rain, hourly outlook, and 3-day forecast. | 3 |
| [**Dayline**](apps/dayline) | Calendar and reminders with direct `.ics` file import; the local bridge is optional. | 3 |
| [**PodCaption**](apps/podcaption) | Podcast captions from a local VTT/SRT/JSON/text file or Podcasting 2.0 RSS transcripts. | 3 |
| [**Companion**](apps/companion) | Push-to-talk personal assistant with a user-configurable local endpoint and explicit microphone control. | 3 |
| [**Map Glass**](apps/map-glass) | Visual routing from the phone's live position to saved destination coordinates through OSRM. | 3 |
| [**Endurance HUD**](apps/endurance-hud) | Live running and cycling metrics from Garmin Connect IQ, a bike computer, Cloudflare, or any JSON telemetry source. | 3 |
| [**Market Glance**](apps/market-glance) | Read-only Polymarket and Kalshi positions; account secrets remain in the local bridge and no trading actions exist. | 3 |

### Pixel-first glance UI

Ten apps use real monochrome G2 image containers where a symbol makes the screen faster to understand: PostureLens, DecibelGuard, Cadence, ShiftClock, OpenGlance, Lumen Glass, RainLens, Dayline, Map Glass, and Endurance HUD. RainLens switches weather symbols, Endurance HUD switches between running and cycling, and Map Glass draws the route itself. Text-critical apps such as PromptFlow, Babel Glass, PodCaption, FlowList, FieldLog, NextStop, Agent Glass, Companion, Status Glass, and Market Glance deliberately keep the full width for words, rows, or safety-critical values.

```
821 tests · 20 builds · every app confirmed rendering in the Even Hub simulator
```

**Nothing here has been verified on physical G2 hardware yet.** Each README
says exactly what that means for that app; where behaviour is known only from
community reports, it is labelled as such.

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

## Reference servers

Several apps talk to something you host. Each ships a working implementation, so
"self-hosted" is an afternoon rather than a project:

| App | Server | Size |
|---|---|---|
| Status Glass | [`reference-server.mjs`](apps/status-glass/examples/reference-server.mjs) | ~100 lines, no dependencies |
| Babel Glass | [`whisper-server.py`](apps/babel-glass/examples/whisper-server.py) | ~80 lines on faster-whisper |
| FieldLog | uses Babel Glass's server — the wire format is identical | — |
| Dayline | [`dayline-bridge.mjs`](apps/dayline/examples/dayline-bridge.mjs) | Calendar/reminder JSON endpoint |
| PodCaption | [`podcast-bridge.mjs`](apps/podcaption/examples/podcast-bridge.mjs) | Feed and transcript proxy restricted to one configured feed |
| Companion | [`assistant-bridge.mjs`](apps/companion/examples/assistant-bridge.mjs) | Push-to-talk upload and optional assistant upstream |
| Map Glass | [`route-bridge.mjs`](apps/map-glass/examples/route-bridge.mjs) | Route geometry endpoint |
| Endurance HUD | [`telemetry-bridge.mjs`](apps/endurance-hud/examples/telemetry-bridge.mjs) | Live run/bike telemetry ingest and display feed |
| Market Glance | [`market-bridge.mjs`](apps/market-glance/examples/market-bridge.mjs) | Read-only Polymarket/Kalshi position normalizer |

OpenGlance needs a Valhalla instance; its README gives the one-line Docker
command.

## Shared conventions

Applied by every app, carried as its own copy:

- **One screen, updated in place.** Page rebuilds are expensive on real
  hardware; text updates are cheap. No multi-step dialogs.
- **Identical gesture vocabulary** (`src/input/gestures.ts`): tap, double tap,
  swipe, long press — with the R1 ring reported as a distinct source and a
  user-toggleable swipe inversion.
- **Pure logic, thin SDK adapter.** Everything testable imports no SDK types.
  That is where all 821 tests live.
- **Redraw suppression.** The display is written only when the view changed.
- **Privacy-first defaults.** No permission is declared unless used. Apps that
  open the microphone show an indicator that cannot be hidden. Apps that could
  build a history of you deliberately do not.
- **Mocks are labelled.** Where an app can run without a server, the stand-in
  says `MOCK` on the glasses so its output is never mistaken for real.
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

Even Hub is in its pilot phase and has no public app catalogue yet. These apps
are built against SDK `0.0.16` and each one has been confirmed rendering in the
official simulator.

## License

MIT, per app.
