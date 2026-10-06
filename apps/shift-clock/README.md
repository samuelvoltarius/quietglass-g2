# ShiftClock

**Quietglass** · Hands-free time tracking for Even Realities G2.

> **Auf Deutsch, kurz:** ShiftClock misst deine Arbeitszeit mit einem Tippen an der
> Brille – starten, stoppen, fertig. Die laufende Zeit und die Tagessumme siehst du
> direkt im Blickfeld. Kein Server, kein Konto, kein Internet nötig. Deutsch oder
> Englisch, je nach Handy-Sprache (umstellbar auf der Handy-Seite).
>
> **In 3 Schritten loslegen**
> 1. ShiftClock installieren und auf der Brille öffnen.
> 2. Das Projekt „Arbeit“ ist schon angelegt – tipp an die Brille, die Zeit läuft.
> 3. Nochmal tippen stoppt. Weitere Projekte (Kunden, Aufträge) legst du am Handy
>    an; dann wählst du mit Wischen und startest mit Tippen.
>
> Verlassen (doppeltippen) stoppt die Zeit **nicht**. Am Handy siehst du den Tag
> und exportierst eine CSV-Tabelle.

A compact pixel clock separates the running timer visually from project and history text.

For a non-persistent simulator showcase, open the development URL with `?demo=1`.

Tap to start a project. Tap to stop. The running total sits in your field of
view. No phone in your hand, no app switching, no reconstructing the day from
memory at six o'clock.

---

![On the glasses](docs/screenshot.png)

*Captured from the Even Hub simulator at the real 576 × 288.*

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
| **Tap** | Start the only project · or open the picker, then start | Stop |
| **Swipe** | Move through the projects (last row: *Cancel*) | — |
| **Double tap** | Leave (clock keeps running) | Leave (clock keeps running) |

The picker opens on your **most recently used project**, which is nearly always
the one you want again. With just one project there is no picker: the tap
starts it.

## First run

One project — "Work" (German: "Arbeit") — is ready on first run, so the very
first tap starts the clock. If every project has been removed, the glasses say
so and one tap creates it again; the phone page has the same one-tap button.

The **R1 ring** works the same as the temple pads.

## Export

CSV with date, project, start, end, seconds and **decimal hours** — the unit
invoices use, so the file goes straight into a spreadsheet.

The format is the same in every language, so it stays machine-readable: comma
between fields, UTF-8, RFC 4180 quoting, `date` as the local `YYYY-MM-DD`,
`start`/`end` as ISO 8601 in UTC, and hours with a **decimal point** (`1.50`),
even in German. Only the header row follows the app language
(`Datum,Projekt,Beginn,Ende,Sekunden,Stunden`). German Excel expects `;` and a
decimal comma — import via *Data → From Text/CSV* and choose comma as the
separator and "English (US)" as the locale. The phone page itself shows German
hours with a comma (`1,50 h`).

## Language

German and English, following the phone's language (English otherwise), with a
picker on the phone page. Every glasses string is tested against its row: 46
characters in the header and footer, 38 beside the pixel icon.

## Install

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5194
npm run build      # typecheck + production bundle
npm test           # 85 unit tests
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
