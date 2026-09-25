# Quietglass — applications for Even Realities G2

Eleven apps for the [Even Realities G2](https://www.evenrealities.com) smart
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

```
691 tests · 11 builds · every app confirmed rendering in the Even Hub simulator
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

Three apps talk to something you host. Each ships a working implementation, so
"self-hosted" is an afternoon rather than a project:

| App | Server | Size |
|---|---|---|
| Status Glass | [`reference-server.mjs`](apps/status-glass/examples/reference-server.mjs) | ~100 lines, no dependencies |
| Babel Glass | [`whisper-server.py`](apps/babel-glass/examples/whisper-server.py) | ~80 lines on faster-whisper |
| FieldLog | uses Babel Glass's server — the wire format is identical | — |

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
  That is where all 616 tests live.
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
