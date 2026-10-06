# DecibelGuard

**Quietglass** · Noise dose over time. Measures the level, records nothing.

## Kurz auf Deutsch

DecibelGuard zählt mit, wie viel Lärm du heute abbekommst, und warnt dich, bevor
es deinem Gehör zu viel wird — schon bei der Hälfte des Tageslimits. Es wird nie
Ton aufgenommen oder gespeichert, und es gibt keinen Server.

**In 3 Schritten loslegen**

1. App in der Even-App öffnen und die Brille aufsetzen.
2. **Einmal auf den Bügel tippen** — die Brille misst und zeigt `● MIKRO AN`.
3. Einfach weitermachen. Wird es zu viel, steht es groß auf der Brille. Nochmal tippen beendet die Messung.

Ohne Einstellungen sind die Werte grob geschätzt (deutlich mit „etwa“
markiert). Wer es genauer will, gleicht auf der Handy-Seite unter „Genauer
messen“ mit einem echten Messgerät ab. Es ist eine Orientierung, kein
Messgerät. Die App folgt der Sprache deines Handys (Deutsch oder Englisch);
umstellen kannst du das auf der Handy-Seite unter „Sprache“.

---

A monochrome speaker-and-wave pixel symbol makes the live noise screen immediately recognizable without storing audio.

Hearing damage is cumulative and silent. A single loud moment is rarely the
problem; four hours in a workshop is. DecibelGuard watches the level around you
and tells you when the day's dose is used up — not just that it is loud right
now.

---

![On the glasses](docs/screenshot.png)

*Captured from the Even Hub simulator at the real 576 × 288.*

## Read this first

**DecibelGuard is an indicator, not a sound level meter.**

The G2 microphone has no published sensitivity, so nothing in the SDK can turn
its signal into an absolute sound pressure level. DecibelGuard computes an
exact **dBFS** value from the raw PCM, then applies a **calibration offset you
enter yourself** to approximate SPL. No frequency weighting (A, C) is applied.

Until you calibrate, DecibelGuard uses an **estimated** offset of 120 dB (a
typical MEMS microphone sensitivity, −26 dBFS at 94 dB SPL) so the dose works
straight after install. Every such reading is marked `about 72 dB` on the
glasses, so a number is never mistaken for a measurement it is not. The
estimate errs high on purpose: for hearing, an early warning beats a late one.

**Do not use it for compliance, legal evidence or workplace assessment.** Use it
to notice that you have been somewhere loud for a long time.

## Why dose, not loudness

Occupational limits are written as a level *and* a duration — commonly
85 dB for 8 hours — with an exchange rate saying how fast the permitted time
shrinks as the level rises. At a 3 dB rate, every 3 dB halves it:

| Level | Permitted |
|---|---|
| 82 dB | 16 h |
| 85 dB | 8 h |
| 88 dB | 4 h |
| 91 dB | 2 h |
| 100 dB | ~15 min |

DecibelGuard accumulates that fraction as you go. Both the 3 dB (EU) and 5 dB
(OSHA) rules are supported.

## What you see

| Situation | Display |
|---|---|
| Stopped | `Not listening.` · `Tap once to start measuring.` · `tap = start` |
| Microphone refused | `Microphone not available.` · `tap = try again` |
| Quiet | `62 dB` · `● MIC` |
| Accumulating | `86 dB` · `dose 34% of today's limit` · `2h 10m left at this level` |
| Halfway | **`HALFWAY`** · `dose 60% of today's limit` · `A quiet break helps.` |
| Limit reached | **`DAILY DOSE REACHED`** · `Go somewhere quiet or use earplugs.` |

The warning at **halfway** is deliberate. Being told only once the limit has
passed is useless for preventing anything.

## Privacy is the point

- **No audio is ever recorded or stored.** Each PCM block is reduced to a single
  number and discarded immediately.
- **No level history is written either.** A minute-by-minute record of how loud
  it was around you is a record of where you were and what you were doing. The
  dose lives in memory for the session and is gone when you close the app.
- **Measuring never starts by itself.** The microphone opens only on an explicit
  tap.
- **While the microphone is open, the glasses show `● MIC`.** There is no code
  path that measures without that indicator, and no setting to hide it.

See [docs/PRIVACY.md](docs/PRIVACY.md).

## Calibrating

1. Start measuring on the glasses.
2. Hold a reference meter next to the glasses in a steady sound.
3. Read the live dBFS value in the phone app and the meter's dB value.
4. Enter the difference (reference minus live) as the offset.

A typical offset lands between 90 and 130. One linear offset is a reasonable
approximation across the mid range and nothing more.

## Controls

| Gesture | Effect |
|---|---|
| **Tap** | Start / stop measuring |
| **Hold** | Reset the accumulated dose |
| **Double tap** | Leave — stops the microphone |

## Install

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5195
npm run build      # typecheck + production bundle
npm test           # 78 unit tests
npm run sim        # Even Hub simulator pointed at the dev server
```

## Known limitations

| Limitation | Detail |
|---|---|
| **Not a certified meter** | Uncalibrated microphone, user-supplied offset, no frequency weighting. |
| **No A-weighting** | Occupational limits are defined in dB(A). DecibelGuard is unweighted, so it over-reports low-frequency energy relative to a proper dB(A) meter. |
| No peak/impulse limit | Only the time-averaged dose is tracked; sudden impulses are not assessed. |
| Dose resets on close | By design — no history is kept. |
| Not verified on hardware | Built and tested against SDK 0.0.16; the simulator provides no real audio. |

## Roadmap

- A-weighting filter, which would make the numbers comparable with real meters.
- Optional dose persistence across a working day, opt-in and local.
- Peak/impulse detection.

## License

MIT — see [LICENSE](LICENSE).
