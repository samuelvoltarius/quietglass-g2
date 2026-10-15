# Changelog

## [0.6.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus: Seine Klicks kommen auf der Brille nie in der App an, und Halten öffnet sonst das Menü statt die App zu erreichen. Die Seiten tragen kein Menü mehr (`SIDE_MENU = false`); der Menü-Code und der Klick-Handler bleiben.
- Hilfe wieder per Geste: Halten bei stehendem Takt öffnet die Hilfe (2× geht zurück), die Fußzeile zeigt wieder `Halten = Hilfe`. Halten bei laufendem Takt setzt weiter auf Takt 1 zurück; Tippen = Start/Pause (erst nach 2. Tippen), Wischen = Tempo.
- Hilfetexte der Brille und Hinweise am Handy beschreiben wieder die Gesten statt des Seitenmenüs.

## [0.6.1] — 2026-10-15

### Behoben

- Die Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben. Jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s); danach gilt der Aufruf als fehlgeschlagen und die Seite wird neu aufgebaut.

## [0.6.0] — 2026-10-14

### Changed (QIS v1.2)

- Conforms to QIS v1.2 (`docs/BEDIENSTANDARD.md`, audit 2026-10-14).
- The help moved into the glasses' side menu (entry "Hilfe", also while the beat runs; the beat keeps going, a pending pause is cancelled, 2× returns to the main screen). Hold on the stopped metronome no longer opens it and now does nothing; hold while the beat runs still goes back to bar 1.
- The stopped footer reads `Tippen = Start · Wischen = Tempo · 2× = Ende`; the help page text and the phone's gesture table mention the menu.
- Unchanged, documented exception to "swipe never changes data" (rule 5): the swipe sets the tempo, the app's core control. A language change on the phone rebuilds the page so the menu follows the language.

## [0.5.0] — 2026-10-14

### Changed (QIS v1)

- Conforms to the Quietglass Interaction Standard (QIS v1, `docs/BEDIENSTANDARD.md`).
- Safety: a single tap no longer pauses a running beat (which also ends the practice session). Tap arms (`Nochmal tippen = pausieren · Wischen/2× = abbrechen`), a second tap within 4 s pauses. Swipe, hold, double tap or 4 s without input cancel; a swipe then does not change the tempo.
- Double tap is back one level (help -> main screen); on the main screen it leaves through the system dialog. It never pauses the beat.
- Header is `CADENCE · state`; the practised item and the session clock moved into the body. Footers come from one `footer()` helper in the order Tippen/Wischen/Halten/2× and end in `2× = zurück` or `2× = Ende` (the Wischen part is dropped when the row is too wide).
- Hold while stopped opens a help page listing the gestures; while the beat runs it still goes back to bar 1.
- Phone: new tab "Brille" (Glasses) with the gesture table and a switch to reverse the swipe direction. The `invertScroll` setting had no switch before, so it could never be turned on.
- Tabs: Takt · Üben · Brille · Mehr (no "Verbindung" tab: Cadence has no server).
- Swipe still adjusts the tempo (a setting, not a record); it is the one deliberate exception to "swipe only moves".

## [0.4.2] — 2026-10-13

### Changed

- Handy-Seite in Tabs statt einer langen Spalte: Takt · Üben · Mehr (Tab-Leiste unten, gewählter Tab bleibt), Chip mit Tempo und Taktart oben.

## [0.4.1] — 2026-10-13

### Fixed

- Hold now does what the phone says: back to bar 1. A running beat keeps running from a fresh bar instead of stopping; a paused one only loses its count.
- The beat and the open practice session survive a restart of the app (phone locked, Even app unloaded it). Away for more than 30 minutes, the session is logged up to the last sign of life.
- Leaving through the system stops the beat timers and drawing; coming back rebuilds the page.

### Changed

- Glasses say "BPM" instead of "Schläge/Min"; the footer names hold and 2× when there is room.

## [0.4.0] — 2026-10-13

### Added

- The tempo as large pixel digits (image, 224 x 72) with a small "BPM" beside it; it is only resent when the tempo changes.
- A pendulum (image, 200 x 96) that swings from side to side with every beat up to 120 BPM; at 60 BPM and below it also passes through the middle half-way between two beats. Above 120 BPM it is not drawn and the row of beat dots carries the beat, as before. A picture is only sent when the pendulum has moved.
- The beat dots and info lines sit below the pictures (four rows).

### Fixed

- Page set-up on the glasses: one `rebuildPageContainer`, then exactly one `createStartUpPageContainer`, later pages are rebuilds.

## [0.3.4] — 2026-10-13

### Changed

- Beat markers are spread across the display (wider gap for short bars) so the beat is easier to catch in peripheral vision.
- The "swipe = tempo" hint also shows while a practice session is running, when the line has room.

## [0.3.3] — 2026-10-13

### Fixed

- Start language: an explicit choice is kept in the Even SDK store (the WebView's localStorage may not survive a relaunch); without one, a German-speaking Even account country (AT/DE/CH/LI/LU) starts the app in German, even when the WebView reports English.

## [0.3.2] — 2026-10-13

### Changed

- Layout: the metronome sign moved into the top-right corner of the header; the body now uses the full display width.

## [0.3.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

All notable changes to Cadence are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-10-07

### Changed

- Store readiness: system exit dialog, privacy policy.
  - A double tap on the root screen now opens the system exit dialog
    (`shutDownPageContainer(1)`). Cancel and the app carries on unchanged;
    timers, streams and sensors stop only after you confirm. A failed call
    is caught and leaves the app running.
  - `docs/PRIVACY.md` covers every permission in `app.json`, with a German
    summary, and is linked from the README.
  - Store art in `store/` (icon, 24 px monochrome icon, background,
    tagline), generated by `tools/store-art.mjs`.

## [0.1.0] — 2026-09-25

First release.

### Added
- Visual metronome for the G2: a row of markers, one per beat, with the
  downbeat drawn in its own shape so the top of the bar is identifiable
  without counting.
- Position derived from elapsed time on every redraw rather than accumulated
  per tick, so a late or dropped frame makes the display late but never wrong.
  A test asserts that sampling more often does not change the result.
- Redraws scheduled onto the next beat boundary instead of polled at a fixed
  rate, which keeps BLE traffic proportional to the tempo.
- "Downbeat only" marker mode for fast tempos, where per-beat marking over
  Bluetooth stops being readable.
- Time signatures including 3/4, 6/8, 5/4 and 7/8.
- Tap tempo, ignoring stale gaps from an abandoned attempt.
- Practice log: what was practised, at what tempo, for how long. Totals per
  item, best tempo per item, today's total, CSV export.
- Sessions under 10 seconds are not recorded; a best tempo needs 30 seconds at
  that speed, so a brief burst cannot inflate the record.
- Stored log is bounded, so per-app storage cannot grow without limit.
- Phone companion for tempo, signature, practice items and the log.
- 62 unit tests covering timing, drift resistance, tap tempo, log summaries,
  CSV quoting, storage validation and the beat display.

### Known limitations
- **Cadence makes no sound.** The G2 has no speaker; the beat is visual only.
- Display updates travel over Bluetooth and their jitter is outside the app's
  control. At fast tempos use "downbeat only". Cadence is a practice aid, not
  a timing reference.
- Not yet verified on physical hardware.
