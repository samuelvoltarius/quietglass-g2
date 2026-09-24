# PostureLens — architecture

## The central decision

The SDK gives `{x, y, z}` with no documented unit and no documented axis
orientation. Two options:

1. Guess the convention, derive pitch, and break when firmware changes.
2. Never interpret the axes at all.

PostureLens takes the second. It stores a **reference vector** captured when the
user says "this is upright", and thereafter reports

```
angle = arccos( normalise(current) · normalise(reference) )
```

This is invariant under rotation of the axis frame and under uniform scaling of
the unit, so it is correct for any convention the firmware might use. A test
pins the invariance by comparing vectors of wildly different magnitudes.

The side effect is a better product: the zero point is the user's own posture,
not vertical, so it works at a standing desk or in a car seat.

## Layers

```
        phone                        glasses
  ┌───────────────┐           ┌──────────────────┐
  │  ui/phone.ts  │           │  three text      │
  │  thresholds   │           │  containers      │
  └───────┬───────┘           └────────▲─────────┘
          │ storage/persist.ts          │ glasses/render.ts  ← only SDK calls
          ▼                             │ glasses/diff.ts
  ┌───────────────────────────────────────────────┐
  │                  main.ts                      │  wiring + IMU subscription
  └───────────────────────────────────────────────┘
          │                  │              │
          ▼                  ▼              ▼
   imu/vector.ts     posture/monitor.ts   input/gestures.ts
          └──────── pure, fully unit-tested ─────┘
                          │
                          ▼
                  glasses/view.ts   ← decides what is shown (pure)
```

`posture/monitor.ts` is a pure state machine: `addSample(monitor, sample,
settings, now)` returns a new monitor. Time is always passed in, never read
from the clock, which is what makes the warning logic testable without waiting
a minute.

## The warning state machine

```
uncalibrated ──calibrate──▶ good ⇄ leaning ──held > sustain──▶ warned
                              ▲                                   │
                              └──────────── upright ──────────────┘
```

Three guards keep it from becoming noise:

- `sustainSeconds` — the lean must be continuous. `leaningSince` is cleared the
  moment the angle drops back.
- `smoothing` — an EMA over the **vector**, not the angle, so direction is
  averaged rather than magnitude.
- `snoozeSeconds` — after a warning, no new warning until the window passes.

## Display rule

Good posture renders an **empty header and empty body**. This is the app's
whole design thesis: a monitor that is always visible is one that stops being
read. `view.test.ts` asserts the emptiness explicitly, so it cannot regress.

## Power

IMU reporting runs at `ImuReportPace.P500` (500 ms). Posture changes over
minutes; 100 ms sampling would cost BLE traffic and battery for no benefit.

IMU reporting does not survive a glasses reconnect, so
`onDeviceStatusChanged` re-enables it.

## Testing

```
tests/posture.test.ts    23   vector maths, payload decoding, warning machine, tallies
tests/view.test.ts       13   each state's display, formatting, storage validation
tests/gestures.test.ts   12   event decoding, ring detection, proto3 omission
```

Vectors in tests are synthetic and exact (`{0,0,1}` vs `{0,1,1}` is exactly
45°), so the assertions are about behaviour rather than about sensor noise.
