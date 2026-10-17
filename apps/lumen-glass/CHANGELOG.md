# Changelog

## [0.7.6] — 2026-10-17

### Behoben (Hardware-Test)

- **Beenden-Dialog: die Ereignisse 4/5 direkt nach dem Aufruf sind der Dialog selbst.** Am Gerät gemessen: ca. 150 ms nach `shutDownPageContainer(1)` kommt FOREGROUND_ENTER (4) = der Dialog ist da; bei „Nein“ kommt FOREGROUND_EXIT (5) = der Dialog ist weg (die App war nie weg); bei „Ja“ kommt 5 und ca. 0,5 s später SYSTEM_EXIT (7). Die App liest 4/5 nach dem Aufruf jetzt so: bei 4 wird nichts gezeichnet, bei 5 steht die Seite sofort wieder da, ohne dass eine Geste nötig ist. Das Abfragen wird dabei nicht mehr pausiert (vorher stoppte das 5 den Poll).
- Ein 2× auf der Startseite fragt den Dialog danach wieder, direkt beim ersten Mal.

## [0.7.5] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.7.4] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.

## [0.7.3] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

## [0.7.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Die Klicks im Menü kommen auf der Brille nie an, und Halten öffnet sonst das Menü statt die App zu erreichen (Schrittprotokoll 15.10.2026). Die Seiten tragen kein Menü mehr; Menücode und `menuItemClickEvent`-Handler bleiben, damit es wieder eingeschaltet werden kann.
- Wischen öffnet wieder die Hilfe (nochmal wischen, Tippen, Halten oder 2× schließen sie; Wischen aktualisiert dabei die Motte wie vorher). Wischen bricht außerdem eine offene Rückfrage ab.
- Halten merkt wieder „Neue Quest“ vor (sie ersetzt eine offene): ein einzelnes Tippen innerhalb von 4 s holt sie, Wischen, 2×, ein zweites Halten oder 4 s ohne Eingabe brechen ab.
- Fußzeile „Tippen = Foto · Wischen = Hilfe · Halten = Quest · 2× = Ende“, Hilfetexte der Brille (de/en) und Hinweise am Handy beschreiben wieder die Gesten statt des Menüs. Die Versionsangabe in „Mehr“ am Handy stimmt wieder (stand noch auf 0.7.0).
- Tests: Seiten ohne `menuObject`, Wischen öffnet die Hilfe, Halten merkt die neue Quest vor und ein Tippen holt sie.

## [0.7.1] — 2026-10-15

### Behoben

- Die Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben. Jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s); danach wird die Seite neu aufgebaut.

## [0.7.0] — 2026-10-14

Bedienung nach QIS v1.2 (Audit 14.10.2026).

### Geändert (QIS v1.2)

- **Seitenmenü der Brille** (`menuObject`, Klicks über `menuItemClickEvent`; Vorlage Babel Glass): `Hilfe` und `Neue Quest`. Die Hilfe hängt nicht mehr an Wischen. „Neue Quest“ (früher Halten) ist im Menü und bleibt scharf geschaltet: der erste Klick merkt vor („Nochmal tippen = neue Quest · Wischen/2× = abbrechen“), ein einzelnes Tippen oder ein zweiter Klick auf denselben Menüpunkt innerhalb von 4 s holt sie, Wischen, 2× oder 4 s ohne Eingabe brechen ab.
- **Wischen tut nichts mehr** außer eine offene Rückfrage abzubrechen oder die Hilfe zu schließen; es öffnet keine Hilfe und holt keine Daten. Halten ist dem Menü der Brille überlassen.
- **Foto senden bleibt Tippen:** der Auslöser der Handy-Kamera ist die Bestätigung, gesendet wird erst danach.
- **2× während der Aufnahme** öffnet die Systemfrage zum Beenden, ohne die Aufnahme zu beenden. Wird das Beenden bestätigt, wird ein danach ausgelöstes Foto nicht mehr gesendet; wird abgebrochen, läuft die Aufnahme normal weiter und das Foto wird nach dem Auslösen gesendet.
- **Ohne Fachwörter auf der Brille (v1.2 Nr. 8):** „HTTP 500“ und Ausnahmetexte erscheinen nicht mehr; die Brille sagt „LUMEN meldet einen Fehler“. Die technische Meldung steht im Handy-Tab „Mehr“.
- **Erster Start = Demo (v1.2 Nr. 7):** Ohne gespeicherte Adresse (und ohne eingebauten Server) zeigt die App Beispieldaten mit der Zeile „Demo · Verbindung am Handy einrichten“, schickt nichts ins Netz und öffnet die Kamera nicht (Tippen zeigt, wie eine erledigte Quest aussieht, „Neue Quest“ wechselt die Beispiel-Quest). Sobald am Handy eine Adresse gespeichert wird, endet die Demo. Am Handy trägt der Chip „Demo“ und ein Hinweis zum Tab „Verbindung“. `?demo=1` bleibt für Vorführungen.
- Fußzeile `Halten = Menü` statt `Wischen = Hilfe · Halten = Quest`; Hilfeseite und Handy-Tabelle beschreiben das neue Verhalten. Sprachwechsel am Handy baut die Brillenseite neu auf (das Menü trägt die Sprache).

## [0.6.0] — 2026-10-14

### Geändert (QIS v1)

- Bedienung nach dem Quietglass-Bedienstandard (QIS v1, `docs/BEDIENSTANDARD.md`).
- **Sicherheit:** Eine neue Quest ersetzt die offene. Halten ersetzt sie nicht mehr selbst (vorher: zweimal Halten), es fragt nur („Nochmal tippen = neue Quest · Wischen/2× = abbrechen“); ein einzelnes Tippen innerhalb von 4 s holt die Quest, Wischen, 2×, nochmal Halten oder 4 s ohne Eingabe brechen ab. Ein Tippen unmittelbar nach dem Halten (unter 0,4 s, das Loslassen selbst) zählt nicht. Auch ohne offene Quest fragt Halten erst nach.
- Wischen holt keine Daten mehr nebenbei und ändert nichts: es öffnet die Hilfeseite (nochmal Wischen schließt sie und aktualisiert die Motte).
- 2× geht eine Ebene zurück (Hilfe schließen, Frage abbrechen, Ergebnis verlassen), ganz außen öffnet es die Systemfrage zum Beenden; während das Foto gesendet wird, tut 2× nichts. Das Foto selbst wird erst nach dem Auslösen der Handy-Kamera gesendet; Tippen öffnet nur die Kamera.
- Kopfzeilen `LUMEN · Zustand` auf allen Seiten, Fußzeilen über den gemeinsamen `footer()`-Helfer in der Reihenfolge Tippen/Wischen/Halten/2× mit `2× = Ende` bzw. `2× = zurück`. Lichtbalken, Serie und Lichtfenster („Gold in 24 min“) stehen jetzt als letzte Zeile im Text statt in der Fußzeile.
- Neue Hilfeseite (Wischen) mit den Gesten und dem, was die App braucht. Es gibt keine Liste, also gilt `invertScroll` nur noch der Form halber; der Schalter ist jetzt im Handy-Tab „Brille“ und wirkt sofort.
- Handy-Seite: Tabs `Motte · Brille · Verbindung · Mehr`. „Brille“ hat Wischrichtung und Sprache, „Verbindung“ Adresse und Anmeldung, „Mehr“ Bedienung, Version und Datenschutz. „2×“ statt „Doppeltippen“.

## [0.5.2] — 2026-10-13

### Geändert

- Handy-Seite in Tabs statt einer langen Spalte: Motte · Lumen · Mehr (Tab-Leiste unten, gewählter Tab bleibt), Status-Chip „verbunden/offline“ oben. Die Sprachwahl steht jetzt unter „Mehr“.

## [0.5.1] — 2026-10-13

### Changed

- **The verdict shows right away:** a photo now goes to `/quest/<id>/abgeben?format=json` as a normal CORS request with `Accept: application/json` (and the token as Bearer). A current LUMEN answers with JSON, so the glasses say "Quest erledigt" or show LUMEN's reason for a rejection without a second request. The "no-cors" workaround is gone; when the answer cannot be read (an older LUMEN without CORS on that route), `/api/status` still decides whether the quest was ticked off.
- **Sign-in on the phone page:** for a LUMEN in closed mode, enter name and password; the app asks LUMEN for a session token (`POST /api/anmelden`), keeps only that token in its own storage and sends it as `Authorization: Bearer`. The password is never stored. "Sign out" ends the session on LUMEN (`POST /api/abmelden`) and forgets the token. The manual token field is gone.
- LUMEN's own limit messages (too many submissions, file too large) are shown instead of a bare HTTP code.

## [0.5.0] — 2026-10-13

### Fixed

- **LUMEN was unreachable from the WebView:** every request went out with `credentials: "include"`, and LUMEN's CORS answer allows no credentials, so the browser discarded each answer (measured in Chromium against the real server: `include` fails, `omit` gets 200). Requests now go without credentials; the `Cookie` header (forbidden in fetch, never sent) is gone, a token travels as `Authorization: Bearer`.
- **Photo upload:** LUMEN's upload route answers with a redirect to an HTML page and has no CORS, so a readable upload always failed although the photo arrived. It is now sent as a "no-cors" form post with 90 s instead of 8 s (LUMEN judges the photo while the request is open), and `/api/status` tells whether the quest was ticked off ("Quest erledigt" or "Gesendet, aber nicht abgehakt").
- Gestures are wired before the first page and the first status request: an unreachable LUMEN no longer leaves the glasses deaf for up to 8 s, not even to the double tap.
- A reconnect or a return to the foreground rebuilds the page even when nothing changed (it stayed blank before). A moth image that does not arrive no longer rebuilds the whole page in a loop.
- Leaving through the system stops polling and the wing beat; coming back rebuilds and refreshes. A system exit or crash stops everything.

### Changed

- Holding with a quest open only arms "new quest" (the footer says "Nochmal halten = neue Quest (ersetzt diese)"); a second hold within 4 s replaces it. Without a quest one hold is enough.
- Private builds take their server from `VITE_LUMEN_URL`; an empty or old default address (`http://127.0.0.1:8077`) is replaced by it.
- Wording: "Tippen = nochmal · 2× = Ende", "Keine Quest. Halten = neue Quest.", "{n} Tage" instead of "{n} T.", "Zugangsschlüssel (Token)" instead of "Sitzungs-Cookie".

## [0.4.0] — 2026-10-13

### Changed

- The ASCII moth is gone from the body: the task text gets the whole body (three more rows).
- The pixel moth in the header corner beats its wings once a second while the moth is awake; other states stand still. The image is only sent when the wings change (every 500 ms at most).
- The page is created once per run and later only rebuilt (images are resent after every rebuild).

## [0.3.5] — 2026-10-13

### Fixed

- Start language: an explicit choice is kept in the Even SDK store (the WebView's localStorage may not survive a relaunch); without one, a German-speaking Even account country (AT/DE/CH/LI/LU) starts the app in German, even when the WebView reports English.

## [0.3.4] — 2026-10-13

### Changed

- The pixel moth moved from beside the text to the top-right corner of the header; the body now uses the full display width (56 characters per row).

## [0.3.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

All notable changes to Lumen Glass are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-10-07

### Added

- German and English UI.
  - Follows the phone's language (English otherwise); switch it at the top of
    the phone page and the glasses redraw at once. The choice is remembered.
  - Glasses text fits beside the pixel moth in both languages (37 columns,
    7 rows); the footer drops the streak, then the gesture hint, before it
    would overflow. The session cookie moved under "Advanced".

### Changed

- Store readiness: system exit dialog, privacy policy.
  - A double tap on the root screen now opens the system exit dialog
    (`shutDownPageContainer(1)`). Cancel and the app carries on unchanged;
    timers, streams and sensors stop only after you confirm. A failed call
    is caught and leaves the app running.
  - The glasses header now reads "Lumen Glass", matching the store name.
  - `docs/PRIVACY.md` covers every permission in `app.json`, with a German
    summary, and is linked from the README.
  - Store art in `store/` (icon, 24 px monochrome icon, background,
    tagline), generated by `tools/store-art.mjs`.

## [0.1.0] — 2026-09-25

First release.

### Added
- The LUMEN moth on the glasses, in five states matching LUMEN's own
  thresholds, drawn so the wings carry the state before any word is read.
- LUMEN's own wording for what the moth is doing, passed through rather than
  reinvented, so the glasses and the web app never disagree.
- The current quest with its actual instruction, not just its short name.
- Minutes until the next golden or blue hour — the one number that actually
  gets someone out the door.
- Photo capture through the phone camera, submitted straight to LUMEN as
  multipart/form-data on the same endpoint its own web form uses.
- The same action as a button in the phone companion, for when the phone is
  already in hand.
- Video quests are flagged on the display, because a still camera cannot
  answer them and finding that out after shooting is worse.
- Light bar and streak in the status line.
- Session cookie support for LUMEN in closed mode, sent as a header and never
  shown in full.
- CORS proxy and a documented three-line patch for LUMEN, either of which lets
  the browser hand LUMEN's answers to the app.
- 49 unit tests, using a status payload copied from a running LUMEN rather
  than invented.

### Verified against a live LUMEN
Field names were read from a running instance, not guessed. Two would have
been wrong: the light window is `naechstes_lichtfenster`, and a quest carries
both a short `titel` and the actual `aufgabe`.

### Known limitations
- LUMEN needs CORS headers or the included proxy; see examples/PATCH.md. The
  failure mode is misleading — "unreachable" while curl works fine — and
  `allow_origins=["*"]` does not fix it, because the app sends credentials.
- Video quests can be seen but not answered from the glasses.
- Feed, shop and series stay on the phone.
- Not yet verified on physical hardware.
