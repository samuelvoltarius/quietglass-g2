# ShiftClock

**Aigner Labs** · Hands-free time tracking for Even Realities G2.

Tap to start a project. Tap to stop. The running total sits in your field of
view. No phone in your hand, no app switching, no reconstructing the day from
memory at six o'clock.

---

## Why on glasses

Time tracking fails for one reason: the moment you should record something is
the moment your hands are full. By the time you pick up the phone you are on
the next thing, and the entry never gets made.

On glasses it is one gesture, and the elapsed time is already in front of you.

## What you see

```
Client A

    1:23

today 4:15  ·  tap = stop
```

The day total **includes the entry still running**, so the number on screen is
what the day actually stands at — not what it stood at an hour ago.

## Switching projects is one move

Choosing a different project closes the open entry and opens the new one at the
same instant. There is no gap between them and no state where the clock runs
against nothing. A test asserts the boundary: the old entry's end time and the
new one's start time are the same number.

## It will not lose your time

- The open entry is **written to storage as it happens**, not on exit. A crash,
  a flat phone or a dropped Bluetooth link does not lose the entry.
- **Leaving the app does not stop the clock.** Ending a shift is an explicit
  tap, never a side effect of closing something.
- Entries shorter than **10 seconds are discarded** as fumbles, so a mis-tap
  does not litter your log.

## Controls

| Gesture | Stopped | Running |
|---|---|---|
| **Tap** | Open the project picker, then start | Stop |
| **Swipe** | Move through the projects | — |
| **Double tap** | Leave (clock keeps running) | Leave (clock keeps running) |

The picker opens on your **most recently used project**, which is nearly always
the one you want again.

The **R1 ring** works the same as the temple pads.

## Export

CSV with date, project, start, end, seconds and **decimal hours** — the unit
invoices use, so the file goes straight into a spreadsheet.

## Install

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5194
npm run build      # typecheck + production bundle
npm test           # 40 unit tests
npm run sim        # Even Hub simulator pointed at the dev server
```

Use `127.0.0.1` rather than `localhost` — on some systems `localhost` resolves
to IPv6 first and the preview stays blank.

## Privacy

ShiftClock has **no network code**, no account and no sync. Your projects and
your log live on your phone. `app.json` requests no permissions and the app
uses no sensors. Export hands a file to your phone's own share sheet.

See [docs/PRIVACY.md](docs/PRIVACY.md).

## Known limitations

| Limitation | Detail |
|---|---|
| No editing on the glasses | Correcting an entry is done on the phone. |
| One clock at a time | Overlapping entries are not supported by design — they are almost always a mistake. |
| No rounding rules | Raw seconds are recorded. Rounding to billing increments is left to your spreadsheet. |
| Not verified on hardware | Built and tested against SDK 0.0.16 and the simulator. |

## Roadmap

- Editing and deleting individual entries on the phone.
- Optional idle detection: ask whether a long gap should be trimmed.
- Weekly summary view.

## License

MIT — see [LICENSE](LICENSE).
