# Changelog

## [0.5.10] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.5.8] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.

## [0.5.7] — 2026-10-16 (Store-Fassung 0.5.6)

### Behoben (Store-Prüfung)

- **Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr** (Prüfer, 16.10.): Der System-Dialog nimmt der App die Seite weg. Nach „Nein“ baut die App sie jetzt wie beim ersten Start neu auf (rebuild + create), danach kommen Gesten und das nächste 2× wieder an. Gleicher Befund wie im Navi (0.17.12).
- Adressfeld am Handy: Hinweis „Adresse aus ‚tailscale serve status‘“ statt Beispiel-Adressen (Prüfer-Hinweis zu 0.5.4).

## [0.5.3] — 2026-10-15

### Behoben (auf echter Brille gesehen)

- **Modell-Seite ohne Modell:** In der Mitte stand Buchstabensalat („M u M RUC“) – die Pixelschrift der Kacheln kennt nur Ziffern. Jetzt ein leerer Rahmen; „kein Modell“ steht wie bisher in der Kopfzeile.
- **Ohne Modell führt Wischen zurück zur Übersicht** (wie 2×), statt nichts Sichtbares zu drehen. Mit Modell dreht Wischen es weiterhin.

## [0.5.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Die Klicks im Menü kommen auf der Brille nie an, und Halten öffnet sonst das Menü statt die App zu erreichen (Schrittprotokoll 15.10.2026). Die Seiten tragen kein Menü mehr; Menücode und `menuItemClickEvent`-Handler bleiben, damit es wieder eingeschaltet werden kann.
- Halten öffnet auf dem Druckbild wieder die Hilfe; Tippen, Halten oder 2× schließen sie (2× verlässt die App dort nie). Die Fußzeilen der Druckbild-, Lade-, Offline- und Fehleransicht nennen wieder „Halten = Hilfe“ (Wischen = Modell fällt bei schmaler Zeile zuerst weg).
- Hilfetexte der Brille (de/en) und die Hinweise am Handy beschreiben wieder die Gesten statt des Menüs. Drucker steuern (Pause, weiter, abbrechen) lief schon vorher über Tippen und ist unverändert; ein Befehl braucht weiter zwei Tipper.
- Die Versionsangabe in „Mehr“ am Handy stimmt wieder (stand noch auf 0.5.0).
- Tests: Seiten ohne `menuObject`, Halten öffnet die Hilfe und Tippen/Halten/2× schließen sie, Fußzeilen mit und ohne Menü.

## [0.5.1] — 2026-10-15

### Behoben

- Die Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben. Jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s); danach wird die Seite neu aufgebaut.

## [0.5.0] — 2026-10-14

### Geändert — Bedienstandard QIS v1.2 (docs/BEDIENSTANDARD.md)

- **Seitenmenü der Brille** (Halten → Systemmenü, SDK `menuObject` / `menuItemClickEvent` wie Babel Glass und Quiet Hub): `Hilfe`. Die App hat keine eigenen Einstellungen auf der Brille, deshalb nur dieser Eintrag. Hilfe verwirft eine offen stehende Rückfrage (nichts bleibt dahinter scharf); Tippen oder 2× schließen die Seite. Die Seite trägt das Menü bei jedem Aufbau neu, ein Sprachwechsel baut sie einmal neu auf.
- **Halten öffnet keine Hilfe mehr** und steht in keiner Fußzeile mehr; auf dem Druckbild tut es nichts. Pause/Weiter/Druck abbrechen bleiben zweistufig (4 s, Wischen/2× brechen ab) – unverändert.
- **Glossar:** die Rückfrage heißt jetzt „Nochmal tippen = Druck abbrechen · 2× = abbrechen“ (vorher „Druck stoppen“). „abbrechen“ ist damit sowohl der Name der Aktion als auch das Wort für das Verwerfen der Rückfrage – wie im Standard; bei langer Zeile entfällt „Wischen/“.
- **Erster Start = Demo (wahr gemacht):** Ohne Bridge-Adresse läuft jetzt wirklich der simulierte Drucker (Kopfzeile mit `DEMO`, letzte Zeile `Demo · Verbindung am Handy einrichten`), statt eines leeren Einrichtungs-Bildschirms. Wird am Handy eine Adresse eingetragen, wechselt die App auf den echten Drucker; ohne Adresse zurück in die Demo. Der Hilfetext „Braucht: Bridge im Netz (ohne sie läuft die Demo)“ stimmt damit. `?demo=1` erzwingt die Demo weiterhin.
- **Keine HTTP-Codes auf der Brille:** „Serverfehler“ statt „Fehler (HTTP 503)“. Das Handy (Tab „Drucker“) zeigt `Serverfehler (503)`.
- Handy: Gestentabelle nennt das Seitenmenü bei Halten.
- Tests: Menü mit „Hilfe“ auf der Seite, Halten allein öffnet nichts, Menü-Hilfe verwirft eine offene Rückfrage, kein „Halten = Hilfe“ in irgendeiner Fußzeile, „stoppen“ taucht nicht mehr auf, Demo-Hinweis in beiden Sprachen, keine Statuszahl auf der Brille.

QIS-Stand: v1.2.

## [0.4.0] — 2026-10-14

### Geändert (QIS v1)

- Bedienung nach dem Quietglass-Bedienstandard (QIS v1, `docs/BEDIENSTANDARD.md`).
- **Sicherheit:** Pause, Weiter und Druck abbrechen waren schon zweistufig; jetzt strenger nach Standard: die Rückfrage verfällt nach 4 s (vorher 6 s), und Wischen oder 2× brechen sie nur ab – die Markierung bleibt stehen, 2× verlässt dabei auch den Steuern-Bildschirm nicht mehr. Erst ein einzelnes Tippen auf dieselbe Zeile führt aus.
- Fußzeile der Rückfrage: „Nochmal tippen = Pause · Wischen/2× = abbrechen“ (Druck abbrechen: „… = Druck stoppen …“).
- Wischen auf dem Druckbild öffnet weiter das Schichtmodell und dreht es dort – das ist nur eine Ansicht, nichts wird gesendet oder verändert.
- Kopfzeilen `KLIPPER · Zustand` auf allen Seiten (Einrichtung, Steuern, Modell, Hilfe), Fußzeilen über den gemeinsamen `footer()`-Helfer in der Reihenfolge Tippen/Wischen/Halten/2× mit `2× = Ende` bzw. `2× = zurück`; passt die Zeile nicht in 56 Zeichen, entfällt zuerst der Wisch-Teil.
- Neue Hilfeseite: Halten auf dem Druckbild öffnet sie (die App hat keine Liste); Tippen, Halten oder 2× schließen sie.
- `invertScroll` gilt wie bisher für Steuern und Schichtmodell (Handy-Tab „Brille“).
- Handy-Seite: Tabs `Drucker · Brille · Verbindung · Mehr` („Verbindung“ heißt jetzt der frühere Tab „Bridge“, Wischrichtung und Sprache stehen unter „Brille“, Bedienung, Version und Datenschutz unter „Mehr“). „2×“ statt „Doppeltippen“.

## [0.3.0] — 2026-10-13

### Neu

- Schicht-Viewer: Wischen öffnet ein 3D-Bild des Drucks über die ganze Breite (aus dem G-Code, von der Bridge in Schichten zerlegt). Gedruckte Schichten leuchten, die aktuelle Schicht am hellsten, die kommenden als blasser Umriss. Wischen dreht die Ansicht in 30°-Schritten, Tippen lädt neu, Doppeltippen zurück.
- Fertig-Uhrzeit: „Tempo 100 % · fertig 23:40“ (am nächsten Tag mit Wochentag).
- Spoolman: aktive Spule unter den Temperaturen, z. B. „PLA · Prusament · 412 g“ (über Moonrakers Spoolman-Anbindung, nur lesend).
- Bridge: `GET /api/printer/model?file=…` (G-Code wird einmal gestreamt gelesen, auf 40 000 Linien ausgedünnt; 202 solange er vorbereitet wird), Status mit `z` (Düsenhöhe) und `spool`.

## [0.2.3] — 2026-10-13

### Neu

- Vorschaubild statt Ring: Hat die Druckdatei ein Slicer-Vorschaubild (OrcaSlicer, PrusaSlicer, Cura …), zeigt die Brille links das Modell. Der schon gedruckte Teil leuchtet von unten nach oben (nach Schicht), der Rest bleibt blass; darunter Prozent und Balken. Ohne Vorschaubild bleibt der Ring.
- Bridge: `GET /api/printer/thumb?file=…` liefert das Vorschaubild (PNG, größtes bis 400 px) aus den Moonraker-Metadaten; ältere Bridges ohne den Endpunkt zeigen einfach den Ring.

## [0.2.2] — 2026-10-13

### Geändert

- Handy-Seite in Tabs statt einer langen Spalte: Drucker · Bridge · Brille (Tab-Leiste unten, gewählter Tab bleibt), Status-Chip mit dem Verbindungszustand oben. Sprachwahl und Datenschutz stehen jetzt unter „Bridge“, „Scroll umkehren“ unter „Brille“.

## [0.2.1] — 2026-10-13

### Added

- Private builds carry the bridge address (`VITE_KLIPPER_URL`): nothing to type on the phone. A stored placeholder (loopback, example host) gives way to it once.

### Fixed

- The glasses listen before the first page is built.
- A command without an answer says "Ergebnis unklar – Status wird geprüft" (it may have run) and checks the printer at once.
- Leaving through the system stops polling; coming back rebuilds the page and polls at once.

### Changed

- Footers in one style (`Tippen = …`, `2× = Ende`); "Fortsetzen gesendet".

## [0.2.0] — 2026-10-13

### Added

- While a printer is online the HUD shows a progress ring (144 x 144 image) at the left with the percentage in large pixel digits, the file, layer, remaining time and speed beside it, and below them the nozzle temperature of the last five minutes as a curve (288 x 64 image) with nozzle and bed temperatures next to it. The ring is only resent when the percentage changes, the curve only with a new reading.
- Offline, control and setup screens keep the plain text page; changing between the two layouts is a page rebuild.
- `?demo=1&pct=73` starts the demo print at 73 % in the simulator.

### Fixed

- Page set-up on the glasses: one `rebuildPageContainer`, then exactly one `createStartUpPageContainer`; every later page is a rebuild.

## [0.1.4] — 2026-10-13

### Changed

- Glasses rows use the full display width (56 instead of 46 characters).
- Progress bar is 22 glyphs wide (was 20) so it fills the row next to the percentage.

## [0.1.3] — 2026-10-13

### Fixed

- Start language: an explicit choice is kept in the Even SDK store (the WebView's localStorage may not survive a relaunch); without one, a German-speaking Even account country (AT/DE/CH/LI/LU) starts the app in German, even when the WebView reports English.

## [0.1.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

All notable changes to Klipper Glance are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-10-07

First public release, brought over from a private printer HUD and rebuilt on
Quietglass conventions.

### Added
- Print status on the glasses: file, progress bar, layer, time left, nozzle and
  bed temperatures, speed and the printer's own message.
- Stale readings are marked in the header after 15 s.
- Optional control (pause, resume, cancel), offered only for the current state;
  every command needs a confirming second tap, a swipe drops it, and it lapses
  after 6 s.
- Phone page: bridge address and optional token (write-only), language, swipe
  inversion, printer state, whether control is allowed, http/mixed-content
  warning.
- German and English throughout, following the phone language.
- `?demo=1` with a simulated printer.
- Example bridge (`examples/klipper-bridge.mjs`) and mock Moonraker
  (`examples/mock-moonraker.mjs`).

### Changed (compared with the private version)
- No built-in addresses: the bridge is entered on the phone. The bridge binds to
  `127.0.0.1` by default and searches the machine's own private networks
  instead of a fixed subnet; the search runs in the background.
- Control needs `KL_ALLOW_CONTROL=1` and, beyond loopback, a `TOKEN`, compared
  in constant time. CORS answers preflights with or without a token.
- Double tap on the HUD asks the system before leaving (exit mode 1); on the
  control screen it returns to the HUD.
- The bridge speaks English field names and reason codes, so the app can word
  them in either language.
- One screen updated in place; requests time out after 6 s and never overlap.
