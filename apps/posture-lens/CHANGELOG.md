# Changelog

## [0.7.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Die Klicks aus dem Menü kommen auf der Brille nie an, und Halten öffnet bei einer Seite mit Menü nur das Menü. Die Seiten tragen kein `menuObject` mehr; der Menü-Code bleibt für später.
- Halten öffnet wieder das eigene Menü der App (Sensor-Test, Zählung heute löschen, Hilfe). Wischen wählt den Eintrag, Tippen öffnet ihn, 2× geht zurück.
- Zählung heute löschen: Tippen merkt vor (`SICHER?`), ein zweites Tippen innerhalb von 4 s löscht; Wischen, 2× oder die Zeit brechen ab.
- Fußzeile wieder `Tippen = Haltung speichern · Halten = Menü · 2× = Ende`.

## [0.7.1] — 2026-10-15

### Behoben

- Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben; jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s), danach wird die Seite neu aufgebaut.

## [0.7.0] — 2026-10-14

### Changed (QIS v1.2)

- Side menu: the glasses' side menu (`menuObject`, `menuItemClickEvent`) carries `Hilfe`, `Sensor-Test` and `Zählung heute löschen`. The own on-screen menu (Hold) is gone; Hold now does nothing of its own, so the footers no longer list it (`Tippen = Haltung speichern · 2× = Ende`).
- Destructive menu item armed: `Zählung heute löschen` first only asks (header `Zählung löschen?`, footer `Nochmal im Menü = löschen · 2× = abbrechen`); choosing it again within 4 s clears. A tap, 2× or the timeout cancel. A hold or swipe does not cancel it, because holding is how the wearer reaches the menu again. A tap during the question cancels it and never re-calibrates. Afterwards the header says `Zählung gelöscht` for a few seconds.
- 2× in the help or the sensor test goes back to the posture screen (before: to the on-screen menu).
- The sensor test's recording footer (countdown + gestures) comes from the footer helper (`leadFooter`) instead of a hand-joined string.
- Phone: help texts follow the new menu. Tabs unchanged (`Haltung · Warnung · Brille · Mehr`); no `Verbindung` tab (the app has no server).

## [0.6.0] — 2026-10-14

Bedienung nach dem Quietglass-Bedienstandard (QIS v1).

### Behoben (Sicherheit)

- **Wischen löschte die Zählung von heute** (zweimal wischen). Wischen bewegt jetzt nur noch und ändert nie etwas; auf dem Haltungsbild tut es nichts. Das Löschen ist ein eigener Menüeintrag „Zählung heute löschen“ und wird erst vorgemerkt (Tippen: „Nochmal tippen = Zählung löschen · Wischen/2× = abbrechen“), ein zweites einzelnes Tippen innerhalb von 4 s führt es aus. Wischen, 2× oder 4 s ohne Eingabe brechen ab.
- Das Überschreiben der gespeicherten Haltung (zweites Tippen) wird ebenso von Wischen, 2× und Halten abgebrochen.

### Neu

- **Menü** per Halten: Sensor-Test, Zählung heute löschen, Hilfe (letzter Eintrag). Wischen wählt; `invertScroll` (Handy, Tab „Brille“) gilt für Menü und Hilfe.
- **Hilfeseite** mit den Gesten (zwei Seiten, Wischen blättert).

### Geändert

- 2× geht überall genau eine Ebene zurück (Sensor-Test → Menü, Hilfe → Menü, Menü → Haltungsbild); beendet wird nur auf dem Haltungsbild. Im Sensor-Test beendete 2× bisher die App. Halten im Sensor-Test schaltet nicht mehr um.
- Kopfzeile `POSTURE · Zustand` (der Aufrecht-Anteil und der Hinweis-Countdown stehen dort), Fußzeile nur noch Gesten in der Reihenfolge Tippen → Wischen → Halten → 2×, endend auf `2× = Ende` bzw. `2× = zurück` (englisch Tap/Swipe/Hold/2×, exit/back).
- Handy-Tabs: Haltung · Warnung · Brille · Mehr (neuer Tab „Brille“ mit Anzeige-Optionen und Wischrichtung). Posture Lens hat keine Verbindung, daher keinen Tab „Verbindung“.

## [0.5.0] — 2026-10-13

### Neu

- **Sensor-Test**: zeigt, was der Bewegungssensor wirklich schickt – das SDK sagt weder Einheit noch Achsen noch, ob es nur Beschleunigung oder auch Drehung ist.
  - Brille: **Halten** am Bügel schaltet um (Halten war bisher unbelegt). Live x / y / z mit zwei Nachkommastellen, Min/Max seit Start, Betrag |v| und Rate (Hz) in der Kopfzeile, die Achse mit der meisten Bewegung mit ● markiert. Höchstens 5 Text-Updates pro Sekunde, kein Seitenneuaufbau. Tippen setzt Min/Max zurück; Wischen tut im Test nichts, damit nichts versehentlich überschrieben wird. Doppeltippen beendet wie immer.
  - Handy (Tab „Mehr“ → „Sensor-Test starten“): dieselben Werte live, Pace-Auswahl 100…1000 (SDK-Wert `ImuReportPace`, Einheit unbekannt – die gemessene Rate zeigt, was passiert), „Aufnahme 20 s“ mit geführtem Ablauf (1) still geradeaus 3 s, 2) Kopf nach links, 3) nach rechts, 4) nicken, 5) Kopf neigen), danach CSV zum Herunterladen, Kopieren oder Markieren (`t_ms,step,x,y,z,magnitude`, volle Genauigkeit).
- Die Aufnahme bleibt im Speicher der Seite und wird nirgends hingeschickt.


## [0.4.2] — 2026-10-13

### Changed

- Handy-Seite in Tabs statt einer langen Spalte: Haltung · Warnung · Mehr (Tab-Leiste unten, gewählter Tab bleibt), Chip mit Kalibrierstatus oben.

## [0.4.1] — 2026-10-13

### Fixed

- Gestures are wired before the IMU is switched on. `imuControl` used to be awaited first; a call that never answered left the app deaf to everything, the double tap included. The call now runs in the background with a 5 s limit and ends in the "no motion sensor" screen.
- Leaving through the system (another app, the system menu) switches the IMU off and stops drawing; coming back rebuilds the page and switches it on again. A system exit or crash switches it off for good. The demo nodding stops with the app.
- A reconnect or a return to the foreground rebuilds the page even when nothing changed.

### Changed

- Overwriting a saved posture takes a second tap within 4 s ("Nochmal tippen = Haltung neu speichern"); the very first calibration still takes one tap. Clearing today's tally takes a second swipe ("Nochmal wischen = Zählung von heute löschen").
- Wording: "85 % aufrecht", "nach vorne geneigt" throughout, footer "2× = Ende".

## [0.4.0] — 2026-10-13

### Added

- The forward lean as big pixel digits ("18°") while leaning (or if the angle is switched on).
- A little figure in the header corner (64 x 30) that straightens or slumps in four steps with the lean; sent only when the step changes.
- ?demo=1 nods a made-up head without sensor.

### Changed

- Images are written at most every 700 ms; the page is created once per run and later only rebuilt (images are resent after every rebuild).

## [0.3.3] — 2026-10-13

### Changed

- Text beside the head gauge gets 42 characters per row (was 34); header and footer use the full 56 characters, so German messages are cut later.

## [0.3.2] — 2026-10-13

### Fixed

- Start language: the Even app's WebView reports English even on a German phone.
  An explicit language choice is now kept in the SDK store; without one, a German-speaking
  Even account country (AT/DE/CH/LI/LU) starts the app in German.

## [0.3.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

All notable changes to PostureLens are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-10-07

### Changed

- Store readiness: system exit dialog, privacy policy.
  - A double tap on the root screen now opens the system exit dialog
    (`shutDownPageContainer(1)`). Cancel and the app carries on unchanged;
    timers, streams and sensors stop only after you confirm. A failed call
    is caught and leaves the app running.
  - The IMU stays on while the dialog is open and is switched off only after you confirm.
  - `docs/PRIVACY.md` covers every permission in `app.json`, with a German
    summary, and is linked from the README.
  - Store art in `store/` (icon, 24 px monochrome icon, background,
    tagline), generated by `tools/store-art.mjs`.

## [0.1.0] — 2026-09-25

First release.

### Added
- Head-angle monitoring from the G2 IMU, sampled at 500 ms.
- Calibration-relative measurement: the angle is taken against a pose the user
  calibrates, not against vertical. This avoids interpreting the SDK's
  undocumented axis orientation and unit, and measures against the user's own
  upright rather than an assumed one.
- Sustain threshold, so a glance down never triggers a warning; only a
  continuously held lean does.
- Vector smoothing (EMA) before judgement, so nods and steps do not register.
- Snooze window after a warning, so it does not become noise.
- Near-empty display while upright — good posture costs no attention.
- Countdown while leaning, giving the user a chance to correct before the
  warning fires.
- Session tally of time upright versus leaning, held in memory only.
- Calibration persisted on the phone so it survives a restart.
- IMU reporting re-enabled automatically after a glasses reconnect.
- Phone companion for thresholds, smoothing and calibration management.
- 48 unit tests covering vector maths, payload decoding, the warning state
  machine, time accounting, view composition and storage validation.

### Known limitations
- **Not verified on physical hardware.** IMU scale, noise and drift on a real
  G2 have not been measured by Quietglass; thresholds may need tuning.
- The simulator provides no head-motion data, so the measurement chain cannot
  be exercised end to end there.
- Forward tilt and sideways tilt are not yet distinguished.
