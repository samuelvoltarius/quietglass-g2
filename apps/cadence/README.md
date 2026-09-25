# Cadence

**Quietglass** · Visual metronome and practice log for Even Realities G2.

The G2 has no speaker. That sounds like a reason not to build a metronome — it
is actually the reason to build this one: the beat sits in your field of view
while your ears stay free for the instrument.

---

![On the glasses](docs/screenshot.png)

*Captured from the Even Hub simulator at the real 576 × 288.*

## What it shows

```
Scales

    ◆    ○    ○    ○

    100 bpm   4/4   bar 12

running · 4m 30s · tap = pause
```

One marker per beat. The **downbeat has its own shape** (`◆`), so you can find
the top of the bar without counting from the left — which matters when you are
reading it out of the corner of your eye.

## Honest about timing

Every display update travels over Bluetooth, and the jitter on that link is not
something an app can control.

Cadence handles this in two ways:

**The count never drifts.** Position is re-derived from the clock on every
redraw, never incremented per frame. A late or dropped update makes the display
late — it never makes the count wrong. There is a test that samples the position
a hundred times and asserts the answer is identical to sampling it once.

**Downbeat-only mode.** At fast tempos, marking every beat over BLE stops being
readable. Marking just the bar stays legible at any tempo, and it is what a
player actually needs: you feel the beats in between, you just need to know
where the bar starts.

**What Cadence is not:** a timing reference. For recording or click-track work,
use something wired. This is a practice aid.

## The practice log

The metronome is the visible part. The log is the part worth keeping.

Tap to start, and if you have selected something you are practising, Cadence
records it: **what, at what tempo, for how long**. Over time that gives you the
number players never write down and always want —

| Item | Time | Best |
|---|---|---|
| Study No. 2 | 4h 12m | 108 bpm |
| Scales | 2h 30m | 132 bpm |

Sessions under 10 seconds are not recorded, and a best tempo needs at least 30
seconds at that speed. A ten-second burst at 200 bpm is not a tempo you can
play, so it does not go in the record.

Export as CSV whenever you like.

## Controls

| Gesture | Effect |
|---|---|
| **Tap** | Start / pause — also starts and ends the practice session |
| **Swipe** | Tempo ±4 bpm |
| **Hold** | Reset the bar count |
| **Double tap** | Leave Cadence |

The **R1 ring** works the same as the temple pads — useful when your hands are
on an instrument and reaching for your temple is not.

## Install

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5193
npm run build      # typecheck + production bundle
npm test           # 62 unit tests
npm run sim        # Even Hub simulator pointed at the dev server
```

Use `127.0.0.1` rather than `localhost` — on some systems `localhost` resolves
to IPv6 first and the preview stays blank.

## Privacy

Cadence has **no network code** and **uses no sensors** — not even the
microphone, since tap tempo is driven by the touchpad rather than by listening.
`app.json` requests no permissions. Your practice log lives on your phone and
is exported only when you ask.

See [docs/PRIVACY.md](docs/PRIVACY.md).

## Known limitations

| Limitation | Detail |
|---|---|
| **No sound** | The G2 has no speaker. By design, not by omission. |
| Timing jitter | BLE update timing is outside the app's control. Use downbeat-only at fast tempos. |
| Not verified on hardware | Built and tested against SDK 0.0.16 and the simulator. |
| No subdivisions | Eighths and triplets within the beat are not shown in 0.1.0. |

## Roadmap

- Subdivisions (eighths, triplets) as a secondary marker row.
- Tempo ramps for speed training — start slow, step up automatically.
- Per-item target tempo, with progress toward it.

## License

MIT — see [LICENSE](LICENSE).
