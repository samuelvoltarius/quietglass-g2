# Changelog

## [0.6.3] — 2026-10-21

### Geändert (Halten kommt am Bügel nie an)

- **Zusatzinfo steht jetzt direkt unter dem Schritt**, ganz ohne Geste. Bisher musste man halten – auf der echten Brille kommt Halten aber nur vom optionalen R1-Ring an; am Bügel öffnet es das Systemmenü (Schrittprotokoll 21.10.2026). Store-Prüfer haben keinen Ring. Die Vorschau auf den nächsten Schritt folgt darunter, wenn Platz ist.
- **Brille bietet „Halten“ nirgends mehr an**: keine Fußzeile, keine Hilfezeile. Die Hilfe-Zeile `Halten = …` heißt jetzt `Zusatzinfo steht direkt unter dem Schritt`.
- Fußzeile im Ablauf nennt Wischen nur, wo es etwas tut: `Wischen = zurück` ab dem zweiten Schritt, `auslassen` bei optionalen Schritten, `zurück/auslassen` bei beidem; am ersten normalen Schritt `0:00 · Tippen = erledigt · 2× = zurück`.
- Die Hilfe auf der Brille bleibt ein Ring-Extra (Halten am R1) und wiederholt nur die Gesten-Tabelle am Handy. Handy-Tabelle: `Halten (nur R1-Ring)` = optional Hilfe.
- Store-Text ohne „Hold = menu“ / „halten = Zusatzinfo“.
- Beenden-Dialog unverändert.

## [0.6.0] — 2026-10-20

### Geändert (Quietglass UI-Standard QUS v1, „keine Textwand“)

- **Brille: neue Startseite mit drei großen Einträgen** – `Ablauf · 3/7`, `Übersicht · 5 offen`, `Aufgaben · 7`. Wischen wählt (●), Tippen öffnet, 2× beendet die App (Beenden-Dialog nur noch hier). Ohne Liste steht dort der Hinweis, am Handy eine anzulegen.
- **Übersicht als Cockpit-Bild** (Rain-Lens-Muster, ganzes Display als vier 288×144-Kacheln): rechts klein `FLOWLIST  14:05`, darunter **eine** große Aussage (`5 OFFEN` bzw. `ALLES ERLEDIGT`), dazu sechs Zellen (Schritt, Erledigt, Kritisch, Optional, Ausgelassen, Nächste); links ein Fortschrittsring (ein Bogen je Schritt, in der Mitte `erledigt/gesamt`) und der Listenname. Nur geänderte Kacheln werden gesendet; die Uhr ändert nur die Kachel oben rechts, ein unveränderter Stand sendet nichts. Tippen = Ablauf, 2× = zurück.
- **Aufgabenliste**: höchstens fünf Zeilen mit `●` am Cursor, `→` beim aktuellen und `—` bei erledigten Schritten; Wischen bewegt nur den Punkt, ändert nichts am Ablauf.
- **Der Ablauf hängt jetzt unter der Startseite**: 2× geht eine Ebene zurück (Fußzeile `2× = zurück`), erst auf der Startseite fragt 2× den Beenden-Dialog. Der Ablauf selbst (Schritt als großes Bild, Fortschrittsbalken, Tippen = erledigt, wichtige Schritte zweimal, Zurück/Auslassen vormerken) ist unverändert.
- **Wo man war, bleibt gespeichert**: nach gesperrtem Handy kommt die App auf derselben Seite (Ablauf, Übersicht, Aufgaben) wieder.
- Header der Listenseiten `Modus · ● live`, jeweils **eine** Fußzeile.
- **Handy: genau drei Tabs in einer Zeile** – Jetzt / Aufgaben / Einstellungen – im Rain-Lens-Look: Kicker `QUIETGLASS / AUFGABEN`, Titel, Status-Pille mit der laufenden Liste, Statusbanner (der aktuelle Schritt), Hero-Karte mit **einem** großen Wert (offene Schritte), 2×2-Kennzahlen (Schritt, Erledigt, Wichtig, Ausgelassen), horizontale Karten-Leiste mit den nächsten Schritten, **ein** großer Knopf „Ablauf neu starten“ (fragt erst nach). Einstellungen in gruppierten Karten (Anzeige, Brille, Sprache, Über FlowList), Bedienung und Über eingeklappt; Erststart mit Drei-Schritte-Checkliste, bis dahin läuft die Beispielliste. Entfernen einer Liste fragt jetzt nach (zweites Tippen).
- Texte am Handy und auf der Brille nach Glossar (`2×`, `Tippen`, `Wischen`, `Halten`).

### Unverändert (bewusst)

- `SIDE_MENU = false`, Beenden-Dialog (`src/exit.ts`, Ereignisse 4/5, Hintergrund/Zurückkommen, nichts zeichnen oder Kacheln senden, solange gefragt ist), `bounded()`-Zeitlimits, erste Seite = Rebuild + Create.

### Intern

- Neu: `src/screen/*` (byte-identisch aus Rain Lens), `src/cockpit/{model,compose}.ts`, `src/glasses/screens.ts`, `src/ui-state.ts`; `render.ts` baut Text-, Cockpit- und Ablaufseite; ein Seitenwechsel ist ein Rebuild, die Bild-Bahnen (Schritt, Balken) senden nur, solange die Ablaufseite steht.
- Tests: reine Modelltests (Zellen, Überschrift, Startzeilen, Fußzeilen, Aufgabenliste), Kachel-Diff (unverändert → nichts senden, Uhr → nur oben rechts), Wächter für Kachel-Schreibzugriffe, Seitenwechsel und Beenden-Dialog im Hauptprogramm; Vorschau-PNGs mit `QG_PREVIEW=1 npx vitest run tests/preview.test.ts` nach `store/preview-cockpit.png` und `store/preview-cockpit-done.png`.
- QIS-Konformität: Fußzeilen über den gemeinsamen Helfer, `2× = zurück|Ende` überall.

## [0.5.6] — 2026-10-17

### Behoben (Hardware-Test, Schrittprotokoll)

- **Die Ereignisse 4/5 direkt nach dem Beenden-Aufruf werden als Anzeigen/Schließen des Dialogs gelesen**, nicht als „App kommt/geht“: 4 = der Dialog ist da (es wird nichts gezeichnet), 5 = der Dialog ist nach „Nein“ weg. Die App war nie weg: nichts wird angehalten, die Uhr läuft weiter.
- **Nach „Nein“ kommt die Seite sofort zurück, ohne Geste.** Das erste 2× danach öffnet den Dialog wieder.
- **Ein 2× auf der Startseite, während die App im Hintergrund ist** (echtes Ereignis 5 ohne Dialog), kommt zurück, baut die Seite wieder auf, startet die Uhr und fragt dann den Dialog. Dasselbe gilt für jede andere Eingabe in diesem Zustand.

## [0.5.5] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.5.4] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.

## [0.5.3] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

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
