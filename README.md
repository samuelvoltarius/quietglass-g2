# Aigner Labs — applications for Even Realities G2

Apps for the [Even Realities G2](https://www.evenrealities.com) smart glasses,
built on the official Even Hub SDK.

Two things run through all of them:

> **They run on your own hardware.** No mandatory cloud, no API keys, no
> subscription. Where an app needs speech recognition or routing, you point it
> at your own server.
>
> **They use the sensors nobody uses.** Of ~150 community G2 projects, two
> touch the IMU. It sits on your head all day.

Every app lives in its own directory, builds on its own, and is releasable on
its own. **There is no shared runtime library** — conventions are shared by
copying, so no app can break another.

## Apps

| App | What it does | Status |
|---|---|---|
| [**PromptFlow**](apps/promptflow) | Teleprompter. Word-based pacing, four reading modes. | **0.1.0 — complete** · 91 tests |
| [**FlowList**](apps/flowlist) | Hands-free checklists with branching, critical steps, shareable packs. | **0.1.0 — complete** · 79 tests |
| [PostureLens](apps/posture-lens) | Neck angle over time from the IMU. Warns before the ache. | planned |
| [DecibelGuard](apps/decibel-guard) | Noise dose over time. Measures level only — records nothing. | planned |
| [FieldLog](apps/field-log) | Walk an inspection hands-free: speak the defect, attach a photo. | planned |
| [Cadence](apps/cadence) | Visual metronome and practice log. The G2 has no speaker — so make the beat visible. | planned |
| [ShiftClock](apps/shift-clock) | Hands-free time tracking onto projects, CSV export. | planned |
| [Babel Glass](apps/babel-glass) | Live captions and translation against **your own** Whisper. | planned |
| [OpenGlance Navigation](apps/openglance-nav) | Turn-by-turn on OpenStreetMap data via Valhalla. No Mapbox. | planned |
| [Status Glass](apps/status-glass) | Homelab and service monitoring over a simple open protocol. | planned |

## Start here

**[docs/SDK-CAPABILITIES.md](docs/SDK-CAPABILITIES.md)** — what the Even Hub SDK
actually provides, read from the shipped type definitions of
`@evenrealities/even_hub_sdk@0.0.16`, not from documentation prose. It lists
what exists, the limits the SDK's own validators enforce, what does **not**
exist, and the pitfalls we hit.

It is useful to anyone building for the G2, not just to us. The most expensive
one, in short:

> **A tap arrives with no `eventType` field.** proto3 omits fields holding
> their default value, and `CLICK_EVENT` is `0`. Treat a missing event type as
> CLICK, or your app will receive events and silently ignore every tap.

## Shared conventions

Applied by every app, carried as its own copy:

- **One screen, updated in place.** Page rebuilds are expensive on real
  hardware; text updates are cheap. No multi-step dialogs.
- **Identical gesture vocabulary** (`src/input/gestures.ts`): tap, double tap,
  swipe, long press — with the R1 ring reported as a distinct source and a
  user-toggleable swipe inversion.
- **Pure logic, thin SDK adapter.** Everything testable imports no SDK types.
- **Redraw suppression.** The display is written only when the view changed.
- **Privacy-first defaults.** No permission is declared unless the app uses it.
- **Strict TypeScript**: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noUnusedLocals`.
- **No credentials in source.** Endpoints and tokens are entered at runtime on
  the phone and never logged.

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

Starting a new app:

```bash
node tools/scaffold.mjs <dir> "<Display Name>" <devPort> "<description>"
```

## Status

Even Hub is in its pilot phase and has no public app catalogue yet. These apps
are built against SDK `0.0.16` and tested in the official simulator. **Nothing
here has been verified on physical G2 hardware yet** — where behaviour is known
only from community reports, the documentation says so explicitly.

## License

MIT, per app.
