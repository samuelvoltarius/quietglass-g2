# Changelog

## [0.4.6] — 2026-10-17

### Behoben (Hardware-Test)

- **Beenden-Dialog: die Ereignisse 4/5 direkt nach dem Aufruf sind der Dialog selbst.** Am Gerät gemessen: ca. 150 ms nach `shutDownPageContainer(1)` kommt FOREGROUND_ENTER (4) = der Dialog ist da; bei „Nein“ kommt FOREGROUND_EXIT (5) = der Dialog ist weg (die App war nie weg); bei „Ja“ kommt 5 und ca. 0,5 s später SYSTEM_EXIT (7). Die App liest 4/5 nach dem Aufruf jetzt so: bei 4 wird nichts gezeichnet, bei 5 steht die Seite sofort wieder da, ohne dass eine Geste nötig ist. Nichts wird pausiert, die Wiedergabe läuft durchgehend weiter.
- Ein 2× auf der Startseite fragt den Dialog danach wieder, direkt beim ersten Mal.

## [0.4.5] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.4.4] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.
- Systemende (Ereignis 6/7) stoppt jetzt ausdrücklich die Wiedergabe.
All notable changes to PodCaption are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.4.3] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

## [0.4.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Die Klicks aus dem Menü kommen auf der Brille nie an, und Halten öffnet bei einer Seite mit Menü nur das Menü. Die Seiten tragen kein `menuObject` mehr; der Menü-Code und der `menuItemClickEvent`-Handler bleiben für später.
- Halten öffnet wieder die Hilfe (Tippen schließt sie, 2× geht zurück). Fußzeile wieder `Tippen = Start · Halten = Hilfe · 2× = Ende`.
- Wischrichtung umkehren gibt es nur noch am Handy (Reiter Brille); auf der Brille hat sie keine Geste.

## [0.4.1] — 2026-10-15

### Behoben

- Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben; jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s), danach wird die Seite neu aufgebaut.

## [0.4.0] — 2026-10-14

### Changed (QIS v1.2)

- Side menu: Hold now opens the glasses' own side menu (`menuObject`, clicks via `menuItemClickEvent`, as in Babel and Quiet Hub) with `Hilfe` and the swipe direction (`Wischen: normal` / `Wischen: umgekehrt`; clicking it toggles `invertScroll` and rebuilds the page once so the label follows). Help is no longer the meaning of Hold; Hold on the page does nothing itself. The footer reads `Tippen = Pause · Halten = Menü · 2× = Ende`.
- Help page: still reached by tap/2× to close, but opened from the menu; the hold line now reads `Halten = Menü (Hilfe, Wischen)`.
- Errors: a failed feed download no longer shows its status code on the glasses (`Abruf fehlgeschlagen.`); the phone keeps the detail (`Abruf fehlgeschlagen (Code 503).`).
- 2× at the root with captions running keeps playing until the exit dialog is confirmed (unchanged, now covered by a test with the menu).
- Demo on first start: unchanged, the how-to captions start without a server or setup (the bridge is optional), so no hint line is needed (v1.2 #7).
- Phone: the swipe checkbox redraws the glasses menu; README and demo text say Hold = menu, 2× = exit.
- Tests: menu on the page and its labels (<= 32 bytes in all five languages), menu click opens the help, menu toggle rebuilds once, a hold alone changes nothing, no digits in the glasses error text.

## [0.3.0] — 2026-10-14

### Changed (QIS v1)

- Conforms to the Quietglass Interaction Standard (QIS v1, `docs/BEDIENSTANDARD.md`).
- Safety: no single gesture stops or deletes anything. A tap only plays or pauses (reversible, the main action), a swipe only moves the cursor through the captions, and a double tap is only back: help -> captions, and on the captions page the system exit dialog, which playback survives until you confirm. A running caption session is never stopped by the help or by 2× inside it.
- Header is `PODCAPTION · state` (was two spaces); the footer comes from a shared `footer()` helper in the order Tippen/Wischen/Halten/2× and ends in `2× = Ende` or `2× = zurück` (swipe part dropped first when the row is too wide). The tap names what it does now (`Tippen = Pause` while playing, `Tippen = Start` otherwise). Glossary: `2×`, no "Tap"/"Wisch"/"Doppeltipp" in German, Tap/Swipe/Hold/2× in English.
- Help page: hold opens it (`PODCAPTION · Hilfe`: the four gestures plus what the app needs); tap or 2× closes it.
- Swipe direction: new switch "Wischrichtung umkehren" on the phone (`invertScroll`, off by default, stored in the SDK store); the captions page honours it.
- Phone tabs in the fixed order Untertitel · Brille · Verbindung · Mehr: language and swipe direction under Brille, the bridge address under Verbindung (no longer hidden under "Erweitert"), about under Mehr.

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

