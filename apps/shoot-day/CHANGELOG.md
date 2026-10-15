# Changelog

## [0.7.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): seine Klicks kommen auf der Brille nie an, und Halten öffnet sonst das Menü statt die App zu erreichen (Diktat per Halten war damit blockiert). Die Seiten tragen kein `menuObject` mehr; der Menücode und der `menuItemClickEvent`-Handler bleiben, damit es wieder eingeschaltet werden kann.
- Halten diktiert wieder (Kunde, Takes, Packliste). 2× beim Sprechen bricht die Aufnahme wieder ab (Parken gibt es nur mit Seitenmenü; ohne Menü könnte nichts die gemerkte Aufnahme senden oder verwerfen). Aufnahme senden/verwerfen entfallen damit.
- Hilfe ist wieder die letzte Zeile der Liste (im Menü ohne Kunden, sonst in der Kundenliste); Tippen öffnet sie, Tippen oder 2× geht zurück.
- Letzten Take löschen ist eine Zeile im Take-Menü (Tippen auf die Take-Karte): erstes Tippen fragt (`Nochmal tippen = letzten Take löschen`), das zweite löscht; Wischen oder 2× bricht ab.

## [0.7.1] — 2026-10-15

### Behoben

- Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben; jetzt hat jeder Aufruf an die Brille ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s), danach gilt der Aufruf als fehlgeschlagen und die Seite wird beim nächsten Zeichnen neu aufgebaut.

## [Unreleased]

### Neu — Server: `POST /api/take/delete`

- Gegenstück zu „Letzten Take löschen“ der Brille 0.7.0: `POST /api/take/delete {scene, shot, n}` (optional `?project=<id>`) entfernt genau diesen Take, antwortet `{ok:true, deleted}` bzw. 404 `unknown take`. Takes werden nicht ins Work Dashboard gespiegelt; der Abgleich ist unberührt.

### Neu — Server: Work Dashboard (Einweg-Abgleich) und Gesprächsnotizen aus Babel

- **Work Dashboard.** Mit `SHOOT_WD_URL` + `SHOOT_WD_TOKEN` (Agent-Token `wd_…`) spiegelt der Server Kunden, Projekte, Termin (`Termin: <Projekt>` mit Datum), `#todo`-Ideen (je eine Aufgabe, erledigt = done), offene Ideen + Telefon/Notizen („Ideen & Notizen“), Storyboards/Shotlist/Skript („Drehvorbereitung“) und Gespräche (Kommentar) über dessen MCP-Endpunkt — nur in diese Richtung, 10 s nach der letzten Änderung, nur Geändertes (Inhalts-Hash), mit Wiederholung. Drüben wird nie gelöscht: Gelöschtes wird archiviert bzw. vermerkt. Bestehende Kunden werden am Namen erkannt. `POST /api/wd/sync`, `GET /api/wd/status`; das Web-Terminal zeigt „Work Dashboard: verbunden / aus / Fehler“. Neues Modul `examples/shoot-day-wd.mjs`.
- **Gesprächsnotizen.** `POST /api/projects/<id>/talks {at, summary, cues}` (höchstens 100 je Projekt); der babel-llm-proxy legt nach jeder Zusammenfassung die Zusammenfassung + Tipp-Karten dort ab.

## [0.7.0] — 2026-10-14

Brillen-App nach QIS v1.2 (Audit 14.10.2026). Nur die App; der Beispiel-Server ist unverändert.

### Geändert (QIS v1.2)

- **Seitenmenü der Brille** (`menuObject`, Klicks über `menuItemClickEvent`; Vorlage Babel Glass), auch auf der Licht-Seite: `Hilfe`, `Letzten Take löschen`, `Aufnahme senden`, `Aufnahme verwerfen`. Die Zeile „Hilfe“ in der Modulliste und in der Kundenliste ist entfallen; die Hilfeseite öffnet über jedem Bild und geht (2× oder Tippen) genau dorthin zurück.
- **2× beim Sprechen verwirft nichts mehr.** 2× schaltet Mikrofon und Live-Erkennung ab und behält die Aufnahme (Hinweis „Aufnahme gemerkt · Menü: senden/verwerfen“). Das Menü sendet sie später wie eine mit Tippen beendete Aufnahme oder verwirft sie: erster Klick merkt vor („Nochmal tippen = Aufnahme verwerfen · 2× = abbrechen“), ein einzelnes Tippen oder ein zweiter Klick auf denselben Menüpunkt innerhalb von 4 s führt aus; auch während des Sprechens. Während die Aufnahme erkannt wird, tut 2× nichts (Fußzeile „bitte warten“). Ein erkannter, noch nicht angelegter Kundenname wird ebenfalls nicht mehr durch 2× verworfen: 2× merkt das Verwerfen nur vor, das Tippen führt aus.
- **Take OK bleibt ein einzelnes Tippen, ist aber rückgängig zu machen:** `Letzten Take löschen` (nur im Take-Modul, jüngster Take des Shots am Bild) ist vorgemerkt wie jede riskante Aktion. Ein noch wartender Offline-Take verschwindet aus dem Ausgang; ein gesendeter wird per `POST /api/take/delete {scene, shot, n}` am Server entfernt. **Der mitgelieferte Beispiel-Server kennt diesen Aufruf noch nicht** (er antwortet 404): dann sagt die Brille „nicht gespeichert: Server meldet einen Fehler“ und der Take bleibt. Das Gegenstück in `examples/shoot-day-server.mjs` ist noch zu bauen.
- **Keine HTTP-Nummern auf der Brille (v1.2 Nr. 8):** „Fehler (HTTP 503)“ heißt jetzt „Server meldet einen Fehler“; der Handy-Tab „Server“ zeigt weiter den Status.
- **Erster Start = Demo (v1.2 Nr. 7):** Ohne Server-Adresse (und ohne eingebaute) zeigt die App Beispieldaten und die Zeile „Demo · Verbindung am Handy einrichten“ (Menü und Kundenliste); es wird nichts ins Netz geschickt oder gespeichert. Sobald am Handy eine Adresse gespeichert wird, endet die Demo. Statt der Meldung „Noch kein Server“ sieht man jetzt die Demo; am Handy steht der Hinweis im Tab „Server“. `?demo=1` bleibt für Vorführungen.
- Fußzeilen: Aufnahme-Auswertung ohne 2×-Angabe; jede vorgemerkte Aktion (auch aus dem Menü, auf jedem Bild) zeigt die Zeile „Nochmal tippen = … · Wischen/2× = abbrechen“. Sprachwechsel am Handy baut die Brillenseite neu auf (das Menü trägt die Sprache). Handy-Hilfetabelle ergänzt um das Menü.
- Nicht angefasst: `examples/`, README, `docs/` (Beschreibung der Gesten dort ist noch auf dem Stand 0.6.1).

## [0.6.1] — 2026-10-14

### Geändert — Take „nicht ok“ ist scharf geschaltet (QIS v1)

- **NG braucht ein zweites Tippen.** Im Aktionsmenü zeigt *Take nicht ok* beim ersten Tippen `Nochmal tippen = nicht ok · Wischen/2× = abbrechen`; erst ein zweites einzelnes Tippen innerhalb von 4 s loggt den Take als NG. Wischen, Halten, 2× oder 4 s ohne Eingabe brechen ab. *Take OK* bleibt ein einzelnes Tippen. Gleicher Mechanismus wie *Take abbrechen*.

## [0.6.0] — 2026-10-14

### Geändert — Bedienung nach QIS v1

Die Brillen-App folgt dem Quietglass Interaction Standard (QIS v1, `docs/BEDIENSTANDARD.md`).

- **Sicherheit.** Alles, was abbricht oder zurücksetzt, ist „scharf geschaltet“: *Take abbrechen* (laufender Take) und die Sprachbefehle „Alles eingepackt / wieder offen“ zeigen `Nochmal tippen = … · Wischen/2× = abbrechen`; erst ein zweites einzelnes Tippen innerhalb von 4 s führt es aus, Wischen, Halten, 2× oder 4 s ohne Eingabe brechen ab (vorher: 8 s und nur Wischen). Ein laufender Take geht nicht mehr durch Wischen zu einem anderen Shot oder durch 2× zurück ins Menü verloren; er bleibt bei seinem Shot.
- **2× geht nur zurück.** In „Neuer Kunde“ heißt es jetzt `2× = zurück` (der erkannte, noch nicht gespeicherte Name entfällt dabei, es wird nichts angelegt); auch bei laufender Aufnahme steht `2× = zurück`. Die Szenen-Markierung (Tippen = erledigt / wieder offen) bleibt ungeschützt, weil ein weiteres Tippen sie umkehrt; Take OK/NG liegen hinter dem Aktionsmenü (zwei Schritte) und werden angehängt.
- **Kopfzeile `SHOOT DAY · Zustand`**, Fußzeile über den gemeinsamen `footer()`-Helfer in der Reihenfolge Tippen → Wischen → Halten → 2×, am Ende `2× = zurück` bzw. `2× = Ende` (Wurzel); zu breit: erst Wischen weglassen, nie 2×. Begriffe: „2×“ statt „Doppeltippen“.
- **Hilfe** als letzter Eintrag der Kundenliste (bei einem Server ohne Kunden: des Menüs) mit den vier Gesten und dem, was die App braucht.
- **Wischrichtung umkehren** gilt in jeder Liste (Kunden, Projekte, Menü, Szenen, Shots, Packliste …); der Schalter steht im Handy-Reiter „Brille“.
- **Handy-Reiter** in der Reihenfolge Drehtag · Licht · Brille · Verbindung · Mehr (Server-Adresse und Token unter „Verbindung“, Sprache, Version und Datenschutz unter „Mehr“).
- Neu: `tests/qis.test.ts` prüft jede Ansicht in Deutsch und Englisch auf Kopfzeile, Reihenfolge, Wortschatz und Breite.

## [0.5.0] — 2026-10-14

### Neu — Kunden, Storyboards, Ideen, Dateien

- **Kunden als oberste Ebene.** Auf der Brille steht ganz oben die Kundenliste (nach Name sortiert, „+ Neuer Kunde“ zuerst), darunter je Kunde die Projekte (neuestes Datum zuerst, `●` = das Projekt, mit dem die Brille gerade arbeitet), darunter die Module. Doppeltippen geht eine Ebene zurück (Modul → Menü → Projekte → Kunden); erst in der Kundenliste fragt es, ob die App beendet werden soll.
- **Neuer Kunde per Sprache an der Brille:** „+ Neuer Kunde“ antippen (oder in der Liste halten) und den Namen sagen („Neuer Kunde Anna Beispiel“). Die Brille zeigt den erkannten Namen und fragt nach: Tippen = anlegen, Halten = neu sprechen, Doppeltippen = verwerfen. Gibt es den Namen schon, springt sie zu diesem Kunden statt einen zweiten anzulegen. Gleicher Sprachweg wie Packliste und Takes (Live-Text in privaten Builds, sonst `/api/stt`).
- **„Kunde vor dem Termin“** (erster Eintrag in der Projektliste): Firma, Telefon, E-Mail, zuletzt geändert, Notizen, offene Ideen mit Stichwörtern und – nur wenn der Server `SHOOT_BABEL_URL` hat – die passenden Einträge aus Babels Gedächtnis (Suche nach Name und Firma über den Server). Wischen blättert seitenweise.
- **Storyboard als Modul** (erstes im Projektmenü): eine Karte pro Szene beim Dreh mit `SZENE 2/7 · 0:05–0:12`, Titel, was passiert, Kamerahinweis, Texteinblendung und Ziel. Wischen = nächste/vorige Szene, Tippen = erledigt (bzw. wieder offen; kommt es nicht beim Server an, wird es zurückgenommen), Doppeltippen = anderes Storyboard (bei mehreren) bzw. Menü.
- **Web-Terminal neu aufgebaut, übersichtlicher:** links die Kunden nach Name mit Suche und „Neuer Kunde“; Kundenseite mit allen Feldern (Name, Firma, Telefon, E-Mail, Notizen), Projekten und „Neues Projekt“, Löschen mit Rückfrage (Projekte mitlöschen oder nach „Ohne Zuordnung“ verschieben); Projektseite mit Name, Datum, Ort, Kunde (zum Verschieben), „Auf der Brille zeigen“ und den Reitern Storyboard · Shotlist · Ideen · Skript · Tagesplan · Packliste · Dateien. Das Web-Terminal bearbeitet jedes Projekt, ohne die Brille umzuschalten.
- **Dateien:** PDF, PNG und JPEG per Drag & Drop hochladen (höchstens `SHOOT_MAX_UPLOAD_MB`, Standard 20 MB). Der Server prüft den Dateityp an den ersten Bytes, speichert unter einer zufälligen ID (der Dateiname wird nie zum Pfad) und liefert Dateien nur mit `Content-Security-Policy: sandbox` aus.
- **„Storyboard aus PDF“:** Der Server liest den Text der PDF selbst aus (eigener, abhängigkeitsfreier Leser: FlateDecode, Objekt-Streams, Tj/TJ mit ToUnicode – so schreiben Canva, Word und die meisten Layout-Programme) und schickt ihn an dein Sprachmodell (`SHOOT_LLM_URL`, OpenAI-kompatibel, ohne „thinking“) mit der Bitte um Szenen als strenges JSON. Der Vorschlag öffnet sich als bearbeitbare Tabelle; gespeichert wird erst nach dem Prüfen. Ohne Sprachmodell, bei unbrauchbarer Antwort oder bei PDFs ohne auslesbaren Text (eingescannt, verschlüsselt) sagt das Terminal das und bietet die Eingabe von Hand an, den ausgelesenen Text darunter.
- **Ideen** pro Projekt mit Stichwörtern (und „umgesetzt“). Neuer Endpunkt `GET /api/ideas?customer=<ID oder Name>` (optional `&open=1`) für eine spätere Babel-Version, die passende Ideen im Kundengespräch zeigt.

### Geändert

- **Datenmodell Version 2** (`{ version, active, customers, projects }`). Beim ersten Start mit einer alten Datei kopiert der Server sie zuerst byte-genau nach `DATA_FILE.bak-v1-<Zeit>` und hängt dann alle Projekte an den Kunden „Ohne Zuordnung“ (`PRESET_LANG=de`, sonst „Unassigned“). Ohne Sicherung startet er nicht. Eine unlesbare Datendatei wird beiseitegelegt (`.broken-<Zeit>`) statt überschrieben. Jedes Speichern: temporäre Datei, fsync, Umbenennen.
- Die bisherigen Endpunkte (Shotlist, Takes, Skript, Tagesplan, Packliste) arbeiten weiter mit dem aktiven Projekt (Brille, MCP) und zusätzlich mit `?project=<ID>` (Web-Terminal). `POST /api/active` nimmt `{ id }` (oder wie bisher `{ name }`).
- Mit einem Server vor 0.5.0 (ohne Kunden, 404) bleibt auf der Brille alles wie bisher: Menü als oberste Ebene, kein Storyboard. Die Brille schaltet nur dann selbst auf die Kundenliste, wenn seit dem Start noch keine Geste kam.
- Neue Umgebungsvariablen am Server: `SHOOT_FILES_DIR`, `SHOOT_MAX_UPLOAD_MB`, `SHOOT_LLM_URL`, `SHOOT_LLM_MODEL`, `SHOOT_LLM_TOKEN`, `SHOOT_BABEL_URL`, `SHOOT_BABEL_TOKEN`. Neu daneben im Repo: `examples/shoot-day-pdf.mjs`.
- CORS erlaubt zusätzlich `DELETE` und den Kopf `X-File-Name`; die 204-Antwort auf OPTIONS hat weiterhin keinen Inhalt.

## [0.4.0] — 2026-10-14

### Neu — Licht & Sonne

- **Neues Modul „Licht & Sonne“** im Startmenü (auch ohne Server nutzbar). Die ganze Brillenanzeige ist ein Bild (Vollbild-Baukasten aus Rain Lens: 4 Kacheln, nur geänderte Kacheln gehen über Bluetooth):
  - große Überschrift „GOLDENE STUNDE in 42 min“ mit Zeitfenster (läuft sie gerade: „jetzt · noch 18 min“), sonst die nächste blaue Stunde;
  - Kompassrose (Norden oben, deutsche Himmelsrichtungen N/O/S/W) mit der Sonne auf dem Ring, Auf- und Untergangsrichtung gestrichelt, darunter „SONNE 12° WSW“ und die Mondphase;
  - kleiner Sonnenbogen des Tages (goldene Stunden hell, blaue Stunden gepunktet, Horizont, aktuelle Position);
  - Untergang + blaue Stunde, Aufgang + Höchststand;
  - unten das nächste Shooting aus dem Tagesplan: „Shooting 18:30: Sonne 12° WSW, goldene Stunde ab 19:12“.
- Gesten: Wischen = Zeit ±30 min vor/zurück (Vorschau, höchstens 24 h), Tippen = zurück auf jetzt bzw. Standort und Tagesplan neu holen, Doppeltippen = Menü.
- **Handy: neuer Tab „Licht“** mit derselben Überschrift, Sonne jetzt, Fakten, Licht zu jedem Punkt des Tagesplans und der Zeitleiste des Tages (blaue/goldene Stunde, Auf-/Untergang, Höchststand, Shootings). Knopf „Standort aktualisieren“.
- Sonnenrechnung offline auf dem Handy (NOAA/Meeus): Azimut/Höhe, Auf-/Untergang (−0,833°), goldene Stunde −4°…+6°, blaue Stunde −6°…−4°, Sonnenhöchststand; Mondphase. Getestet gegen unabhängige astropy-Werte für Salzburg (47,8° N 13,04° E) an vier Tagen (±2 min, ±0,5°), dazu Polartag/-nacht.
- Standort: Handy-Standort (neue optionale Berechtigung `location`, erst beim Öffnen von „Licht“ abgefragt, mit 10-s-Grenze im Hintergrund – die Brille bleibt bedienbar), sonst `lat`/`lon` aus dem Tagesplan des Servers (Drehort), sonst der zuletzt bekannte Ort (auf ~1 km gerundet, nur am Handy gespeichert).

### Geändert

- Tagesplan (`/api/dispo`) darf `lat`/`lon` (oder `latitude`/`longitude`) des Drehorts enthalten.
- Menü mit fünf Einträgen; die Leerzeile vor den Hinweisen entfällt, wenn sonst der Platz nicht reicht.

## [0.3.1] — 2026-10-13

### Geändert

- Handy-Seite in Tabs statt einer langen Spalte: Drehtag · Server · Brille (Tab-Leiste unten, gewählter Tab bleibt), Status-Chip mit Projekt bzw. Verbindungszustand oben. Sprachwahl und Datenschutz stehen jetzt unter „Server“, „Scroll umkehren“ unter „Brille“.

## [0.3.0] — 2026-10-13

### Neu — Sprachbefehle live

- **Der Befehl steht schon beim Sprechen auf der Brille.** Private Builds mit `VITE_LIVE_STT_URL` streamen das Mikrofon an die eigene Live-Spracherkennung; die neuesten Wörter bleiben sichtbar (Neuzeichnen höchstens alle 300 ms, nur bei geändertem Text).
- **Loslassen führt sofort aus** – direkt aus dem Live-Text, ohne zweite Erkennung am Server. Die Befehlserkennung (Packliste, Takes) ist unverändert; „Alles eingepackt“ fragt weiter nach.
- Rückfall ohne Verlust: Öffnet die Live-Verbindung nicht binnen 3 s, bricht sie ab oder hat sie nichts gehört, geht die Aufnahme wie bisher an `/api/stt`.

### Geändert

- Höchstdauer einer Aufnahme 2 Minuten statt 15 s (Schutz gegen ein verlorenes Loslassen).

## [0.2.1] — 2026-10-13

### Added

- Private builds carry the server address (`VITE_SHOOTDAY_URL`): nothing to type on the phone. A stored placeholder (loopback, example host) gives way to it once.
- Takes logged offline are sent again every minute while any are waiting, not only on the next visit to the menu.

### Fixed

- Module, shot, running take timer, prompter line and packing-list position survive a restart of the app (phone locked, Even app unloaded it).
- "Alles eingepackt" / "alles wieder raus" by voice asks first: a tap confirms, a swipe cancels.
- Leaving through the system switches the microphone off and stops the prompter and timers; coming back rebuilds the page and reloads.
- The glasses listen before the first page is built.

### Changed

- Footers in one style; the takes card names hold (`Tippen = Take · Halten = sprechen · 2× = Menü`).

## [0.2.0] — 2026-10-13

### Added

- A sign in the top-right corner of the header (64 x 30 image) for every page. While a take runs on the takes page it is a recording dot that pulses once a second.
- "Take läuft": a new first entry "Take starten" in the take menu (it opens on "Take OK") starts a take; the card shows "● Take 3 läuft · 0:23". Logging OK or NG, moving to another shot or leaving ends it; while it runs the entry reads "Take abbrechen".
- Day bar on the schedule page (image, 288 x 20): from the call time to the last entry, filled up to now, a tick per entry and a marker for now, start and end time below.

### Changed

- "in 1319 min" now reads "in 21 h 59 min" from two hours on.
- The header text ends 64 px before the right edge; the schedule page shows six body rows to make room for the bar. Going to or from the schedule page is a page rebuild.

### Fixed

- Page set-up on the glasses: one `rebuildPageContainer`, then exactly one `createStartUpPageContainer`, later pages are rebuilds.

## [0.1.4] — 2026-10-13

### Changed

- Glasses rows use the full display width (56 instead of 46 characters): teleprompter, schedule, packing list and take notes.
- Take card: first row reads "Szene 1 · Shot A · WS" (scene, shot letter, size) instead of the bare "1 · A   WS"; header shows the position ("1 von 5") without repeating the scene.

## [0.1.3] — 2026-10-13

### Fixed

- Start language: an explicit choice is kept in the Even SDK store (the WebView's localStorage may not survive a relaunch); without one, a German-speaking Even account country (AT/DE/CH/LI/LU) starts the app in German, even when the WebView reports English.

## [0.1.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

All notable changes to Shoot Day are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-10-07

First public release, brought over from a private shoot-day app and rebuilt on
Quietglass conventions.

### Added
- Start menu with four modules: take log, teleprompter, schedule (call sheet)
  and packing list.
- Take log: OK/NG per shot with a note, counts and the last take on the card;
  takes logged offline are kept on the phone and sent later.
- Note on the last take now updates that take instead of logging a second one.
- Packing list with voice: hold to speak, release to apply; German and English
  sentences, "what's missing?" and "everything packed".
- Voice commands for takes ("Szene 2 B OK unscharf", "scene 2 B no good").
- Phone page: server address and optional token (write-only), language,
  swipe inversion, connection status, first-run hint, an http/mixed-content
  warning.
- German and English throughout, following the phone language.
- `?demo=1` with labelled sample data and no network.
- Example server (`examples/shoot-day-server.mjs`) with a bilingual web
  terminal, and an MCP server (`examples/dreh_mcp.py`).

### Changed (compared with the private version)
- Every screen is drawn on one three-container page and updated in place
  instead of rebuilding list containers on every change.
- Double tap in the menu asks the system before leaving (exit mode 1); inside
  a module it returns to the menu.
- No built-in addresses: the server is entered on the phone. The example server
  binds to `127.0.0.1`, needs a `TOKEN` beyond it, and compares it in constant
  time. The speech recogniser is configured with `WHISPER_URL`.
- Every network request has a timeout; only one load per list runs at a time,
  and replies that arrive after leaving a module are dropped.
- The microphone closes after 15 s, when leaving a module, and when the app
  closes; a cancelled recording is never sent.
- The web terminal builds its tables from DOM nodes, so notes and names are
  never interpreted as HTML.
- Neutral example project and packing-list template.
