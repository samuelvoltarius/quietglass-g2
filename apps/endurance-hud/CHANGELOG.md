# Changelog

## [0.6.0] — 2026-10-20

Nach dem Quietglass UI Standard (QUS v1) umgebaut: keine Textwand mehr.

### Brille

- **Hauptbild als Cockpit-Bild** (Muster Rain Lens, `src/screen/*` unverändert aus Rain Lens): das ganze Display ist ein Bild aus vier Kacheln. Links oben ein **Ring mit den fünf Pulszonen** (der Puls steht in der Mitte, die aktuelle Zone ist dick und hell), darunter Leistung und Kadenz groß, darunter `RAD · LIVE`. Rechts der Kopf `ENDURANCE HUD  14:05`, **eine** Überschrift (Rad: `31.4 KM/H`, Laufen: `5:42 /KM`) und sechs Werte in drei Spalten (SPORT, ZEIT, DISTANZ, Ø TEMPO bzw. Ø PACE, ZONE, PULS MAX). Zone 5 bekommt einen Rahmen. Helligkeit statt Farbe (Text 15, Label 8, gedimmt 4).
- **Nur geänderte Kacheln werden gesendet:** dieselben Werte senden nichts, die Uhr ändert nur die Kachel oben rechts, neue Leistung/Kadenz nur die unten links. Während der Beenden-Dialog offen sein kann, wird keine Kachel geschrieben.
- Eine Hinweiszeile unten über den gemeinsamen Helfer: Tippen = neu, Wischen = Sport, 2× = Ende. Verspätete oder ausgefallene Werte zeigen weiter `VERALTET 12s` (in der Zeile links unten), Beispieldaten `DEMO`.
- Entfallen: Textzeilen, die Hilfeseite (Halten tut nichts mehr, die Bedienung steht am Handy), die Sportliste und das Rad-/Lauf-Symbol.
- Beibehalten: `SIDE_MENU = false`, die Beenden-Dialog-Logik unverändert (`src/exit.ts`, kein Zeichnen und keine Kachel, solange er offen sein kann), Zeitlimits für jeden Aufruf an die Brille, erste Seite mit Rebuild + Create, Abfrage der Bridge alle 2 s mit höchstens einer Anfrage zugleich.

### Handy

- **Genau drei Tabs in einer Zeile: Jetzt / Verlauf / Einstellungen** im Rain-Look: Kicker `QUIETGLASS / SPORT`, Titel, Status-Pille, Statusbanner, Hero-Karte mit dem Hauptwert, 2×2-Kennzahlen (Puls mit Zone, Leistung, Kadenz, Distanz) und ein Hauptknopf („Jetzt neu laden“). *Verlauf* zeigt Distanz, Zeit, Ø und Max Puls, Ø Leistung und eine waagrechte Kartenleiste mit einer Karte je Minute (nur im Speicher, solange die App offen ist). *Einstellungen* sind gruppierte Karten (Verbindung, Sport und Puls mit Maximalpuls für die Zonen, Brille, Sprache, Mehr); beim ersten Start steht eine Drei-Schritte-Checkliste oben und die Seite öffnet dort. Ohne Bridge läuft ein Beispiel-Training.
- Alle fünf Sprachen (de, en, fr, es, it) auch für die neuen Texte.
- Die Seite folgt jeder Abfrage, ohne Eingaben zu stören.

### Technik

- Reine Modellfunktionen mit Tests: `src/cockpit/model.ts` (Überschrift, Zellen, Ring, Hinweis), `src/cockpit/compose.ts` (nur Layout), `src/telemetry/model.ts` (Zustand, Zonen, Mittelwerte, Verlauf). Neue Tests: Zellen, Überschrift, Ring, Hinweise in allen Sprachen, Kachel-Diff, Beenden-Dialog ohne Kachel-Sendungen, Handy-Modelle.
- Vorschau (nicht ausgeliefert): `QG_PREVIEW=1 npx vitest run tests/preview.test.ts` schreibt `store/preview-cockpit.png` und `store/preview-cockpit-run.png`.

QIS: Fußzeilen über den gemeinsamen Helfer, `2× = zurück|Ende`.

## [0.5.6] — 2026-10-17

### Behoben (Hardware-Test, Schrittprotokoll)

- **Die Ereignisse 4/5 direkt nach dem Beenden-Aufruf werden als Anzeigen/Schließen des Dialogs gelesen**, nicht als „App kommt/geht“: 4 = der Dialog ist da (es wird nichts gezeichnet), 5 = der Dialog ist nach „Nein“ weg. Die App war nie weg: nichts wird angehalten, Abfragen und Timer laufen weiter.
- **Nach „Nein“ kommt die Seite sofort zurück, ohne Geste.** Das erste 2× danach öffnet den Dialog wieder.
- Ein 2× auf der Startseite, das ankommt, während die App sich im Hintergrund glaubt, wird nicht mehr verschluckt (hier gab es nichts zu ändern: die Geste wird in jedem Zustand verarbeitet).

## [0.5.5] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.5.4] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.
- Systemende (Ereignis 6/7) beendet jetzt das Abfragen ausdrücklich.
All notable changes to Endurance HUD are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.5.3] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

## [0.5.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus: Die Klicks im Menü kommen auf der Brille nie in der App an, und Halten öffnet bei einer Seite mit Menü nur das Menü. Die Seiten tragen jetzt kein Menü (`SIDE_MENU = false`); der Menü-Code bleibt für später.
- Wischen wechselt wieder die Sportart (Rad / Laufen) und speichert sie.
- Halten öffnet wieder die Hilfe; Tippen oder 2× schließt sie.
- Tippen lädt neu, 2× beendet (in der Hilfe: zurück). Fußzeile des Live-Bilds: `Tippen = neu · Wischen = Sport · Halten = Hilfe · 2× = Ende`. Die Hilfeseite und die Hinweise am Handy beschreiben wieder diese Gesten.
- Die Sportart-Liste gehört zum Seitenmenü und ist damit vorerst nicht erreichbar; die Sportart lässt sich per Wischen oder im Handy-Tab „Brille“ wählen.

## [0.5.1] — 2026-10-15

### Behoben

- Die Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben. Jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s); danach gilt der Aufruf als fehlgeschlagen und die Seite wird neu aufgebaut.

## [0.5.0] — 2026-10-14

### Geändert (QIS v1.2)

- Seitenmenü der Brille (Halten): **Sportart** und **Hilfe**. Halten allein öffnet nicht mehr die Hilfe.
- Wischen speichert keine Sportart mehr (QIS v1.2, Regel 5): die Sportart wird in einer Liste gewählt (Automatisch / Rad / Laufen), Wischen bewegt den Cursor, Tippen setzt und speichert, 2× geht zurück ohne etwas zu ändern. Auf dem Live-Bild macht Wischen nichts.
- Fußzeile des Live-Bilds: `Tippen = neu · 2× = Ende`. Die Hilfeseite beschreibt das Seitenmenü.
- Das Seitenmenü gehört zur Seite: ein Sprachwechsel am Handy baut sie neu auf, damit die Menüeinträge in der neuen Sprache stehen.

## [0.4.0] — 2026-10-14

### Geändert (QIS v1)

- Bedienung nach dem Quietglass-Bedienstandard (QIS v1, `docs/BEDIENSTANDARD.md`). Die App stoppt, löscht und sendet nichts; ein Arm-und-bestätigen war nicht nötig. Wischen wechselt nur die Sportart (Anzeige), Tippen lädt neu, 2× beendet über die Systemfrage.
- Kopfzeile `ENDURANCE HUD · Zustand`, Fußzeile über den gemeinsamen `footer()`-Helfer in der Reihenfolge Tippen/Wischen/Halten/2× und mit `2× = Ende`; passt die Zeile nicht in 56 Zeichen, entfällt zuerst der Wisch-Teil.
- Neue Hilfeseite: Halten öffnet sie (die App hat keine Liste); Tippen oder 2× schließen sie, 2× beendet dort nie die App.
- Neu: Einstellung „Wischrichtung umkehren“ (`invertScroll`) im Handy-Tab „Brille“; sie gilt für das Wischen zwischen den Sportarten.
- Handy-Seite in Tabs `Live · Brille · Verbindung · Mehr`; „Mehr“ zeigt Version und Datenschutz.

## [0.3.1] — 2026-10-13

### Fixed

- Start language: the Even app's WebView reports English even on a German phone.
  An explicit language choice is now kept in the SDK store; without one, a German-speaking
  Even account country (AT/DE/CH/LI/LU) starts the app in German.

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

