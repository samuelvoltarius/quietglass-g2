# Changelog

## [0.7.1] — 2026-10-28

### Neu

- **Vorgegebene Server-Adresse für private Builds:** `VITE_XAVENTRA_URL` füllt ein leeres Adressfeld, am Handy muss dann nur noch der Token eingetragen werden. Eine gespeicherte Adresse hat immer Vorrang; öffentliche Builds bleiben ohne Vorgabe.

## [0.7.0] — 2026-10-20

### Neu: Quietglass-UI-Standard QUS v1 („keine Textwand“)

- **Brille: Startseite mit zwei großen Einträgen** (Fragen, Status). Kopfzeile `Xaventra · ● live`, unten genau eine Hinweiszeile. Die Fragen öffnen mit Tippen, die Karten-Ansicht trägt `Frage 1/2 · ● live` und zeigt, was die Karte nach außen bewirkt, direkt vor dem Titel. 2× geht eine Ebene zurück; auf der Startseite fragt 2× den Beenden-Dialog.
- **Status als Cockpit-Bild** (576×288, vier Kacheln wie Rain Lens/Status Glass): links ein Ring mit einem Bogen je offener Frage (Mitte = Anzahl), rechts „XAVENTRA 14:05“, groß `2 FRAGEN` / `ARBEITET` / `BEREIT` / `OFFLINE` / `FEHLER`, darunter Zellen Fragen, Server, Stand, Wirkung; links unten die Statuszeile von Xaventra. Es werden nur geänderte Kacheln gesendet; die Uhr ändert nur die Kachel oben rechts.
- **Keine Hilfe-Seite mehr** (die Gesten stehen in der Hinweiszeile, die Einrichtung am Handy); das Maskottchen in der Kopfzeile entfällt. Antworten bleiben wie bisher: Tippen wählt, nochmal tippen innerhalb von 4 s sendet, Wischen sendet nie, gesprochenes Ja/Nein sendet nie von selbst, erkannter Text erscheint zuerst (Tippen sendet, 2× verwirft).
- **Erststart ohne Server = Demo:** Beispieldaten laufen, die Startseite sagt in einer Zeile „Demo · Verbindung am Handy einrichten“.
- **Handy: genau drei Tabs in einer Zeile** (Jetzt / Fragen / Einstellungen) im Rain-Lens-Look: Kicker `QUIETGLASS / ASSISTENT`, Status-Pille, Statusbanner, Hero-Karte mit den offenen Fragen, 2×2-Kennzahlen (Fragen, Server, Stand, nächste Wirkung), ein Hauptknopf, Karten-Leiste der offenen Fragen. Einstellungen als gruppierte Karten (Verbindung eingeklappt sobald eingerichtet), Erststart-Checkliste in drei Schritten.

### Unverändert (Hardware-getestet)

- Kein Seitenmenü (`SIDE_MENU = false`), Beenden-Dialog (während er offen sein kann, wird nichts gezeichnet und keine Kachel gesendet), zeitbegrenzte Aufrufe an die Brille, Wiederaufbau der ersten Seite nach „Nein“, Mikrofon/Live-Text/Antwort-Ablauf.

### Tests

- Reine Modelltests (Zellen, Überschrift, Startzeilen, Fußzeile), Kachel-Diff (unverändert = nichts gesendet), Beenden-Dialog-Tests, Vorschau-PNGs (`QG_PREVIEW=1 npx vitest run tests/preview.test.ts` → `store/preview-cockpit*.png`).

### QIS-Konformität

- Fußzeilen über den gemeinsamen `footer()` (zu breit: erst Wischen, dann Halten weg, 2× nie); Antworten nie per Wischen; keine Fehlercodes auf der Brille.

## [0.6.6] — 2026-10-17

### Behoben (Hardware-Protokoll)

- **Beenden-Dialog: 4/5 direkt nach dem Aufruf sind Anzeigen/Schließen des Dialogs, nicht „App im Vordergrund/Hintergrund“.** Am Gerät gemessen: nach `shutDownPageContainer(1)` kommt Ereignis 4 (FOREGROUND_ENTER), wenn der Dialog erscheint, und 5 (FOREGROUND_EXIT), wenn er nach „Nein“ wieder weg ist; bei „Ja“ folgt erst 5, rund 0,5 s später 7. Die App liest das jetzt so: bei 4 bleibt sie still (nichts wird über den Dialog gezeichnet), bei 5 kommt die Seite sofort und ohne Geste wie beim ersten Start zurück. Dabei wird nichts pausiert: Mikrofon-Zustand, Feed-Abfrage und Anzeige laufen weiter. Audio-Ereignisse und Ereignis 8 ändern den Dialog-Zustand nicht.
- Ein 2× auf der Startseite, das ankommt, während die App sich pausiert glaubt, holt die App zurück und fragt danach erneut (es wartet auf den Wiederaufbau der Seite und wird nicht mehr verschluckt).

## [0.6.5] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.6.4] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.

## [0.6.3] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

## [0.6.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): seine Klicks kommen auf der Brille nie an, und Halten öffnet sonst das Menü statt die App zu erreichen (auch das Sprechen per Halten war damit blockiert). Die Seiten tragen kein `menuObject` mehr; der Menücode und der `menuItemClickEvent`-Handler bleiben, damit es wieder eingeschaltet werden kann.
- Halten spricht wieder (Loslassen zeigt das Erkannte, Tippen sendet, 2× verwirft). Die Hilfe ist wieder die letzte Zeile der Liste (Ja / Nein / Hilfe): Wischen bewegt den Cursor, Tippen öffnet die Hilfe, Tippen oder 2× schließt sie; ohne offene Fragen öffnet Tippen die Hilfe.

## [0.6.1] — 2026-10-15

### Behoben

- Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben; jetzt hat jeder Aufruf an die Brille ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s), danach gilt der Aufruf als fehlgeschlagen und die Seite wird beim nächsten Zeichnen neu aufgebaut.

## [0.6.0] — 2026-10-14

### Geändert — QIS v1.2 (docs/BEDIENSTANDARD.md, Entscheidungen nach dem Audit vom 2026-10-14)

- **Sprache beantwortet nie mehr selbst** (QIS v1.2 #4): Meldet Xaventra auf eine Aufnahme `answered_ja`/`answered_nein` (oder `needs_confirm`), wählt die Brille nur diese Antwort in der Liste und schaltet sie scharf (`Gehört: Ja. …`, Fußzeile `Nochmal tippen = Ja senden · Wischen/2× = abbrechen`); erst das bestätigende Tippen innerhalb von 4 s sendet sie über `POST /hud/answer`. Wischen, 2× oder 4 s ohne Eingabe brechen ab. Hinweis: Das gilt end-to-end nur, wenn der Xaventra-Server ein gesprochenes Ja/Nein ebenfalls nur meldet und nicht selbst bucht; ein schon gebuchtes Ja führt beim Tippen zu „Schon beantwortet“ und die Karte verschwindet.
- **Freier Text erst zeigen, dann senden:** Mit Live-Spracherkennung steht nach dem Loslassen das Erkannte auf der Brille (`XAVENTRA · senden?`, `Tippen = senden · 2× = verwerfen`). Tippen schickt es an `/hud/ask` (bzw. das WAV, wenn der Server `/hud/ask` nicht kennt), 2× verwirft es. Ein bloßes Ja/Nein geht gar nicht an den Server, sondern wird wie oben gewählt und scharfgeschaltet. Ohne Live-Text geht die Aufnahme wie bisher beim Loslassen.
- **Hilfe im Seitenmenü** (QIS v1.2 #1): Die Seite meldet ein Seitenmenü mit `Hilfe` an (`menuObject`, Klicks über `menuItemClickEvent`); „Hilfe“ ist kein Listeneintrag mehr. Die Liste hat nur noch Ja / Nein, Wischen läuft durch Ja/Nein aller Karten.
- **Fußzeilen nur noch über `footer()`**: keine leeren und keine handgebauten Zeilen mehr (Aufnahme `Loslassen = fertig · 2× = abbrechen`, Senden `2× = abbrechen`, ohne Einrichtung/offline `2× = Ende`, scharf über `armedFooter()`). Rückmeldungen („Abgebrochen.“, „Nicht eindeutig …“) stehen jetzt im Text, nicht mehr anstelle der Fußzeile.
- **Keine HTTP-Codes auf der Brille** (QIS v1.2 #8): „Token abgelehnt“, „Server meldet einen Fehler“; der Code steht nur noch am Handy in der Verbindungszeile (`… (HTTP 401)`).
- Handy: „Doppeltippen“ → „2×“ (QIS v1.2 #9), Bedienungstexte und neue Zeile „Seitenmenü“. Store-Text (`store/listing.json`) und README beschreiben die echte Bedienung (vorher: „Tippen = Ja, Doppeltippen = Nein, Wischen = nächste Karte“).
- `package-lock.json` trug noch 0.4.0; jetzt wie `package.json`/`app.json` 0.6.0.

## [0.5.0] — 2026-10-14

### Geändert — Bedienstandard QIS v1 (docs/BEDIENSTANDARD.md)

- **Wischen beantwortet nie mehr etwas.** Die Antwort ist eine Liste `Ja / Nein / Hilfe`: Wischen bewegt nur den Cursor, Tippen scharfschalten (`Nochmal tippen = Ja|Nein senden · Wischen/2× = abbrechen`), ein zweites einzelnes Tippen innerhalb von 4 s sendet. Wischen, Doppeltippen oder 4 s ohne Eingabe brechen ab (Doppeltippen beendet die App erst, wenn nichts scharf ist). Gilt jetzt für Ja und Nein auf jeder Karte, nicht nur für Karten mit Wirkung nach außen. Protokoll zum Server unverändert.
- Kopfzeile `XAVENTRA · Zustand`, Fußzeile in der Reihenfolge Tippen → Wischen → Halten → 2× mit `2× = Ende`/`2× = zurück` (gemeinsamer `footer()`), Englisch Tap/Swipe/Hold/2×. Test: alle Zeilen in Deutsch und Englisch innerhalb der Zeilenbreite.
- Neu: Hilfeseite („Hilfe“ als letzter Listeneintrag) mit den Gesten.
- Handy-Tabs in der Standardreihenfolge: Xaventra · Brille · Verbindung · Mehr (Sprache und Datenschutz unter „Mehr“). „Wischrichtung umkehren“ (Brille) gilt weiter für die Liste.

## [0.4.1] — 2026-10-13

### Geändert

- Handy-Seite in Tabs statt einer langen Spalte: Xaventra · Server · Brille (Tab-Leiste unten, gewählter Tab bleibt), Status-Chip mit dem Verbindungszustand oben. Sprachwahl und Datenschutz stehen jetzt unter „Server“, „Scroll umkehren“ unter „Brille“.

## [0.4.0] — 2026-10-13

### Neu — Live-Text beim Sprechen

- **Was du sagst, steht sofort auf der Brille.** Private Builds mit `VITE_LIVE_STT_URL` streamen das Mikrofon während des Haltens an die eigene Live-Spracherkennung; die neuesten Wörter bleiben sichtbar, die Kopfzeile zeigt die Laufzeit (m:ss), unten „Loslassen = senden · 2× = abbrechen“. Neuzeichnen höchstens alle 300 ms und nur bei geändertem Text.
- **Loslassen schickt den Live-Text** an `POST /hud/ask { text, cardId }`. Kennt der Server das noch nicht (404/405 oder abgelehnter Preflight), geht wie bisher das WAV an `/hud/voice`, und die App fragt in dieser Sitzung nicht noch einmal. Antwortet die Spracherkennung nicht binnen 3 s oder bricht ab, wird ebenfalls das WAV gesendet – es geht nichts verloren.
- Während des Sendens bleibt das Gesagte stehen, darunter die Statuszeile von Xaventra als Fortschritt.

### Geändert

- Höchstdauer einer Aufnahme 2 Minuten statt 15 s (Schutz gegen ein verlorenes Loslassen). Hinweis: Xaventras `/hud/voice` nimmt nur bis 20 s an; „Aufnahme zu lang für den Server“ heißt, der Server braucht `/hud/ask`.

## [0.3.0] — 2026-10-13

### Changed — answering "no"

- **A double tap no longer answers "Nein".** It is the exit again, on every screen with cards too (Even rule: the double tap on the root leaves the app), and a stray double tap can no longer refuse a request. While speaking it still cancels the recording, and it closes a voice reply.
- "Nein" now takes two deliberate gestures: **swipe to "Nein", then tap**. Swiping walks Ja → Nein of each card and then on to the next card; the card shows `● Ja   ○ Nein   (Halten = sprechen)`, the footer says what a tap sends ("Tippen = Nein · Wischen = weiter · 2× = Ende"). A "Nein" choice belongs to its card and is dropped when that card goes away, so it can never land on another card. "Ja" on a card that acts outside still needs the second tap within 4 s.

### Fixed

- Gestures are wired before the first page and the feed poll, so a slow page creation can no longer swallow the double tap.
- A reconnect during a running draw could be undone by that draw; the rebuild request now survives it.
- Leaving through the system (another app, the system menu) cancels a recording, stops the long poll and drawing; coming back rebuilds the page and polls again. A system exit or crash stops everything.

## [0.2.1] — 2026-10-13

### Fixed

- Page set-up on the glasses: the first page of a session goes out as one `rebuildPageContainer` followed by exactly one `createStartUpPageContainer`; every later page is a rebuild, never a second create. (Taps and exit work on real glasses only with this order.)

## [0.2.0] — 2026-10-13

### Added

- A face in the top-right corner of the header (64 x 30 image) that shows Xaventra's mood: it blinks when all is quiet, writes in a notebook while Xaventra works on a status, opens its eyes wide while a card waits for your yes or no, listens while you speak, shows a cross when the server answers with a problem and sleeps when it cannot be reached. The header text now ends 64 px before the right edge.
- The face and the clock redraw twice a second; pictures are sent to the glasses only when they change, text containers only when their text changed.
- `?demo=1&scene=idle|working|error|offline` shows the other moods in the simulator.

## [0.1.4] — 2026-10-13

### Changed

- German gesture hints no longer mix in English ("Tap Ja · 2x Tap Nein" is now "Tippen = Ja · 2× = Nein · Halten = sprechen"); English hints follow the same pattern.
- Glasses rows use the full display width (56 instead of 46 characters); card title and text that do not fit end in an ellipsis instead of being cut silently.

## [0.1.3] — 2026-10-13

### Fixed

- Start language: an explicit choice is kept in the Even SDK store (the WebView's localStorage may not survive a relaunch); without one, a German-speaking Even account country (AT/DE/CH/LI/LU) starts the app in German, even when the WebView reports English.

## [0.1.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

All notable changes to Xaventra HUD are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-10-08

First Quietglass release. The HUD started as a minimal app inside the Xaventra
repository (`apps/even-g2`); it now lives here and is built to Quietglass
conventions.

### Added
- Status feed and question cards from the Xaventra Even G2 endpoint (long poll).
- Tap = yes, double tap = no, swipe = next card; cards that act outside need a
  second tap within 4 seconds.
- Voice control: hold to speak (at most 15 s, shown as ● MIC), release sends the
  recording to `POST /hud/voice` on your own Xaventra server. Yes/no answers the
  open card, anything else goes to the agent and the reply is shown on the
  glasses. A spoken yes never confirms an action that acts outside.
- Double tap with no open question asks the system to quit; cancelling keeps
  the app running.
- German and English, following the phone language, with a picker on the phone
  page. Glasses text stays within seven rows of 46 characters.
- Phone page: endpoint address and token (write-only, never shown), https and
  mixed-content hints, controls, connection status.
- `?demo=1` sample mode.
- Tests for the feed, answers, the confirming tap, voice (mocked endpoint and
  bridge), exit, errors, timeouts and translations.

### Changed
- Requires Xaventra with `POST /hud/voice` for voice; everything else works with
  the original endpoint.
- SDK 0.0.16, Vite 8, Vitest 5, display layout and gestures shared with the
  other Quietglass apps.
