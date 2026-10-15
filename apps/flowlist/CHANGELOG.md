# Changelog

## [0.5.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Die Klicks im Menü kommen auf der Brille nie an, und Halten öffnet sonst das Menü statt die App zu erreichen (Schrittprotokoll 15.10.2026). Die Seiten tragen kein Menü mehr; Menücode und `menuItemClickEvent`-Handler bleiben, damit es wieder eingeschaltet werden kann.
- Wischen nach oben merkt „Schritt zurück“ vor, Wischen nach unten bei einem optionalen Schritt „Auslassen“; erst das nächste Tippen führt es aus, Wischen, 2× oder 4 s ohne Eingabe brechen ab (ändert also nie still etwas). Bei einer Frage bewegt Wischen weiter nur die Markierung.
- Halten zeigt wieder die Info zum Schritt, solange man hält; ohne Zusatzinfo (und auf dem leeren und dem Abschluss-Bild) öffnet Halten die Hilfe.
- Hilfetexte und Fußzeilen der Brille (de/en) und die Hinweise am Handy beschreiben wieder die Gesten statt des Menüs. Die Versionsangabe in „Mehr“ am Handy stimmt wieder (stand noch auf 0.5.0).
- Tests: Seiten ohne `menuObject`, Wischen merkt Zurück/Auslassen vor und das Tippen führt es aus, Halten öffnet die Hilfe.

## [0.5.1] — 2026-10-15

### Behoben

- Die Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben. Jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s); danach wird die Seite neu aufgebaut.

## [0.5.0] — 2026-10-14

Bedienung nach QIS v1.2 (Audit 14.10.2026).

### Geändert (QIS v1.2)

- **Seitenmenü der Brille** (`menuObject`, Klicks über `menuItemClickEvent`; Vorlage Babel Glass): `Hilfe`, `Info zum Schritt`, `Schritt zurück`, `Schritt auslassen`. Die Hilfe hängt nicht mehr an Halten (vorher auf Schritten mit Zusatzinfo gar nicht erreichbar).
- **Wischen bewegt nur noch die Ansicht.** Wischen nach oben macht keinen Schritt mehr rückgängig (die Fortschrittsanzeige konnte durch eine Fehlgeste zurückspringen), Wischen nach unten merkt kein Auslassen mehr vor. Auf einer Frage markieren beide Richtungen weiter die Antwort; sonst tut Wischen nichts außer eine offene Rückfrage abzubrechen.
- **„Schritt zurück“ ist scharf geschaltet:** der Menüpunkt merkt vor („Nochmal tippen = Schritt zurück · Wischen/2× = abbrechen“, Kopf `FLOWLIST · Zurück?`); ein einzelnes Tippen oder ein zweiter Klick auf denselben Menüpunkt innerhalb von 4 s führt aus, Wischen, 2× oder 4 s ohne Eingabe brechen ab. Beim ersten Schritt und während einer offenen Bestätigung tut der Punkt nichts. Das Rückgängigmachen lässt sich auch auf der „Fertig!“-Seite vormerken.
- **„Schritt auslassen“** (nur optionale Schritte) liegt im Menü und ist ebenso vorgemerkt; auf anderen Schritten tut der Punkt nichts.
- **„Info zum Schritt“** zeigt die Zusatzinfo bis zur nächsten Geste; Halten zeigt sie weiter, solange gehalten wird, falls die Brille das Halten an die App durchreicht.
- Fußzeilen: `Halten = Menü` statt `Halten = Info/Hilfe`; der Wisch-Hinweis steht nur noch auf Fragen („wählen“). Hilfeseite und Handy-Tabelle (Wischen/Halten) beschreiben das neue Verhalten.
- Sprachwechsel am Handy baut die Brillenseite neu auf, damit das Menü die Sprache trägt.
- Demo: FlowList braucht keinen Server und liefert Beispiel-Listen am Handy; kein Demo-Hinweis nötig (v1.2 Nr. 7).

## [0.4.0] — 2026-10-14

### Geändert (QIS v1)

- Bedienung nach dem Quietglass-Bedienstandard (QIS v1, `docs/BEDIENSTANDARD.md`).
- **Sicherheit:** Wischen verändert die Checkliste nicht mehr. Wischen nach unten auf einem optionalen Schritt merkt das Auslassen nur vor („Nochmal tippen = auslassen · Wischen/2× = abbrechen“); erst ein einzelnes Tippen innerhalb von 4 s lässt den Schritt aus. Am Ende fragt Tippen erst nach („Nochmal tippen = neu starten“), statt die fertige Liste sofort zurückzusetzen. Wischen, 2× oder 4 s ohne Eingabe brechen ab.
- Die bestehende Rückfrage bei wichtigen Schritten (`(!)`) folgt derselben Regel: Wischen (oben wie unten), 2× oder 4 s brechen ab; 2× verlässt die App dabei nicht mehr.
- Kopfzeile `FLOWLIST · Zustand` (z. B. `FLOWLIST · 3/7`, `FLOWLIST · fertig`); der Abschnittsname steht nicht mehr in der Kopfzeile, die rechte Hälfte gehört dem Fortschrittsbalken. Fußzeilen über den gemeinsamen `footer()`-Helfer in der Reihenfolge Tippen/Wischen/Halten/2× mit `2× = Ende`; passt die Zeile nicht in 56 Zeichen, entfallen zuerst die Zeit, dann der Wisch-Teil.
- Neue Hilfeseite: Halten öffnet sie, wo es keine Zusatzinfo gibt (Schritt ohne Info, Ende, leere Liste); Tippen, Halten oder 2× schließen sie. Auf Schritten mit Zusatzinfo zeigt Halten weiter die Info.
- `invertScroll` gilt wie bisher für die Frage-Schritte (Wischrichtung am Handy umkehrbar).
- Handy-Seite: Tabs `Listen · Neu · Brille · Mehr`. „Mehr“ enthält die Bedienung, Version und Datenschutz (FlowList hat keine Verbindung, daher kein Tab „Verbindung“). „2×“ statt „Doppeltippen“.

## [0.3.2] — 2026-10-13

### Geändert

- Handy-Seite in Tabs statt einer langen Spalte: Listen · Neu · Brille (Tab-Leiste unten, gewählter Tab bleibt), Status-Chip mit der aktiven Liste oben. Die Sprachwahl steht jetzt unter „Brille“.

## [0.3.1] — 2026-10-13

### Fixed

- The run survives a restart of the app (phone locked for a while, Even app unloaded it): FlowList comes back at the same step with what was done and skipped, instead of step 1. A run older than 12 hours, or of another list, starts fresh.
- Leaving through the system (not by double tap) is handled: the clock stops in the background, the page is rebuilt on return, a system exit saves the run.

### Changed

- Footers name every gesture in one style: `Tippen = erledigt · ↑ = zurück` (plus `Halten = Info` when the step has details), `2× = Ende`.

## [0.3.0] — 2026-10-13

### Added

- The current step is drawn big and bold as a picture across the top (576 x 96, two image containers), word-wrapped, in the largest type that fits; the body below carries the confirm banner, choices, detail or the next step. A step too long even at the smallest size is also repeated in full in the body.

### Changed

- The body holds four rows. The page is created once per run and later only rebuilt (images are resent after every rebuild).

## [0.2.3] — 2026-10-13

### Changed

- Default row width is now 56 characters (was 46) to match the display; a stored 46 (the old factory default) moves to 56, any other chosen width is kept. Footer hints now have room for the elapsed time next to them.

## [0.2.2] — 2026-10-13

### Fixed

- Start language: the Even app's WebView reports English even on a German phone.
  An explicit language choice is now kept in the SDK store; without one, a German-speaking
  Even account country (AT/DE/CH/LI/LU) starts the app in German.

## [0.2.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

All notable changes to FlowList are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-10-07

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
  - `min_app_version` raised from 2.0.0 to 2.2.10, the floor of SDK 0.0.16
    that `evenhub pack` already stamped.

## [0.1.0] — 2026-09-25

First release.

### Added
- Hands-free checklist runner for Even Realities G2. One step on screen at a
  time, with position, section and progress always visible.
- Step kinds: normal, **optional** (skippable, excluded from progress),
  **critical** (requires a second tap to confirm) and **choice** (branches to
  another step).
- Branch-aware history: going back returns to the step you actually came from,
  not to the previous line in the list.
- Detail text on demand — hold to read, release to hide. Holding commits nothing.
- Markdown import: ordinary task lists work unchanged, with `(!)` and
  `(optional)` markers and indented detail lines.
- JSON pack format (`quietglass/flowlist@1`) for branching and sharing, with
  round-trip export. Unknown fields are ignored so newer packs still load.
- Dangling `goto` targets are reported on import and fall through in list order
  at runtime, so a broken pack cannot strand a run.
- Sample checklist installed on first run, demonstrating every feature.
- R1 ring support; the ring is recognised as a distinct input source.
- Swipe inversion setting for the reported hardware/simulator difference.
- Phone companion for writing, selecting, exporting and removing checklists.
- Redraw suppression: the display is written only when the view actually changed.
- Automatic page rebuild after a glasses reconnect.
- 79 unit tests covering parsing, run logic, branching, view composition,
  gesture decoding and dispatch.

### Fixed
- **Taps were ignored entirely.** Verified in the simulator: a tap arrives as
  `{"sysEvent":{"eventSource":1}}` with **no `eventType` field**, because
  proto3 omits fields holding their default value and `CLICK_EVENT` is `0`.
  The decoder treated the absence as an unknown gesture. An absent event type
  now resolves to CLICK, with a regression test using the exact payload.

### Known limitations
- No editing on the glasses (no keyboard); checklists are written on the phone.
- Voice commands are not implemented in 0.1.0. See README, "Roadmap".
- Real-hardware swipe direction has not yet been measured by Quietglass.
