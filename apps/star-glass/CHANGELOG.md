# Changelog

## [0.4.6] — 2026-10-17

### Behoben (Hardware-Protokoll)

- **Beenden-Dialog: 4/5 direkt nach dem Aufruf sind Anzeigen/Schließen des Dialogs, nicht „App im Vordergrund/Hintergrund“.** Am Gerät gemessen: nach `shutDownPageContainer(1)` kommt Ereignis 4 (FOREGROUND_ENTER), wenn der Dialog erscheint, und 5 (FOREGROUND_EXIT), wenn er nach „Nein“ wieder weg ist; bei „Ja“ folgt erst 5, rund 0,5 s später 7. Die App liest das jetzt so: bei 4 bleibt sie still (nichts wird über den Dialog gezeichnet), bei 5 kommt die Seite sofort und ohne Geste wie beim ersten Start zurück. Dabei wird nichts pausiert oder gestoppt, Timer, Polls und Streams laufen weiter.
- Ein 2× auf der Startseite, das ankommt, während die App sich im Hintergrund glaubt, holt die App zurück und fragt danach erneut (es wird nicht mehr verschluckt); es wartet dafür auf den Wiederaufbau der Seite.

## [0.4.5] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.4.4] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.

## [0.4.3] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

## [0.4.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): seine Klicks kommen auf der Brille nie an, und Halten öffnet sonst das Menü statt die App zu erreichen. Die Seiten tragen kein `menuObject` mehr; der Menücode und der `menuItemClickEvent`-Handler bleiben, damit es wieder eingeschaltet werden kann.
- Halten öffnet wieder die Hilfe (2× geht zurück), die Fußzeile sagt wieder `Halten = Hilfe`. Neu laden bleibt auf Tippen (wo die Steuerung nicht offen ist). Die Wischrichtung (normal/umgekehrt) gibt es nur noch am Handy.

## [0.4.1] — 2026-10-15

### Behoben

- Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben; jetzt hat jeder Aufruf an die Brille ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s), danach gilt der Aufruf als fehlgeschlagen und die Seite wird beim nächsten Zeichnen neu aufgebaut.

## [0.4.0] — 2026-10-14

### Geändert (QIS v1.2)

- **Seitenmenü**: Halten öffnet das Menü der Brille (`menuObject` auf jeder Seite, Klicks über `menuItemClickEvent`, wie Babel und Quiet Hub) mit **Hilfe**, **Neu laden** und **Wischen: normal / umgekehrt**. Der Wischschalter speichert `invertScroll` und baut die Seite einmal neu auf (die Beschriftung nennt den Zustand); er wirkt auch am Handy. Halten selbst öffnet die Hilfe nicht mehr, die Fußzeile sagt `Halten = Menü`. Die Hilfe-Seite öffnet sich aus dem Menü, 2× geht zurück.
- **Keine HTTP-Codes auf der Brille**: Bridge-Fehler heißen dort `Serverfehler` (Wetter: `Wetter: Serverfehler`), ebenso die Meldung „nicht gesendet“. Der Statuscode (`Fehler (HTTP 503)`) steht nur am Handy.
- **Demo beim ersten Start** (v1.2 Nr. 7): ohne Bridge-Adresse läuft eine simulierte Aufnahmenacht mit der Hinweiszeile `Demo · Verbindung am Handy einrichten` (schmale Spalte: `Demo · am Handy einrichten`) statt der leeren Einrichtungsseite; die Kopfzeile trägt die Marke `DEMO`. Das Wetter bleibt echt (Standort des Handys oder eingetippte Koordinaten); Standort und Wetterstation der Demo-Nacht werden dafür nicht benutzt. `?demo=1` ist unverändert und zeigt keine Hinweiszeile. Am Handy bleibt „Erster Start“ mit der Anleitung.
- Handy: die Bedienungs-Tabelle nennt das Menü bei „Halten“.
- Tests: Menü auf jeder Seite samt Beschriftungen (höchstens 32 Byte), Menü-Hilfe, Menü-Wischschalter (speichert, baut einmal neu auf, kehrt die Richtung um), Menü „Neu laden“, Hinweiszeile auf allen Nachtseiten in beiden Sprachen und Spaltenbreiten, keine Statuszahl auf der Brille, Halten allein tut nichts.

## [0.3.0] — 2026-10-14

### Geändert

- **Bedienung nach QIS v1** (Quietglass Interaction Standard, `docs/BEDIENSTANDARD.md`): Kopfzeile `STARGLASS · Seite · Zustand` (Warnungen behalten die ganze Zeile, wenn der App-Name nicht mehr passt), Fußzeile immer in der Reihenfolge Tippen → Wischen → Halten → 2× und mit `2× = Ende` bzw. `2× = zurück` am Schluss (gemeinsamer `footer()`-Helfer; ist die Zeile zu breit, entfällt zuerst der Wischen-Teil).
- **Sequenz anhalten / fortsetzen**: Tippen wählt vor, die Fußzeile wechselt zu `Nochmal tippen = anhalten · Wischen/2× = abbrechen`; ein zweiter einzelner Tipp innerhalb von **4 s** (vorher 6 s) führt aus. Wischen, 2× oder 4 s ohne Eingabe brechen ab; 2× bricht dabei nur ab und geht nicht zugleich zurück.
- **Hilfe-Seite**: Halten öffnet sie, 2× schließt sie (zurück). Sie listet die Gesten und was die App braucht.
- Handy-Tabs in der festen Reihenfolge **Nacht · Wetter · Brille · Verbindung · Mehr** (Bridge-Adresse und Token wandern in „Verbindung“); die Bedienungs-Tabelle nennt „Halten“ und „2×“.

## [0.2.1] — 2026-10-13

### Geändert

- Handy-Seite in Tabs statt einer langen Spalte: Nacht · Wetter · Brille · Mehr (Tab-Leiste unten, gewählter Tab bleibt), Status-Chip mit dem Verbindungsstand oben.

## [0.2.0] — 2026-10-13

### Neu

- **Wetter-Warnungen für die Aufnahmenacht.** Neue Seite „Wetter“ (Seite 2): Wolkenverlauf der nächsten 12 h als Grafik (Grenze gestrichelt, Regenrisiko als Streifen darunter), daneben „Klar bis ~02:30“ bzw. „Bewölkt · klar ab ~03:00“, Wolken jetzt mit tiefen/mittleren/hohen Schichten, Regen, Taupunkt-Abstand, Wind/Böen, SQM und Safety-Monitor.
- Warnungen erscheinen kurz oben über jeder Seite (wie die bestehenden Meldungen): Wolken kommen („Wolken in ~40 min (75 %)“), Regenrisiko, Regen (Sensor), Taugefahr (Temperatur − Taupunkt ≤ 2 °C), Wind/Böen ≥ 30 km/h. Mit Hysterese; dieselbe Warnung höchstens alle 30 min als Einblendung. Danach bleibt sie als Hinweis in der Übersicht und auf der Wetter-Seite.
- N.I.N.A. zuerst: Wetterstation (ASCOM ObservingConditions: Wolken, Regenrate, Feuchte, Taupunkt, Wind, Himmelsqualität) und Safety-Monitor werden über die Bridge gelesen; „unsicher“ ist eine rote Meldung (`! N.I.N.A.: unsicher`).
- Vorhersage von Open-Meteo (kostenlos, ohne Schlüssel) für die nächsten Stunden. Standort: aus N.I.N.A. (wenn die Bridge ihn mit `STAR_SITE=1` teilt), sonst am Handy eingetragene Koordinaten, sonst einmal der Handy-Standort. Koordinaten werden auf 2 Nachkommastellen (~1 km) gerundet.
- Handy-Seite: Wetter-Warnungen an/aus, Grenzwerte (Wolken %, Regen %, Tau °C, Wind km/h) und Koordinaten einstellbar.
- Bridge: liest `equipment/weather/info` und `equipment/safetymonitor/info` (Wind m/s → km/h); `STAR_SITE=1` teilt den Standort gerundet (aus Montierung oder Profil). Ohne den Schalter bleibt der Standort wie bisher privat.
- Demo (`?demo=1`) mit Wetterstation und einer Nacht, in der Wolken aufziehen.

### Geändert

- Fünf statt vier Seiten: Übersicht, Wetter, Guiding & Fokus, Ausrüstung, letztes Bild.
- Netzwerk-Freigabe um `https://api.open-meteo.com` erweitert (öffentlich und privat); optionale Berechtigung „location“.

## [0.1.1] — 2026-10-13

### Fixed

- The page on the glasses survives a restart of the app.
- A command without an answer says "Ergebnis unklar – Status wird geprüft" and checks N.I.N.A. at once.
- Leaving through the system stops polling and the animation; coming back rebuilds the page.

### Changed

- Footer counts the real number of pages and names the swipe: `1/4 · Wischen = Seite · Tippen = steuern · 2× = Ende`.

## [0.1.0] — 2026-10-13

### Added

- First version: N.I.N.A. imaging status on the Even G2 through the Star Glass bridge (`examples/star-bridge.mjs`, Node, no dependencies) and the Advanced API plugin.
- Four pages by swiping: overview (exposure ring with countdown, target, filter, frame n/m), guiding & focus (RMS and HFR as large numbers with history), equipment (camera cooling, mount tracking/alt/az, meridian flip and pier side, focuser, filter, guider), last frame (288 × 144 grayscale preview).
- Alerts in the header: sequence finished, guiding lost, cooling off or drifting, meridian flip soon/now, camera or mount disconnected, N.I.N.A. errors.
- Animated telescope sign in the top-right corner (exposing / idle / problem / offline).
- Optional stop / resume of the sequence, only with `STAR_ALLOW_CONTROL=1` and a login on the bridge, and only after a second tap.
- Bridge: Tailscale login allow-list (`STAR_TAILSCALE_USERS`) or token, CORS preflight 204 without body, no site coordinates or file paths in the status, optional websocket for faster updates.
- Private builds: `VITE_STAR_URL` sets the bridge address; an empty field uses it.
- Demo mode `?demo=1` with scenes `flip`, `lost`, `warm`, `done`; `&page=n` opens a page.
