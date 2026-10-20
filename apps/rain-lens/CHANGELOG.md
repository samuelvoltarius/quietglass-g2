# Changelog

## [0.8.0] — 2026-10-20

### Geändert (QUS v1 „keine Textwand“)

- **Handy: genau drei Tabs in einer Zeile** (Jetzt / Prognose / Einstellungen). Vorher vier Tabs, die auf zwei Zeilen umbrachen. „Ort“, „Brille“ und „Mehr“ sind in Einstellungen aufgegangen: Ort-Karte (eingeklappt, sobald ein Ort funktioniert; „Erweitert“ für Koordinaten), Brille (Wischrichtung, Gesten eingeklappt), Cockpit (Böen-Warnung), Sprache, Info.
- Beim Erststart steht in Einstellungen eine Drei-Schritt-Checkliste (Standort, Wetter lädt, Brille); ohne Standort läuft die Beispiel-Vorhersage.
- Jetzt: Statusbanner, Hero-Karte mit einem großen Wert, Kennzahlen, ein Knopf, Stundenleiste. Prognose: die Tage.
- **Brille: Kopfzeile `RAINLENS · Ansicht · ● live`** (bzw. `demo`), unten eine Hinweiszeile. Der Ortsname steht im Cockpit und am Handy.
- Vorschau-Bilder des Cockpits: `store/preview-cockpit.png` (+ `-warn`), erzeugt mit `QG_PREVIEW=1 npx vitest run tests/preview.test.ts`.
- Unverändert: kein Seitenmenü, Beenden-Dialog, begrenzte Aufrufe, Neuaufbau der ersten Seite.

## [0.7.7] — 2026-10-17

### Behoben (Hardware-Test)

- **Beenden-Dialog: die Systemereignisse 4/5 direkt nach dem Aufruf werden als Anzeigen/Schließen des Dialogs gelesen.** Hardware-Protokoll: 4 = der Dialog ist aufgegangen (es wird nichts gezeichnet), 5 = der Dialog ist weg (nach „Nein“ war die App nie weg). Nach „Nein“ kommt die Seite sofort und ohne Geste wieder; Timer, Polls und Streams laufen ununterbrochen weiter, nichts wird pausiert.
- Ein 2× auf der Startseite, während die App sich im Hintergrund glaubt, holt sie zurück und fragt den Dialog erneut (er wartet auf den Wiederaufbau), statt zu verpuffen.

## [0.7.6] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.7.5] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.

## [0.7.4] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

## [0.7.3] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Die Klicks aus dem Menü kommen auf der Brille nie an, und Halten öffnet bei einer Seite mit Menü nur das Menü. Die Seiten (Wetter, Radar, Cockpit) tragen kein `menuObject` mehr; der Menü-Code und der `menuItemClickEvent`-Handler bleiben für später.
- Halten zeigt wieder die Hilfe (2× geht zurück). Fußzeile wieder `Tippen = neu · Wischen = Ansicht · Halten = Hilfe · 2× = Ende`.
- Aktualisieren: Tippen lädt neu (wie bisher). Wischrichtung umkehren: nur am Handy (Reiter Brille), auf der Brille ohne Geste.

## [0.7.1] — 2026-10-15

### Behoben

- Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben; jetzt hat jeder Aufruf an die Brille ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s), danach gilt der Aufruf als fehlgeschlagen und die Seite wird beim nächsten Zeichnen neu aufgebaut.

## [0.7.0] — 2026-10-14

### Geändert (QIS v1.2)

- **Seitenmenü**: Halten öffnet jetzt das Menü der Brille (`menuObject` auf jeder Seite: Wetter, Radar, Cockpit; Klicks über `menuItemClickEvent`, wie Babel und Quiet Hub) mit **Hilfe**, **Aktualisieren** und **Wischen: normal / umgekehrt**. Der Schalter für die Wischrichtung kippt `invertScroll`; die Beschriftung nennt den Zustand, deshalb baut sich die Seite dabei einmal neu auf. Halten selbst öffnet die Hilfe nicht mehr; die Fußzeile sagt `Halten = Menü`.
- Die Hilfe-Seite wird aus dem Menü geöffnet, 2× geht weiter zurück zur Ansicht. Ihre Zeile heißt `Halten = Menü (Hilfe, Wischen)`.
- **Fehler ohne Zahlen auf der Brille**: ein gestörter Wetterdienst zeigt auf der Brille nur `Wetterdienst gestört.`; der Statuscode steht nur am Handy (`… (Code 503)`).
- Handy-Tabs unverändert `Wetter · Ort · Brille · Mehr`: RainLens spricht mit keinem eigenen Server, daher bewusst kein Tab „Verbindung“ (v1.2 Nr. 6) und keine Demo-Hinweiszeile (v1.2 Nr. 7).
- README: Bedienung auf Tippen/Wischen/Halten/2× umgestellt (kein „Doppeltippen“ mehr).
- Tests: Menü auf jeder Seite samt Beschriftungen (höchstens 32 Byte in allen fünf Sprachen), Halten allein öffnet nichts, Menü-Hilfe, Menü-Wischschalter baut die Seite einmal neu auf, Menü-Aktualisieren lädt neu, keine Statuszahl auf der Brille.

## [0.6.0] — 2026-10-14

### Geändert

- **Bedienung nach QIS v1** (Quietglass Interaction Standard, `docs/BEDIENSTANDARD.md`): Kopfzeile `RAINLENS · Ansicht · Ort` (Radar: `RAINLENS · RADAR  Ort  Zeit`), Fußzeile immer in der Reihenfolge Tippen → Wischen → Halten → 2× und mit `2× = Ende` bzw. `2× = zurück` am Schluss (gemeinsamer `footer()`-Helfer; ist die Zeile zu breit, entfällt zuerst der Wischen-Teil, dann das Halten – auf dem Radar bleibt die Quellenangabe stehen). Tippen lädt nur neu und Wischen wechselt nur die Ansicht (auch durch die Radarbilder): nichts auf der Brille löscht, stoppt oder sendet etwas, deshalb gibt es keine Bestätigungs-Geste. 2× fragt weiter nach dem Beenden der App.
- **Hilfe-Seite**: Halten öffnet sie über jeder Ansicht (auch Radar und Cockpit), 2× geht zurück zur Ansicht; Tippen und Wischen tun dort nichts.
- **Wischrichtung umkehren** (Handy, neuer Tab „Brille“): gilt für alle Ansichten und bleibt gespeichert. Bisher wurde die Einstellung in RainLens nicht beachtet.
- Handy-Tabs: **Wetter · Ort · Brille · Mehr** (Wischrichtung, Bedienung und Böen-Warnung des Cockpits wandern in „Brille“). RainLens hat keinen eigenen Server, daher gibt es keinen Tab „Verbindung“; die Ortswahl bleibt unter „Ort“.
- Fehler- und Hinweisseiten nennen den Zustand in der Kopfzeile (`RAINLENS · kein Standort`) und lassen das „Tippen = nochmal“ der Fußzeile.

## [0.5.0] — 2026-10-13

### Neu

- **Cockpit-Ansicht** als letzte Ansicht im Wisch-Kreis: der ganze Bildschirm als vier Bild-Kacheln (2 × 2 à 288 × 144) mit echten Proportionalschriften in mehreren Größen.
  - Links das Radar (privater Build, `VITE_RADAR=1`) in eigenem Ausschnitt mit Fadenkreuz für deinen Standort, gestricheltem Entfernungsring samt km-Angabe, Nordpfeil und Windrichtungs-Zeiger; darunter die Loop-Leiste (letzte Stunde durchgezogen, nächste Stunde gestrichelt mit dem Regen je Viertelstunde) und „HH:MM · Ort“. Ohne Radar (öffentlicher Build) ein großes Piktogramm des aktuellen Wetters.
  - Rechts: Kopfzeile mit App-Name und Uhrzeit, darunter groß die Antwort auf „Wann regnet es?“ – „REGEN IN ~25 MIN“, „REGNET JETZT“, „TROCKEN BIS 18:00“, „TROCKEN“ (bei Schnee nach Wettercode „SCHNEE IN ~… MIN“ / „SCHNEIT JETZT“) – aus Open-Meteo `minutely_15=precipitation` (ab 0,1 mm je Viertelstunde = Regen, ohne Viertelstundenwerte aus den Stundenwerten). Dann kleine Beschriftung, großer Wert: TEMP, GEFÜHLT, FEUCHTE / HIMMEL, WIND, BÖEN / REGEN 2 H, WARNUNG.
  - **Amtliche Warnungen für Österreich** von GeoSphere Austria (`warnungen.zamg.at`, öffentlich, CORS offen): höchste Stufe mit Art, z. B. „▲ STURM (gelb)“; außerhalb Österreichs oder ohne Verbindung „–“.
  - **Böen-Warnung** (Handy, Tab „Mehr“, standardmäßig aus): ab der gewählten Stärke zeigt WARNUNG „▲ BÖEN 72“, wenn in der nächsten Stunde solche Böen erwartet werden.
  - Tippen spielt den Radar-Loop einmal ab und kehrt zum Standbild zurück; Wischen wechselt die Ansicht, Doppeltippen beendet.
  - Nur geänderte Kacheln gehen über Bluetooth: die Uhr kostet eine Kachel pro Minute, der Radar-Loop nur die linken zwei.
- **Vollbild-Baukasten** `src/screen/` (zum Kopieren in andere Quietglass-Apps): 576 × 288-Graustufenbild, Aufteilung in vier Kacheln, Sender, der nur geänderte Kacheln schickt, Text über das Canvas der WebView (`fillText`, Alpha → Graustufe) mit Größen, Gewicht, links/rechts/zentriert und „…“ bei zu langem Text, 5 × 7-Pixelschrift als Ersatz (Tests ohne Canvas), Linien, gestrichelte Linien, Rechtecke, (gestrichelte) Kreise, Dreiecke, Pfeil, Fadenkreuz, PNG-Encoder ohne Canvas.
- Vorschau: `node scripts/cockpit-preview.mjs` → `docs/cockpit-preview.png`.

### Geändert

- Die Vorhersage lädt zusätzlich `minutely_15` (12 Stunden) und stündliche Böen.
- Grundkarte und Radarbild lassen sich für einen beliebigen Kartenausschnitt zeichnen (Radarseite unverändert).

## [0.4.3] — 2026-10-13

### Geändert

- Handy-Seite in Tabs statt einer langen Spalte: Wetter · Ort · Mehr (Tab-Leiste unten, gewählter Tab bleibt), Status-Chip mit dem aktuellen Ort oben. Ohne Standort öffnet sich zuerst „Ort“. „Erweitert“ ist jetzt eine normale Karte im Tab „Mehr“.

## [0.4.2] — 2026-10-13

### Added

- The forecast refreshes itself every 15 minutes (and on return to the app when it is older); the footer says how old it is ("Stand 14:05").

### Fixed

- The page on the glasses (now / hours / days / radar) survives a restart of the app.
- Leaving through the system stops the radar loop and the refresh; coming back rebuilds the page.

### Changed

- Footer in one style: `Tippen = neu · Wischen = Seite · 2× = Ende`.

## [0.4.1] — 2026-10-13

### Added

- Radar page (private build): a base map under the rain, offline from embedded Natural Earth 1:10m data (public domain) for Europe: country borders (dotted), coastline, larger lakes, major rivers and place names in a 5 x 7 pixel font with a black halo. Names are chosen by population with a collision test (at most 14, never over the cross or each other). The map is dim (levels 2…3), rain is remapped to 6…15, and lines under rain are cut black into it. The nearest town is named in the header.
- The map is on screen as soon as the place is known, also while the radar loads ("Radar lädt …") or when it cannot be reached ("Radar nicht erreichbar · Tippen = neu"); before the first GPS fix the page says "Standort wird gesucht …".

### Changed

- The base map is drawn once per place, zoom and language and reused for every frame; tiles without rain keep their key and are not sent again.
- The radar loop steps only once the glasses have the previous frame, so a slow Bluetooth link slows the animation instead of mixing tiles of different frames.

### Fixed

- Robustness on real glasses: gesture handlers are registered before the first page and before the location request; the phone location is capped at 10 s; a radar load is capped at 30 s and then shows the retry hint; an image transfer that never answers no longer blocks all later images (10 s timeout in the image lane); tile decoding falls back from `createImageBitmap` to an `<img>` from a blob URL on a plain `<canvas>` (no OffscreenCanvas needed).
- The base map data lives only in the radar chunk; the public build carries none of it.

## [0.4.0] — 2026-10-13

### Added

- Animated rain radar as a fourth view (swipe): RainViewer tiles, 2 x 2 image containers around your place, six frames looping every 700 ms (only while the page is open), range rings at 100 and 200 km, your place as a pixel cross. The page shows "Radar: RainViewer". Private build only: built with VITE_RADAR=1 and packed with app.private.json (adds the RainViewer origins); the public build has no radar. RainViewer allows private and educational use only.
- ?demo=1 uses a fixed place (and a made-up radar if the service cannot be reached).

### Fixed

- Pictures (icons, chart) no longer vanish: the page is created once per run and later only rebuilt, and all images are resent after every rebuild.

## [0.3.3] — 2026-10-13

### Changed

- Body text beside the icon column gets 46 characters per row (was 38); header and footer use the full 56 characters, so hourly and daily lines and German/French/Spanish/Italian texts are cut later.

## [0.3.2] — 2026-10-13

### Fixed

- Start language: the Even app's WebView reports English even on a German phone.
  An explicit language choice is now kept in the SDK store; without one, a German-speaking
  Even account country (AT/DE/CH/LI/LU) starts the app in German.

## [0.3.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

All notable changes to RainLens are documented here.
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

