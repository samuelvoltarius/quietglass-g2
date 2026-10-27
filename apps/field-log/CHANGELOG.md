# Changelog

## [0.10.0] — 2026-10-25

### Neu: Checkliste Raum für Raum (Idee aus der Community)

**Handy**
- **Checkliste pro Rundgang** im Tab *Notizen*: als Text bearbeiten, eine Zeile pro Punkt. `# Küche` beginnt einen Raum, `!` am Zeilenanfang = kritisch, `[foto]` (auch `[photo]` oder 📷) irgendwo in der Zeile = Foto nötig. Leere Zeilen und Listenzeichen (`-`, `*`, `- [ ]`) werden ignoriert, Punkte vor dem ersten Raum landen in „Allgemein“. Leer speichern entfernt die Checkliste; die Häkchen bleiben gespeichert.
- **Zwei Vorlagen zum Kopieren und Anpassen:** *Wohnungsübergabe* (Flur, Küche, Bad, Wohnzimmer, Schlafzimmer, Zähler und Schlüssel) und *Auto-Rückgabe* (Außen, Innen, Zubehör), auf Deutsch und Englisch.
- Übersicht je Raum mit Fortschritt (`Küche 5/7 · 1 📷 fehlt · 1 ! offen`), Stand jedes Punkts und bei Foto-Punkten ein Kamera-Knopf: das Foto hängt dann genau an diesem Punkt.
- **Warnung vor dem Export:** fehlen Pflichtfotos oder sind kritische Punkte offen, steht vor Markdown/CSV z. B. „Vor dem Export: 3 Räume ohne Pflichtfoto, 1 kritischer Punkt offen“, darunter die Räume und Punkte, mit *Trotzdem exportieren* / *Zurück*.

**Brille**
- Hat der Rundgang eine Checkliste, steht oben auf der Startseite *Checkliste · 12/30* (dafür entfällt dort die Zeile *Art*; weiter höchstens drei Einträge). Tippen öffnet die Raumübersicht (`● Küche 5/7 · 1 [Foto] fehlt`), Tippen auf einen Raum springt zum ersten offenen Punkt.
- Ein Punkt zeigt Raum und Position (`Küche · 2/7 · kritisch`), den Text, den Stand und bei Foto-Punkten `[Foto] am Handy`, darunter *OK* und *Mangel*. **Tippen auf OK** hakt ab und geht zum nächsten Punkt; am Raumende zurück zur Übersicht. **Wischen** bewegt nur: OK → Mangel → nächster Punkt (und zurück). **Tippen auf Mangel** öffnet die Schnellnotizen; die gewählte Notiz wird als „Punkt: Notiz“ im Raum des Punkts abgelegt (kritisch = Wichtig, sonst Mangel). 2× = zurück.
- **Kritische Punkte brauchen ein zweites Tippen innerhalb von 4 s** (`● SICHER? OK`, Fußzeile „Nochmal tippen = OK bestätigen · Wischen/2× = abbrechen“). Wischen oder 2× bricht nur ab.
- Foto-Punkte zählen als offen, bis am Handy ein Foto daran hängt (auch ein Foto am Mangel-Eintrag dieses Punkts zählt). Auf der Brille steht `[Foto]` statt 📷, weil die Brillenschrift keine Emoji zeichnet.
- Unverändert: kein Halten, kein Seitenmenü, Beenden-Dialog, alle Rundgänge ohne Checkliste.

**Bericht**
- Mit Checkliste ist der Markdown-Bericht nach Räumen gegliedert: `## Küche (5/7)`, je Punkt `OK` / **MANGEL** / **OFFEN** mit „kritisch“, „Foto da“ oder „Pflichtfoto fehlt“, darunter die Mängel und Fotos des Punkts; alle übrigen Notizen folgen unter „Weitere Notizen“. Die CSV bleibt eine Zeile pro Notiz (Raum als Abschnitt). Rundgänge ohne Checkliste exportieren wie bisher.

### Technik
- `src/checklist/checklist.ts` (Syntax, Vorlagen, Fortschritt, Export-Warnung, Speicher-Prüfung) und `src/checklist/walk.ts` (Cursor, zweites Tippen über `confirmStep`), beide rein und getestet. Gespeichert wird mit dem Rundgang (`checklist`, `checks`, an Einträgen `itemId`), kein Server nötig.
- Tests: Syntax, Fortschritt, Warnung, zweites Tippen, Export-Gliederung, Speichern, Bildschirmbreite, Brille (Rundgang, Abbrechen, Mangel, Foto vom Handy) und Handy (Vorlage, Speichern, Warnung).

## [0.9.0] — 2026-10-20

### Neu: Quietglass-Bedienstandard QUS v1 („keine Textwand“)

**Brille**
- **Startseite mit höchstens drei großen Einträgen:** *Aufnehmen* (ohne Sprachserver: *Schnellnotiz*), *Notizen · n* (nur wenn es welche gibt) und *Art · Notiz*. Wischen wählt (Punkt ●), Tippen öffnet. Kopfzeile `FIELDLOG · ● live` (ohne Server `lokal`), unten eine Hinweiszeile.
- **Bereit, Aufnahme und Erkennen sind jetzt ein Bild (Cockpit)** wie bei Rain Lens und Status Glass: rechts klein `FIELDLOG  HH:MM`, eine große Überschrift (`BEREIT` · `AUFNAHME 0:42` · `WIRD ERKANNT`, bei einem Fehler `MIKRO GESPERRT` · `NICHTS VERSTANDEN` · `SERVER FEHLER` · `KEIN FOTO`), vier Zellen (*Heute* = Notizen heute, *Letzte*, *Sync*, *Länge*); links beim Aufnehmen der Pegelverlauf des Mikrofons, sonst ein Ring aus den Notizen des Rundgangs (eine Strecke je Notiz, nach Art). Es werden nur die Kacheln gesendet, deren Bild sich geändert hat; solange der Beenden-Dialog offen sein kann, wird keine Kachel gesendet.
- **Notizen:** Liste mit höchstens fünf Zeilen (neueste zuerst, Punkt ● an der Auswahl); ein Tipp öffnet die Notiz als **Leseansicht** mit Kontextzeile (`Notiz 2/7 · 14:02 · Mangel`), lange Notizen blättern mit Wischen, Tippen springt zur nächsten, 2× zurück.
- **Schnellnotizen und „Behalten?“** sind Listen mit Punkt ● und der Art in der Kopfzeile; „Verwerfen“ bleibt zweistufig (Tippen, nochmal Tippen innerhalb von 4 s).
- **Entfernt:** die Hilfe-Seite und alles, was am Halten hing (Foto per Halten, Hilfe per Halten, Art per Wischen auf der Ruheseite). Halten erreicht die App an der Brille nie. Fotos gibt es am Handy und unter „Behalten + Foto“; die Art des nächsten Eintrags ist die Zeile *Art* der Startseite (Tippen setzt die nächste).
- Unverändert: kein Seitenmenü (`SIDE_MENU = false`), Beenden-Dialog (nur auf der Startseite; Aufnahme und „Behalten?“ ignorieren 2×; während er offen sein kann, wird nichts gezeichnet), begrenzte Aufrufe (`bounded()`), erste Seite per Rebuild + Create, Mikrofon- und Spracherkennungs-Logik.

**Handy**
- **Genau drei Tabs in einer Zeile: Jetzt · Notizen · Einstellungen**, im Look von Status Glass: Kicker `QUIETGLASS / NOTIZEN`, Titel, Status-Pille, Statusbanner, Heldenkarte mit einem großen Wert (Notizen heute), 2×2-Kennzahlen (Wichtig · Mängel · Notizen · Fotos), ein primärer Knopf, waagrechte Kartenleiste der letzten Notizen.
- *Notizen*: Notiz eintippen, Einträge des Rundgangs (Löschen mit Bestätigung: erst „Nochmal tippen“), Export und alle Rundgänge eingeklappt.
- *Einstellungen*: gruppierte Karten (Sprache, Sprachserver, Schnellnotizen, Bedienung, Daten); die Server-Karte ist eingeklappt, sobald ein Sprachserver eingerichtet ist; beim ersten Start steht oben eine Checkliste mit drei Schritten, und ohne Server läuft alles mit Schnellnotizen.

### Technik
- Renderer-Bausteine `src/screen/*` aus Rain Lens (byte-gleich), `src/cockpit/{model,compose}.ts` (reines Modell, getrennt vom Zeichnen), `src/glasses/render.ts` mit Text- und Cockpit-Seite.
- Tests: Modell (Überschrift, Zellen, Grafik, Hinweiszeile), Startzeilen, Listen und Leseansicht, Kachel-Diff (unveränderter Zustand sendet nichts, die Uhr nur die Kachel oben rechts), Footer, Beenden-Dialog, Handy. Vorschaubilder: `QG_PREVIEW=1 npx vitest run tests/preview.test.ts` schreibt `store/preview-cockpit.png` (Aufnahme) und `store/preview-cockpit-idle.png` (Bereit).

## [0.8.7] — 2026-10-17

### Behoben (Hardware-Test, Schrittprotokoll)

- **Die Ereignisse 4/5 direkt nach dem Beenden-Aufruf werden als Anzeigen/Schließen des Dialogs gelesen**, nicht als „App kommt/geht“: 4 = der Dialog ist da (es wird nichts gezeichnet), 5 = der Dialog ist nach „Nein“ weg. Die App war nie weg: nichts wird pausiert, Uhr und Streams laufen weiter.
- **Nach „Nein“ kommt die Seite sofort zurück, ohne Geste** (auch das Mikrofon einer angehaltenen Diktat-Aufnahme geht wieder an). Das erste 2× danach öffnet den Dialog wieder.
- **Ein 2× auf der Startseite, während die App sich im Hintergrund glaubt** (echtes Ereignis 5 ohne Dialog), wird nicht mehr verschluckt: die App kommt zurück, baut die Seite auf und fragt dann den Dialog. Dasselbe gilt für jede andere Eingabe (Tippen, Wischen, Menü) in diesem Zustand.

## [0.8.6] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.8.5] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.
- Ein vor dem Dialog pausiertes Mikrofon geht erst beim nächsten Tippen/Wischen wieder an (nicht schon, wenn der Dialog erscheint).
## [0.8.4] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

## [0.8.3] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Die Klicks im Menü kommen auf der Brille nie an, und Halten öffnet sonst das Menü statt die App zu erreichen (Schrittprotokoll 15.10.2026). Die Seiten tragen kein Menü mehr; Menücode und `menuItemClickEvent`-Handler bleiben, damit es wieder eingeschaltet werden kann.
- Wischen im Ruhebild wählt wieder die Art des nächsten Eintrags (Notiz · Mangel · Wichtig) und als letzte Station „Hilfe“; Tippen auf „Hilfe“ öffnet sie, 2× schließt sie.
- Halten im Ruhebild macht wieder ein Foto; ohne Rundgang öffnet Halten die Hilfe. Bei „Behalten?“ springt Halten nur auf „Behalten + Foto“ (nichts wird dabei abgelegt, Tippen bestätigt, der Auslöser der Kamera ist die letzte Bestätigung).
- Hilfetexte der Brille (de/en), Fußzeilen und Hinweise am Handy beschreiben wieder die Gesten statt des Menüs.
- Tests: Seiten ohne `menuObject`, Wischen wählt die Art, Halten macht ein Foto bzw. öffnet die Hilfe ohne Rundgang, Halten bei „Behalten?“ springt auf „Behalten + Foto“.

## [0.8.1] — 2026-10-15

### Behoben

- Die Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben. Jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s); danach wird die Seite neu aufgebaut.

## [0.8.0] — 2026-10-14

Bedienung nach QIS v1.2 (Audit 14.10.2026).

### Geändert (QIS v1.2)

- **Seitenmenü (Halten):** Hilfe, Art des nächsten Eintrags (Notiz · Mangel · WICHTIG) und Foto stehen im Menü der Brille (`menuObject`, Klicks über `menuItemClickEvent`; Vorlage Babel Glass). Die Hilfe ist keine Zeile der Art-Auswahl mehr und nicht mehr „Halten ohne Rundgang“.
- **Wischen ändert die Art nicht mehr.** Auf dem Ruhebild bewegt Wischen nichts; die Art des nächsten Eintrags wird im Menü ausdrücklich gewählt (Klick). Die Zeile heißt „Nächster Eintrag: … · Art im Menü“.
- **Halten legt keinen Eintrag mehr ab und öffnet die Kamera nicht mehr.** Unter „Behalten?“ gibt es die ausdrückliche Wahlzeile „Behalten + Foto“ (Wischen bewegt, Tippen führt aus, der Auslöser der Handy-Kamera bestätigt das Foto). Das Menü-„Foto“ unter „Behalten?“ springt nur auf diese Zeile. Während der Aufnahme tut das Menü nichts.
- **Wortlaut:** „Tippen = Stopp“ heißt jetzt „Tippen = fertig“ (englisch „done“); „Stopp“ bleibt dem Abbrechen-Sinn erspart. Handytexte nennen Foto/Art im Menü der Brille.
- Sprachwechsel am Handy baut die Brillenseite neu auf, damit das Menü die Sprache trägt.
- Demo: FieldLog braucht keinen Server (Sprachserver ist optional), startet also ohne Einrichtung mit „Tippen = starten“; kein Demo-Hinweis nötig (v1.2 Nr. 7).

## [0.7.0] — 2026-10-14

Bedienung nach dem Quietglass-Bedienstandard (QIS v1).

### Behoben (Sicherheit)

- **Wischen warf den diktierten Text weg** (zweimal wischen). Wischen bewegt jetzt nur noch: bei „Behalten?“ zwischen den beiden Auswahlzeilen „Behalten“ und „Verwerfen“. Verwerfen ist die ausdrückliche Auswahl „Verwerfen“, wird mit Tippen vorgemerkt („Nochmal tippen = Text verwerfen · Wischen/2× = abbrechen“) und mit einem zweiten einzelnen Tippen innerhalb von 4 s ausgeführt. Wischen, 2× oder 4 s ohne Eingabe brechen ab. (Gespeicherte Einträge werden nur am Handy gelöscht.)
- **2× stoppt keine Aufnahme mehr und verwirft keinen Text**: Während der Aufnahme und bei „Behalten?“ tut 2× nichts (ein vorgemerktes Verwerfen bricht es ab). Zum Beenden erst mit Tippen stoppen.

### Neu

- **Hilfeseite**: letzter Halt der Typ-Auswahl auf dem Ruhebild (Wischen: Notiz · Mangel · Wichtig · Hilfe); ohne offenen Rundgang öffnet Halten die Hilfe. 2× geht zurück.

### Geändert

- 2× geht eine Ebene zurück: Schnellnotiz-Liste → Ruhebild, Hilfe → Ruhebild; beendet wird nur auf dem Ruhebild (und auf dem Bild ohne Rundgang).
- Kopfzeile `FIELDLOG · Zustand` (Bereich · Laufzeit, Mikrofon-Uhr mit TEST/Live-Hinweis, „Behalten?“). Fußzeile nur noch Gesten in der Reihenfolge Tippen → Wischen → Halten → 2×, endend auf `2× = Ende` bzw. `2× = zurück` (englisch Tap/Swipe/Hold/2×, exit/back). Passt sie nicht in die Zeile, entfällt der Wischen-Hinweis.
- `invertScroll` (Handy, Tab „Brille“) gilt unverändert für jede Liste, auch Auswahl „Behalten/Verwerfen“ und die Typ-Auswahl.

## [0.6.1] — 2026-10-13

- Handy-Seite in Tabs statt einer langen Spalte: Rundgang · Archiv · Brille · Mehr (Tab-Leiste unten, gewählter Tab bleibt). Status-Chip oben zeigt den laufenden Rundgang. Der Sprachserver (früher eingeklappt unter „Erweitert“) steht als normale Karte unter „Mehr“.

## [0.6.0] — 2026-10-13

### Neu — Live-Diktat

- **Text erscheint beim Sprechen auf der Brille** (fertige Sätze + der gerade erkannte Teil, die neuesten Wörter unten, höchstens alle 300 ms neu gezeichnet), wenn der private Build einen Live-Server mitbringt (`VITE_LIVE_STT_URL=wss://…`). Beim Stopp wird der ganze Text wie bisher zur Kontrolle gezeigt und als Eintrag gespeichert.
- Aufnahme bis 10 min (Sicherheitsgrenze statt 30 s); die Fußzeile zeigt die Laufzeit.
- **Rückfall ohne Verlust:** Der Ton bleibt während der Aufnahme am Handy. Öffnet der Live-Server nicht binnen 3 s oder bricht ab, läuft die Aufnahme weiter („Live-Text weg – Ton wird weiter aufgenommen.“) und geht beim Stopp als WAV an den Whisper-Server – nach einem Abbruch nur der Teil, den der Live-Text noch nicht fest hatte. Ist das mehr als ~30 s, gehen nur die letzten 30 s, und der Kontroll-Bildschirm sagt es („Behalten? · nur die letzten 30 s erkannt“).
- Warum nicht wieder das Problem von 0.4: der WebSocket ist nur Vorschau, kein Neuverbinden, Ton vor dem Verbindungsaufbau wird nachgeschickt statt verworfen, die Adresse kommt nur aus dem privaten Build (Handy-Einstellung bleibt http(s), gespeicherte ws://-Adressen werden weiter verworfen).
- Wartezeit auf den Whisper-Server wächst mit der Länge: 20 s + 1 s je 10 s Ton, höchstens 120 s.

## [0.5.0] — 2026-10-13

### Changed — dictation over HTTP

- **Dictation now works with a stock Whisper server.** The note is recorded on the phone while you speak and sent as one WAV file to an OpenAI-compatible `/v1/audio/transcriptions` endpoint (multipart form without own headers, so no CORS preflight) — the same path as NextStop and OpenGlance. The old FieldLog-only WebSocket protocol is gone; a stored `ws://`/`wss://` address is dropped on load.
- Private builds take the server from `VITE_STT_URL` (empty phone setting = build default) and list its exact origin in a private `app.json`; the public `app.json` no longer lists `ws://`/`wss://`.
- A dictation stops by itself after 30 s and is sent; a mis-tap with almost no audio sends nothing ("Nichts verstanden – nochmal tippen.").
- Discarding a transcript under review takes a second swipe within 4 s ("Nochmal wischen = Text verwerfen"); one stray swipe used to throw the text away.
- Footers in the shared style: "Tippen = starten · 2× = Ende", "Tippen = Stopp", "Tippen = behalten · Wischen = verwerfen · Halten = Foto", "Wischen = ändern".

### Fixed

- A refused microphone is said on the glasses ("Mikrofon nicht freigegeben. In der Even-App erlauben, dann tippen.") instead of looking like an ignored tap; a cancelled or refused camera says "Kein Foto – abgebrochen oder nicht erlaubt.".
- A microphone call that answers late (after 5 s) is switched off again instead of staying open.
- Gestures are wired before the first page is drawn; a reconnect during a running draw is no longer undone by that draw.
- Leaving through the system (another app, the system menu) drops a dictation in progress and closes the microphone; coming back rebuilds the page. A system exit or crash closes it for good. After the exit dialog the microphone is no longer switched off twice.

## [0.4.0] — 2026-10-13

### Changed

- The resting screen lists the last three entries (newest at the bottom) instead of only the last one.
- The page is created once per run and later only rebuilt.

## [0.3.3] — 2026-10-13

### Changed

- Glasses rows use the full display width (56 instead of 44-46 characters): last entry, quick notes and the transcript to confirm wrap later.
- Footer says how long the inspection has been running ("seit 23m" / "for 23m") instead of a bare duration.

## [0.3.2] — 2026-10-13

### Fixed

- Start language: the Even app's WebView reports English even on a German phone.
  An explicit language choice is now kept in the SDK store; without one, a German-speaking
  Even account country (AT/DE/CH/LI/LU) starts the app in German.

## [0.3.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

All notable changes to FieldLog are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-10-07

### Changed

- Store readiness: system exit dialog, privacy policy.
  - A double tap on the root screen now opens the system exit dialog
    (`shutDownPageContainer(1)`). Cancel and the app carries on unchanged;
    timers, streams and sensors stop only after you confirm. A failed call
    is caught and leaves the app running.
  - A running dictation pauses the microphone for the dialog and continues if you cancel.
  - `docs/PRIVACY.md` covers every permission in `app.json`, with a German
    summary, and is linked from the README.
  - Store art in `store/` (icon, 24 px monochrome icon, background,
    tagline), generated by `tools/store-art.mjs`.

## [0.1.0] — 2026-09-25

First release.

### Added
- Hands-free inspection logging: dictate an entry, confirm the transcript,
  carry on.
- Every transcript is shown for confirmation before it is filed. An inspection
  report is a document someone acts on, so a misheard entry must be catchable
  at the moment it is made.
- Severity per entry (note / minor / major), cycled with a swipe.
- Sections set on the phone; entries inherit the current one so the report
  groups itself.
- Photo attachment through the SDK's phone-camera picker, attached to the entry
  just dictated. The glasses have no camera.
- Speech recognition against a server the user configures, using the same wire
  format as Babel Glass so one Whisper instance serves both. A mock runs when
  none is configured, labelled MOCK on the glasses.
- Markdown export grouped by section with majors in bold, a variant with photos
  embedded, and CSV.
- Photos referenced by size rather than embedded by default, because a report
  full of inline base64 is neither readable nor emailable.
- Stored-size estimate with a warning before per-app storage becomes a problem.
- Phone companion for starting and finishing inspections, reviewing and editing
  entries, and exporting.
- 44 unit tests covering entry building, section inheritance, attachment,
  severity changes, export formats and display phases.

### Known limitations
- Photos live in per-app storage, which is not a filesystem; export and remove
  old inspections.
- Entry text cannot be edited on the glasses.
- One inspection open at a time, deliberately.
- Not yet verified on physical hardware.
