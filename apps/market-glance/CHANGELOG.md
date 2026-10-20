# Changelog

## [0.5.0] — 2026-10-20

### Neu: Quietglass-UI-Standard QUS v1 („keine Textwand“)

- **Brille: Startseite mit zwei großen Einträgen** (Übersicht, Positionen). Kopfzeile `Modus · ● live`, unten genau eine Hinweiszeile. Die Hilfe-Seite entfällt (Gesten stehen in der Hinweiszeile, Einrichtung am Handy).
- **Übersicht als Cockpit-Bild** (576×288, vier Kacheln wie Rain Lens/Status Glass): links der Verlauf des Portfolio-Werts über die Sitzung, rechts „MARKET GLANCE 14:05“, groß der Gesamtwert und der Gewinn, darunter Zellen (Positionen, Gewinn, Realisiert, Bester, Letzter, Quelle). Jede Position ist eine eigene Cockpit-Seite (Messring mit dem Kurs, Wert/Menge/Realisiert/Anbieter). Es werden nur geänderte Kacheln gesendet; die Uhr ändert nur die Kachel oben rechts.
- **Positionsliste** mit höchstens fünf Zeilen, Auswahl mit ●, Kurs und Gewinn nie abgeschnitten.
- **Handy: genau drei Tabs in einer Zeile** (Jetzt / Positionen / Einstellungen) im Rain-Lens-Look: Kicker `QUIETGLASS / FINANZEN`, Status-Pille, Statusbanner, Hero-Karte mit dem Portfolio-Wert, 2×2-Kennzahlen, ein Hauptknopf, Karten-Leiste der Positionen. Einstellungen als gruppierte Karten, Bridge-Karte eingeklappt sobald eingerichtet, Erststart-Checkliste in drei Schritten; ohne Bridge läuft die Demo.
- Alle Texte jetzt in einer Tabelle (`src/text.ts`) für de/en/fr/es/it.

### Unverändert (Hardware-getestet)

- Kein Seitenmenü (`SIDE_MENU = false`), Beenden-Dialog (2× auf der Startseite; während er offen sein kann, wird nichts gezeichnet und keine Kachel gesendet), zeitbegrenzte Aufrufe an die Brille, Wiederaufbau der ersten Seite nach „Nein“.

### Tests

- Reine Modelltests (Zellen, Überschrift, Startzeilen, Fußzeile), Kachel-Diff (unverändert = nichts gesendet), Beenden-Dialog-Tests, Vorschau-PNGs (`QG_PREVIEW=1 npx vitest run tests/preview.test.ts` → `store/preview-cockpit*.png`).

### QIS-Konformität

- Fußzeilen über den gemeinsamen `footer()`, `2× = zurück|Ende`; Wischen bewegt nur; Hold ohne Funktion (nur Anzeige).

## [0.4.6] — 2026-10-17

### Behoben (Hardware-Test)

- **Beenden-Dialog: die Ereignisse 4/5 direkt nach dem Aufruf sind der Dialog selbst.** Am Gerät gemessen: ca. 150 ms nach `shutDownPageContainer(1)` kommt FOREGROUND_ENTER (4) = der Dialog ist da; bei „Nein“ kommt FOREGROUND_EXIT (5) = der Dialog ist weg (die App war nie weg); bei „Ja“ kommt 5 und ca. 0,5 s später SYSTEM_EXIT (7). Die App liest 4/5 nach dem Aufruf jetzt so: bei 4 wird nichts gezeichnet, bei 5 steht die Seite sofort wieder da, ohne dass eine Geste nötig ist. Nichts wird pausiert, Abfragen laufen durchgehend weiter.
- Ein 2× auf der Startseite fragt den Dialog danach wieder, direkt beim ersten Mal.

## [0.4.5] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.4.4] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.
- Systemende (Ereignis 6/7) beendet jetzt das Abfragen ausdrücklich.
All notable changes to Market Glance are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.4.3] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

## [0.4.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Die Klicks im Menü kommen auf der Brille nie an, und Halten öffnet sonst das Menü statt die App zu erreichen (Schrittprotokoll 15.10.2026). Die Seiten tragen kein Menü mehr; der Menücode und der `menuItemClickEvent`-Handler bleiben, damit es wieder eingeschaltet werden kann.
- Hilfe ist wieder die letzte Listenzeile („Hilfe"): wischen bis dorthin, Tippen öffnet sie, Tippen oder 2× schließt sie. In der Liste lädt Tippen wie bisher neu; Halten bleibt ohne Funktion (die App zeigt nur an).
- Hilfetexte der Brille (alle fünf Sprachen) und Fußzeile auf der Hilfe-Zeile („Tippen = öffnen") beschreiben wieder die Gesten statt des Menüs.
- Tests: Seiten ohne `menuObject`, Hilfe per Tippen auf die Hilfe-Zeile, Halten tut nichts.

## [0.4.1] — 2026-10-15

### Behoben

- Die Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben. Jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s); danach wird die Seite neu aufgebaut.

## [0.4.0] — 2026-10-14

### Changed (QIS v1.2, `docs/BEDIENSTANDARD.md`)

- **Side menu on the glasses** (hold, then the system menu; SDK `menuObject` / `menuItemClickEvent`, as in Babel Glass and Quiet Hub): `Hilfe` / `Help` / `Aide` / `Ayuda` / `Aiuto`. The app has no settings of its own on the glasses, so that is the only entry. The page carries the menu on every build; a language change rebuilds the page once so the label follows.
- **Help is no longer the last list row.** The list holds only the positions; a tap always reloads (it used to open the help when the cursor sat on that row). The help page is opened from the menu; tap or 2× close it, 2× in the help still never leaves the app. The help text for Hold now says it opens the glasses menu.
- **Demo hint:** while the data is the demo, the blank row under the title reads `Demo · Verbindung am Handy einrichten` (also in en/fr/es/it); the app already started in demo before, now it says how to leave it. Live data shows no hint.
- Still display-only: nothing on the glasses stops, deletes, sends or answers.
- Tests: menu on the page and in the right language, hold alone opens nothing, menu opens the help, no help row in any list state, the demo hint (all five languages inside the row width).

QIS status: v1.2.

## [0.3.0] — 2026-10-14

### Changed (QIS v1)

- Conforms to the Quietglass Interaction Standard (QIS v1, `docs/BEDIENSTANDARD.md`).
- Safety: the app is display-only and has no gesture that stops, deletes, sends or answers. A tap reloads, a swipe only moves the selection, a double tap only goes back (help -> list) and leaves the app only from the list.
- Header is `MARKET GLANCE · state`; the footer comes from a shared `footer()` helper in the order Tippen/Wischen/Halten/2× and ends in `2× = Ende` or `2× = zurück` (swipe part dropped first when the row is too wide). Glossary: `2×`, no "Tap"/"Wisch" in German.
- Help page: `Hilfe` is the last list entry and lists the four gestures plus what the app needs.
- Swipe direction: new switch "Wischrichtung umkehren" on the phone (`invertScroll`, off by default, stored in the SDK store) is honoured by the list.
- Phone tabs in the fixed order Positionen · Brille · Verbindung · Mehr (language and swipe direction under Brille, bridge address under Verbindung).

## [0.2.1] — 2026-10-13

### Fixed

- Start language: the Even app's WebView reports English even on a German phone.
  An explicit language choice is now kept in the SDK store; without one, a German-speaking
  Even account country (AT/DE/CH/LI/LU) starts the app in German.

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

