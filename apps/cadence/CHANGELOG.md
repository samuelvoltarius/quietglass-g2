# Changelog

## [0.7.5] — 2026-10-21

Schrittprotokoll für die Store-Ablehnung „nach 2× und Nein verschwindet die Seite“ (nur private Builds mit `VITE_TRAFFIC_URL`; Store-Build: aus, keine URL im Bundle). Keine Verhaltensänderung.

- `src/diag/` (aus Klipper): jedes Even-Hub-Ereignis roh (Mikrofon/IMU-Strom gezählt), jeder Seiten-/Bildaufruf mit Dauer und Ergebnis.
- Marker: Beenden-Frage, Dialog gezeigt/geschlossen, Wiederherstellung (Start/Ende mit Zustand), Lebenszyklus, Seitenaufbau-Ergebnis, übersprungene Zeichnungen mit Grund, vom Wächter abgewiesene Kacheln (gezählt).

## [0.7.3] — 2026-10-21

Nichts mehr nur per Halten (Schrittprotokoll 21.10.2026: Halten am Bügel öffnet das Systemmenü und kommt nie in der App an, nur der optionale R1-Ring liefert es; Store-Prüfer haben keinen Ring).

### Brille

- **„Von vorn bei Takt 1“ ohne Halten:** Wer nach einer Pause wieder startet (Tippen), beginnt jetzt immer bei Takt 1. Die laufende Taktzählung bleibt beim Tempowechsel erhalten wie bisher.
- **Hinweiszeile ohne Halten:** läuft der Takt `Tippen = Pause · Wischen = Tempo · 2× = Ende`, steht er `Tippen = Start · Wischen = Tempo · 2× = Ende`. Der Fußzeilen-Helfer kennt keinen Halten-Teil mehr, Tests verbieten „Halten/Hold“ in jedem Brillen-Text.
- R1-Ring halten bleibt als optionales Extra (läuft der Takt: zurück auf Takt 1).
- Beenden-Dialog unverändert (Abschnitt 1a).

### Handy

- Bedienungstabelle: Tippen erklärt den Neustart bei Takt 1; die Halten-Zeile heißt jetzt „R1-Ring halten (optional)“.
- Store-Screenshot neu aus dem Cockpit-Renderer (der alte zeigte noch „Hold = help“).

## [0.7.0] — 2026-10-20

Nach dem Quietglass UI Standard (QUS v1) umgebaut: keine Textwand mehr.

### Brille

- **Hauptbild als Cockpit-Bild** (Muster Rain Lens, `src/screen/*` unverändert aus Rain Lens): das ganze Display ist ein Bild aus vier Kacheln. Links oben die Taktpunkte und das Pendel (über 120 Schläge pro Minute nur große Punkte), links unten die Taktnummer groß und die Übung. Rechts der Kopf `CADENCE  14:05`, **eine** Überschrift (`100 BPM`, darunter `LÄUFT` / `BEREIT` / `PAUSE` / `PAUSE?`) und sechs Werte in drei Spalten (TAKTART, MARKE, HEUTE, ZEIT, BESTE, EINHEITEN). Helligkeit statt Farbe (Text 15, Label 8, gedimmt 4).
- **Ein Schlag kostet eine Kachel:** nur geänderte Kacheln werden gesendet. Punkte und Pendel liegen in der Kachel oben links, die Taktnummer in der unten links, die Übungsminuten in der unten rechts (Minutenauflösung, damit sie nur einmal pro Minute wechselt). Derselbe Zustand sendet nichts; während der Beenden-Dialog offen sein kann, wird keine Kachel geschrieben.
- Eine Hinweiszeile unten (Tippen / Wischen / Halten / 2×) über den gemeinsamen Fußzeilen-Helfer. Pause bleibt armiert (Tippen, nochmal Tippen innerhalb von 4 s; Wischen, Halten, 2× oder Zeitablauf brechen ab).
- Entfallen: Textzeilen, Hilfeseite (Halten im Stand tut nichts mehr, die Bedienung steht am Handy), das Metronom-Symbol und die Zahlenbilder.
- Beibehalten: `SIDE_MENU = false`, die Beenden-Dialog-Logik unverändert (`src/exit.ts`, kein Zeichnen und keine Kachel, solange er offen sein kann), Zeitlimits für jeden Aufruf an die Brille, erste Seite mit Rebuild + Create, Taktberechnung aus der Uhr.

### Handy

- **Genau drei Tabs in einer Zeile: Jetzt / Verlauf / Einstellungen** im Rain-Look: Kicker `QUIETGLASS / ÜBEN`, Titel, Status-Pille, Statusbanner, Hero-Karte mit dem Tempo, 2×2-Kennzahlen (Heute, Einheiten, Takt, Bestes Tempo), ein Hauptknopf (Takt starten / pausieren) und eine waagrechte Kartenleiste mit den letzten Einheiten. *Verlauf* zeigt die Summe von heute, die letzten sieben Tage als Karten, die Übungen und den Export; „Tagebuch löschen“ und „Entfernen“ fragen nach. *Einstellungen* sind gruppierte Karten (Tempo, Was du übst, Brille, Sprache, Mehr); beim ersten Start steht eine Drei-Schritte-Checkliste oben und die Seite öffnet dort.
- Die Seite folgt dem Takt jede Sekunde, ohne Eingaben zu stören.

### Technik

- Reine Modellfunktionen mit Tests: `src/cockpit/model.ts` (Zellen, Überschrift, Punkte, Hinweis), `src/cockpit/compose.ts` (nur Layout). Neue Tests: Zellen, Überschrift, Hinweise, Kachel-Diff (Schlag, Takt, Minute, Uhr), Beenden-Dialog ohne Kachel-Sendungen, Handy-Modelle.
- Vorschau (nicht ausgeliefert): `QG_PREVIEW=1 npx vitest run tests/preview.test.ts` schreibt `store/preview-cockpit.png` und `store/preview-cockpit-ready.png`.

QIS: Fußzeilen über den gemeinsamen Helfer, `2× = zurück|Ende`.

## [0.6.6] — 2026-10-17

### Behoben (Hardware-Test)

- **Beenden-Dialog: die Systemereignisse 4 und 5 direkt nach dem Aufruf gelten als Anzeigen und Schließen des Dialogs.** Am Gerät gemessen: 4 (FOREGROUND_ENTER) kommt ca. 150 ms nach dem Aufruf, wenn der Dialog erscheint; bei „Nein“ folgt 5 (FOREGROUND_EXIT), der Dialog ist weg, die App war nie fort; bei „Ja“ folgt auf 5 nach ca. 0,5 s die 7 (SYSTEM_EXIT). Die App hielt 4/5 bisher für Vorder-/Hintergrund und pausierte den Takt.
- Nach „Nein“ kommt die Seite jetzt sofort ohne Geste zurück; nichts wird pausiert, der Takt und die Uhr laufen weiter.
- Ein 2× auf der Hauptseite, das ankommt, während die App als im Hintergrund gilt (ein echtes 5 ohne Dialog), holt die Seite zurück und fragt danach erneut (nach dem Wiederaufbau), statt den Dialog zu rufen, solange die Seite noch entsteht.

## [0.6.5] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.6.4] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.
- Beim Systemende (Ereignis 6/7) wird die Sitzung wie bisher beim Bestätigen beendet und protokolliert.
## [0.6.3] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

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
