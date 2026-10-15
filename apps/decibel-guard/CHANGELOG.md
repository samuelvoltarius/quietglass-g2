# Changelog

## [0.6.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Klicks kommen auf der Brille nie an, und Halten öffnet sonst das Menü statt die App zu erreichen. Die Seiten tragen kein `menuObject` mehr; der Menücode bleibt.
- Hilfe: Wischen in der Übersicht öffnet sie wieder (Hinweis `Wischen = Hilfe`); in der Hilfe blättert Wischen, 2× geht zurück.
- Unverändert per Geste: Tippen = messen / (beim Messen) nachfragen, nochmal tippen = stoppen; Halten = Dosis löschen fragen, ein Tippen bestätigt; 2× = zurück / Ende.

## [0.6.1] — 2026-10-15

### Behoben

- Die Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben. Jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s); danach gilt der Aufruf als fehlgeschlagen und die Seite wird neu aufgebaut.

## [0.6.0] — 2026-10-14

### Changed (QIS v1.2)

- Safety: stopping the measurement is arm-and-confirm. A tap while measuring only asks (`● MIKRO AN · Nochmal tippen = stoppen · 2× = abbrechen`); a second single tap within 4 s stops. A swipe, 2× or 4 s without input cancel. Starting still takes one tap.
- Safety: 2× on the main screen opens the system exit dialog without stopping first. Measuring (and the `● MIKRO AN` indicator) goes on while the dialog is open and after "stay"; the microphone only closes once the exit is confirmed.
- Side menu: the glasses' side menu (`menuObject`, `menuItemClickEvent`) carries `Hilfe`. A swipe no longer opens the help (swipes only turn its pages); the idle hint reads `Hilfe: Menü der Brille`.
- Footers (idle, measuring, armed, help, microphone error) come from a shared `footer()` helper (`glasses/footer.ts`); no hand-built gesture strings any more.
- Phone: new tab `Brille` (swipe direction moved there), order `Start · Einstellen · Brille · Mehr`. No `Verbindung` tab (the app has no server). Phone texts say `2×` instead of "Doppeltippen" / "Double tap".

## [0.5.0] — 2026-10-14

### Changed (QIS v1)

- Conforms to the Quietglass Interaction Standard (QIS v1, `docs/BEDIENSTANDARD.md`).
- Safety: clearing today's dose is arm-and-confirm. A hold only asks (`Nochmal tippen = Dosis löschen · Wischen/2× = abbrechen`); one single tap within 4 s confirms. A second hold, a swipe, a double tap or 4 s without input cancel, and a tap on the heels of the hold (under 0.4 s) is ignored. A plain tap never clears the dose.
- Double tap is back one level (help, question); only on the main screen it leaves the app.
- Header is `DECIBELGUARD · state`; footer lists Tippen/Wischen/Halten/2× in that order and ends in `2× = zurück` or `2× = Ende`.
- New help page ("Hilfe", two pages) opened by a swipe; the microphone indicator stays in the footer while it is open.
- `invertScroll` is no longer dead: the phone page has the switch, and it turns the help pages.

## [0.4.2] — 2026-10-13

### Changed

- Handy-Seite in Tabs statt einer langen Spalte: Start · Einstellen · Mehr (Tab-Leiste unten, gewählter Tab bleibt), Chip „kalibriert/geschätzt“ oben.

## [0.4.1] — 2026-10-13

### Fixed

- Clearing today's dose takes two steps: hold asks ("Nochmal halten = Tagesdosis löschen" on the glasses), a second hold or a tap within 4 s confirms; anything else, or waiting, keeps the dose.
- Today's dose survives a restart of the app (phone locked, Even app unloaded it). Only the day's total is kept (one number, until midnight) — still no audio and no level history.
- Leaving through the system closes the microphone and reopens it on return when it was measuring; a system exit closes it for good. The demo timer is stopped on exit.

### Changed

- Idle footer names hold and 2×.

## [0.4.0] — 2026-10-13

### Added

- The sound level as big pixel digits ("72 dB", 56 px tall; "~" marks an estimate) instead of small text.
- A peak-hold line in the level meter: it stays at the loudest recent level for two seconds, then falls slowly.
- ?demo=1 shows a made-up level without microphone.

### Changed

- Images are written at most every 700 ms and only when their picture changes; the body shows three rows.
- The page is created once per run and later only rebuilt (images are resent after every rebuild).

## [0.3.3] — 2026-10-13

### Changed

- Text beside the level meter gets 46 characters per row (was 38), so lines like "noch 1 h 10 min bei dieser Lautstärke" are no longer cut off; header and footer use the full 56 characters.

## [0.3.2] — 2026-10-13

### Fixed

- Start language: an explicit choice is kept in the Even SDK store (the WebView's localStorage may not survive a relaunch); without one, a German-speaking Even account country (AT/DE/CH/LI/LU) starts the app in German, even when the WebView reports English.

## [0.3.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

All notable changes to DecibelGuard are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-10-07

### Changed

- Store readiness: system exit dialog, privacy policy.
  - A double tap on the root screen now opens the system exit dialog
    (`shutDownPageContainer(1)`). Cancel and the app carries on unchanged;
    timers, streams and sensors stop only after you confirm. A failed call
    is caught and leaves the app running.
  - The microphone closes before the dialog appears and reopens if you cancel; the dose so far is kept.
  - `docs/PRIVACY.md` covers every permission in `app.json`, with a German
    summary, and is linked from the README.
  - Store art in `store/` (icon, 24 px monochrome icon, background,
    tagline), generated by `tools/store-art.mjs`.

## [0.1.0] — 2026-09-25

First release.

### Added
- Sound level from the glasses microphone: exact dBFS computed from raw
  little-endian s16 PCM, with an odd trailing byte ignored rather than misread.
- Noise dose accumulation using the level-and-duration model, with both the
  3 dB (EU) and 5 dB (OSHA) exchange rates and a configurable threshold below
  which sound does not accrue.
- Warning at 50% of the daily dose, not only once it is exceeded.
- Remaining permitted time at the current level.
- User-supplied calibration offset to approximate SPL, with uncalibrated
  readings marked `uncal.` on the glasses so a number is never mistaken for a
  measurement it is not.
- Dose accumulated over the wall-clock gap between audio blocks, so a dropped
  block does not silently shorten measured exposure.
- Microphone opens only on an explicit tap; `● MIC` is displayed for as long as
  it is open and cannot be hidden.
- Phone companion for calibration, dose rules and the live dBFS readout.
- 58 unit tests covering PCM decoding, dBFS conversion, the dose model,
  exchange rates, display escalation and storage validation.

### Known limitations
- **Not a certified sound level meter.** Uncalibrated microphone, user-supplied
  offset, no frequency weighting.
- No A-weighting, so readings over-report low-frequency energy relative to a
  dB(A) meter.
- No peak or impulse assessment.
- The dose resets when the app closes; no history is kept, by design.
- Not yet verified on physical hardware; the simulator provides no real audio.
