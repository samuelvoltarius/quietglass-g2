# PostureLens

**Quietglass** · Neck angle over time, measured on your head.

The IMU in the G2 sits on your head all day. Of roughly 150 community projects
for these glasses, two touch it. PostureLens uses it for the thing it is
uniquely placed to do: notice that your head has been forward for twenty
minutes, and say so before the ache does.

---

![On the glasses](docs/screenshot.png)

*Captured from the Even Hub simulator at the real 576 × 288.*

## How it measures

The Even Hub SDK reports IMU samples as `{x, y, z}` and documents **neither the
unit nor the axis orientation**. Guessing either would be unreliable across
firmware versions.

So PostureLens does not interpret the axes at all. You **calibrate** by sitting
the way you want to sit and tapping once. From then on it measures the **angle
between your current head direction and that calibrated one**.

That angle is well defined for any axis convention and any linear unit, because
the angle between two vectors survives rotation and scaling. The only
assumption is that a still head produces a vector dominated by gravity — true
of any accelerometer at rest.

**The practical consequence is better than a fixed reference:** it measures
against *your* upright, not against vertical. If you work at a standing desk,
in a car seat, or leaning back in a chair, calibrate there and that becomes
your zero.

## Why it does not nag

A monitor that complains every time you glance down is one you learn to ignore.

- A lean must be **held continuously** past a threshold (default 60 s) before
  anything is said. Looking down at your desk is not a posture problem.
- Samples are **smoothed** before being judged, so a nod or a step does not
  register.
- After a warning it goes **quiet** for a while (default 5 min) instead of
  repeating.
- While you are upright the display is **nearly empty** — one quiet line. Good
  posture should cost no attention at all.

## What you see

| Situation | Display |
|---|---|
| Not calibrated | "Sit the way you want to sit. Then tap." |
| Upright | *(almost nothing)* · `87% upright` |
| Leaning | `31° forward` · `leaning · 40s to warning` |
| Warned | **`HEAD FORWARD`** · `31° forward` · `held 1m 12s` |

The countdown while leaning is deliberate: it tells you a warning is coming and
gives you the chance to fix it first.

## Controls

| Gesture | Effect |
|---|---|
| **Tap** | Set the current posture as upright (calibrate or re-calibrate) |
| **Swipe** | Reset today's tally |
| **Double tap** | Leave PostureLens |

The **R1 ring** works the same as the temple pads.

## Install

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5192
npm run build      # typecheck + production bundle
npm test           # 48 unit tests
npm run sim        # Even Hub simulator pointed at the dev server
```

Use `127.0.0.1` rather than `localhost` — on some systems `localhost` resolves
to IPv6 first and the preview stays blank.

## Privacy

PostureLens has **no network code**. No endpoint, no telemetry, no account.

Crucially, **no posture history is written anywhere**. The calibration and your
thresholds are stored on the phone; the tally of time upright lives in memory
for the session and is gone when you close the app. There is no record of how
you sat today, because there is no file for one.

See [docs/PRIVACY.md](docs/PRIVACY.md).

## Known limitations

| Limitation | Detail |
|---|---|
| **Not verified on hardware** | Built and tested against SDK 0.0.16 and the simulator. The IMU's behaviour on a physical G2 — sample scale, noise, drift — has not been measured by Quietglass. Thresholds may need tuning once it has. |
| **Simulator has no real IMU** | The simulator does not produce head-motion data, so the measurement chain cannot be exercised end to end there. The maths and the state machine are covered by unit tests with synthetic vectors. |
| Forward vs. sideways | 0.1.0 measures total deviation from your calibrated pose. It does not yet distinguish leaning forward from tilting sideways. |
| Not a medical device | It counts degrees and minutes. It does not diagnose anything. |

## Roadmap

- Separate forward tilt from lateral tilt, once the axis convention is known
  from real hardware.
- Optional end-of-day summary on the phone.
- A gentler first cue before the full warning.

## License

MIT — see [LICENSE](LICENSE).
