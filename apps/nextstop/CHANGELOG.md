# Changelog

## [0.9.6] — 2026-10-22

### Neu: eigener Kartenserver (Overpass) am Handy

Am 22.10.2026 antworteten die öffentlichen Overpass-Server mit 406 oder gar nicht – die Gehkarte zeigte nur die Route.

- **Einstellungen → Erweitert → „Eigener Kartenserver (Overpass)“** (optional). Gespeichert wird die Adresse mit `/api/interpreter`; leer = öffentliche Server.
- **Reihenfolge:** eigener Server vom Handy → Server des privaten Builds (`VITE_OVERPASS_URL`) → öffentliche Server. Ist ein eigener Server nicht erreichbar, werden die öffentlichen gefragt.
- Eine geänderte Adresse gilt ab der nächsten Abfrage, ohne Neustart; fehlgeschlagene Straßen werden dann neu geladen.
- `app.json`: Whitelist zusätzlich `https://*` (wie Klipper Glance / Sugar Glass), die festen Origins bleiben.

## [0.9.3] — 2026-10-21

### Geändert: nichts mehr nur per Halten (Hardware-Messung 21.10.2026)

Halten (LONG_PRESS 9/10) erreicht die App nur vom optionalen R1-Ring (`eventSource 2`); am Bügel-Touchpad öffnet Halten das System-Menü. Store-Prüfer testen ohne Ring – darum ist jetzt alles mit Tippen, Wischen und 2× erreichbar, und keine Brillen-Fußzeile oder -Hilfe bietet „Halten/Hold“ mehr an.

- **Startseite mit drei Einträgen (QUS v1):** **Abfahrten**, **Ziel per Sprache**, **Ziele und Route**. Wischen wählt, Tippen öffnet; Fußzeile `Tippen = öffnen · Wischen = wählen · 2× = Ende`.
- **Ziel per Sprache per Tippen:** Antippen startet die Aufnahme, das nächste Tippen beendet und sendet sie (`Tippen = fertig · 2× = zurück`). Ein Tippen innerhalb von 0,6 s nach dem Start zählt nicht (Doppel-Ereignis der Firmware). Die Aufnahme endet spätestens nach **15 s** von selbst (vorher 30 s als Notbremse für ein fehlendes Loslassen). 2× in der Aufnahme bricht ab und öffnet die Zielliste.
- **Fehlerseiten der Spracheingabe:** Tippen = nochmal aufnehmen (Zu kurz, Nichts verstanden, Kein Ort, Mikrofon, Netz); ohne Spracherkennungs-Server geht Tippen nur zurück. Die Hinweise sagen „Tippen und …“ statt „Nochmal halten …“.
- **Leere Zielliste:** Tippen = Ziel sagen.
- **Begleitung vorzeitig beenden:** im ersten Schritt nach oben wischen, dann nochmal tippen (Wischen/2×/4 s brechen ab). Bisher ging das nur per Halten.
- **Ring-Extra bleibt:** Mit dem R1-Ring startet Halten weiterhin die Aufnahme (Loslassen = fertig) bzw. fragt in der Begleitung nach dem Beenden – wird auf der Brille aber nirgends angeboten.
- **Fußzeilen-Baustein (`src/footer.ts`):** kennt kein `hold` mehr; Tafel-Hinweis `1/4 · Tippen = folgen · Wischen = wählen · 2× = zurück`, leere Tafel `2× = zurück`.
- **Handy:** Gestentabelle mit eigener Zeile „Ziel per Sprache“ und „Ring: Halten“ nur als Zusatz; Whisper-Hinweis, Zielhinweis und Route-Anleitung angepasst.
- **Store/Doku:** `app.json`-Mikrofonbeschreibung, `store/listing.json`, `docs/PRIVACY.md`, README ohne „Touchpad halten“; `store/screenshot.png` ist jetzt die aktuelle Abfahrtstafel (die alte Simulator-Aufnahme zeigte „Hold = destination“). Beenden-Dialog (Abschnitt 1a) unverändert.
- **Tests:** Startseite per Wischen+Tippen bis zum Treffer (Echo-Tippen ignoriert), Selbststopp nach 15 s, Wiederholen per Tippen, leere Zielliste, Begleitung per Hochwischen beenden, und ein Wächter: keine Brillen-Zeichenkette und keine Fußzeile enthält „Halten/Hold/loslassen/release“.

## [0.9.1] — 2026-10-20

### Neu

- **Straßennamen auf der Karte der Fußseite.** Die Namen kommen aus Overpass (`name`, sonst die erste `ref`; Fußwege ohne). Zuerst die Straße der nächsten Abbiegung (hell), dann die Straße, auf der du gehst, dann bis zu vier weitere benannte Straßen gedimmt; höchstens 6, ohne Überlappung, nie über Standortmarke, Ziel, Maßstabsbalken oder Nordnadel, immer waagerecht lesbar (die Karte dreht, die Schrift nicht). Platzierung aus OpenGlance Nav (`labels.ts`) übernommen.
- Zeile 2 unter der Überschrift ist die Straße der nächsten Anweisung („LINKS · 80 M“ / „IN LINZER GASSE“), sonst die Straße, auf der du gehst. Haltestelle bzw. Ziel stehen dafür in einer eigenen Zelle (HALT / ZIEL).
- Tests: Platzierung (Straße der Abbiegung und aktuelle Straße zuerst, keine Überlappung, aufrecht bei jeder Drehung, höchstens 6), Parser behält Namen, Überschrift und Zeile 2. Vorschauen neu mit Straßennamen.

## [0.9.0] — 2026-10-20

### Neu: Karte auf den Fußwegen der Begleitung (QUS v1)

- **Die Fußseite der Begleitung ist jetzt ein Cockpit-Bild** (vier Kacheln 288×144) statt Pfeil und Text. Links eine **kleine Karte** (die zwei linken Kacheln, über der Hinweiszeile): Straßen gedimmt (Hauptstraßen 8, Nebenstraßen 6, Fußwege 4), der Rest des Wegs als dicke helle Linie (15) auf schwarzem Rand, die Haltestelle als Ring, das Ziel als Quadrat (liegt es außerhalb des Bildes, zeigt ein Pfeil am Rand zu ihm), du selbst als Pfeilspitze (die Karte dreht sich mit dem Weg, „Weg nach oben“) bzw. als Punkt mit Ring, wenn keine Richtung bekannt ist (dann Norden oben). Maßstab in Stufen von 150 m bis 1,2 km Breite, so gewählt, dass der Rest des Wegs ins Bild passt; Maßstabsbalken und Nordnadel.
- Rechts klein `NEXTSTOP  HH:MM`, **eine** große Überschrift („LINKS · 80 M“, „HALTESTELLE · 320 M“, „ZIEL · 120 M“), darunter die Straße bzw. der Haltestellenname, dann drei Spalten: **WEG** (Rest), **ABFAHRT** (Zeit der Verbindung, die du erreichen willst; bei Fußweg zum Ziel **ANKUNFT**), **PUFFER** (Minuten Reserve, mit Rahmen unter 2), **LINIE**, **STEIG**. Die Hinweiszeile bleibt die der Begleitung (`1/5 · GPS · Tippen = weiter · 2× = Ende`). Warte-, Fahrt- und Ankunftsseiten sind unverändert.
- **Sparsam gesendet:** Positionsänderungen zeichnen die Karte nur neu, wenn sich die Ansicht merklich bewegt hat (ab 8 m, ab 10° Drehung oder bei einem Maßstabssprung) und höchstens alle 4 s; die Uhr berührt nur die Kachel oben rechts. Karten-Kacheln werden nie gesendet, solange der Beenden-Dialog offen sein kann, und nicht mehr, wenn die Seite verlassen wurde.
- **Straßen aus OpenStreetMap (Overpass):** einmal je Fußetappe für einen Rahmen um die Etappe (+ 220 m Rand) geladen und gemerkt; höchstens 8 s insgesamt, zwei Endpunkte (`overpass-api.de`, `overpass.private.coffee`), Antwortgröße begrenzt. Schlägt das Laden fehl oder dauert es zu lange, wird die Karte mit Weg und Markierungen ohne Straßen gezeichnet – die Begleitung wartet nie darauf. Kein anderes Netzziel. Im Demo-Modus gibt es keine Straßen (kein Netz).
- **Netz-Whitelist** in `app.json`: `https://overpass-api.de` und `https://overpass.private.coffee` ergänzt, Beschreibung des Netzwerk-Rechts nennt jetzt die Kartenstraßen.
- Entfernt: die Seitenart „walk“ (Pfeil, Entfernungskarte, Straßenstreifen) der Begleitung; ohne Wegführung oder Standort bleibt die Fußseite Text wie bisher.
- Tests: Kamera, Projektion, Wegrahmen, Überschrift und Zellen (reine Funktionen), Kachel-Diff (unverändert sendet nichts, kleine Bewegung keine Karten-Kachel, Uhr nur oben rechts), Overpass (Parser, zweiter Endpunkt, Fehler, Zeitgrenze), Zeichnen ohne Straßen, Beenden-Dialog-Schutz im laufenden Programm. Vorschau: `QG_PREVIEW=1 npx vitest run tests/walkmap.test.ts` schreibt `store/preview-walk.png` und `store/preview-walk-transfer.png` (Straßen aus einer festen, **synthetischen** Vorlage, ohne Netz).

## [0.8.0] — 2026-10-20

### Geändert (Quietglass-UI-Standard QUS v1, „keine Textwand“)

- **Brille: Startseite mit zwei großen Einträgen.** Kopfzeile `NEXTSTOP · ● live` (bzw. `Demo`, `kein Standort`, `offline`), darunter **Abfahrten** und **Ziele und Route**, eine Fußzeile. Wischen wählt, Tippen öffnet, Halten sagt ein Ziel, 2× beendet (System-Dialog). Die Abfahrtstafel ist eine Ebene darunter: 2× geht zurück zur Startseite. Das Hilfe-Zeilchen am Ende der Abfahrtsliste entfällt (Hilfe ist keine Brillenseite mehr; das Seitenmenü bleibt aus, `SIDE_MENU = false`).
- **Brille: Abfahrtstafel als Cockpit-Bild** (Renderer aus Rain Lens, `src/screen/*` unverändert kopiert): rechts klein `NEXTSTOP  HH:MM`, **eine** große Überschrift („BUS 3 · 4 MIN“) mit der Richtung darunter, drei Spalten mit Danach, Steig, Verspätung, Halt, Weg, Abfahrt; links ein Countdown-Ring, der sich füllt, je näher der Bus kommt (gestrichelt bei Verspätung, blass bei Ausfall); eine Hinweiszeile (`1/4 · Tippen = folgen · Wischen = wählen · Halten = Ziel · 2× = zurück`). Gesendet werden nur die Kacheln (4 × 288×144), deren Pixel sich geändert haben; die Uhr berührt nur die Kachel oben rechts.
- **Brille: eine verfolgte Fahrt hat dieselbe Cockpit-Seite** (Titel `FOLGEN · ● live`, Überschrift: Minuten bis zum Bus bzw. nächster Halt, Ring als Countdown, Zellen für Danach, Ziel, Ankunft, Quelle GPS/Fahrplan, eine Hinweiszeile). So baut das Antippen einer Abfahrt die Seite nicht neu auf. Das Beenden der Fahrt bleibt scharf gestellt (tippen, dann nochmal tippen); 2× in der laufenden Fahrt öffnet den System-Dialog, ohne zu beenden.
- **Unverändert:** die grafische Begleitung (Pfeil/Entfernung, Countdown mit Bus, „noch N Stationen“), Abbruch-Dialog-Logik (`src/exit.ts`, Hintergrund-2×), alle `bounded()`-Zeitgrenzen, der Aufbau der ersten Seite (Rebuild + Create), Standort, Sprache (STT) und Sprachausgabe (TTS).
- **Handy: genau drei Tabs in einer Zeile – Jetzt, Fahrten, Einstellungen** – im Aussehen von Rain Lens: Kicker `QUIETGLASS / ÖFFIS`, Titel, Status-Pille, Statusbanner, Hero-Karte mit **einem** großen Wert (nächste Abfahrt), Kennzahlen 2×2 (Steig, Verspätung, Weg, Abfahrt), **ein** Hauptknopf (Aktualisieren) und eine waagerechte Kartenleiste mit den weiteren Abfahrten. „Fahrten“ trägt die Ziele (Suche, Favoriten, „Jetzt“-Ziel). „Einstellungen“ sind gruppierte, einklappbare Karten (Brille und Sprache, Quelle und Server, Bedienung); beim ersten Start stehen sie offen mit einer Drei-Schritte-Liste, danach sind sie zu. Ohne Standort zeigt „Jetzt“ Beispieldaten und sagt es.
- Tests: reine Modelltests (Zellen, Überschrift, Startzeilen, Hinweiszeile, Ring), Kachel-Diff (unveränderter Frame sendet nichts) und Vorschau-PNGs (`QG_PREVIEW=1 npx vitest run tests/preview.test.ts` schreibt `store/preview-cockpit*.png`).

## [0.7.7] — 2026-10-17

### Behoben (Hardware-Test)

- **Beenden-Dialog: die Ereignisse 4/5 direkt nach dem Aufruf sind der Dialog selbst.** Am Gerät gemessen: ca. 150 ms nach `shutDownPageContainer(1)` kommt FOREGROUND_ENTER (4) = der Dialog ist da; bei „Nein“ kommt FOREGROUND_EXIT (5) = der Dialog ist weg (die App war nie weg); bei „Ja“ kommt 5 und ca. 0,5 s später SYSTEM_EXIT (7). Die App liest 4/5 nach dem Aufruf jetzt so: bei 4 wird nichts gezeichnet, bei 5 steht die Seite sofort wieder da, ohne dass eine Geste nötig ist. Nichts wird pausiert: GPS, Mikrofon, Timer und Abfragen laufen durchgehend weiter (vorher schickte das 5 die App in den Hintergrund).
- Ein 2× auf der Startseite oder in der laufenden Führung, das ankommt, während die App sich im Hintergrund glaubt (echtes 5 ohne Dialog), holt die App zurück und fragt den Dialog danach wieder (nach dem Wiederaufbau der Seite), statt verschluckt zu werden.

## [0.7.6] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.7.5] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.
- Beim Systemende (Ereignis 6/7) wird die Begleitung wie bisher beim Bestätigen beendet; der nächste Start beginnt auf der Tafel.
## [0.7.4] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

## [0.7.3] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Die Klicks im Menü kommen auf der Brille nie an, und Halten öffnet sonst das Menü statt die App zu erreichen (Schrittprotokoll 15.10.2026). Die Seiten tragen kein Menü mehr; Menücode und `menuItemClickEvent`-Handler bleiben, damit es wieder eingeschaltet werden kann.
- Die Abfahrtsliste endet wieder mit dem Eintrag „Hilfe“: Wischen bis ganz unten, Tippen öffnet die Hilfe, Tippen oder 2× schließt sie.
- Halten in der Begleitung merkt „Fahrt abbrechen“ vor (wie vorher das Menü „Begleitung beenden“): ein einzelnes Tippen innerhalb von 4 s beendet die Begleitung, Wischen, 2×, ein zweites Halten oder 4 s ohne Eingabe brechen ab. Halten auf der Abfahrtstafel sagt weiter das Ziel.
- Hilfetexte der Brille (de/en) und die Hinweise am Handy („Route planen“ jetzt: Halten und Ziel sagen, 2× in der Aufnahme öffnet die Zielliste) beschreiben wieder die Gesten statt des Menüs.
- Nur mit dem Menü erreichbar, ohne Gesten-Ersatz: „Andere Haltestelle“, „Neu laden“ (die Tafel lädt von selbst nach), „Neu suchen“ bei fertiger Verbindungsliste, „Als Favorit merken“ (Favoriten legst du am Handy an).
- Tests: Seiten ohne `menuObject`, Hilfe als letzte Listenzeile, Halten in der Begleitung merkt das Abbrechen vor und ein Tippen führt es aus.

## [0.7.1] — 2026-10-15

### Behoben

- Die Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben. Jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s); danach wird die Seite neu aufgebaut.

## [0.7.0] — 2026-10-14

### Changed (QIS v1.2)

- Conforms to QIS v1.2 (`docs/BEDIENSTANDARD.md`, audit 2026-10-14).
- Help is only in the side menu: the last list row "Hilfe" is gone (swiping stops at the last departure), and every page menu (board, goals, connections, voice, guide) now carries "Hilfe". Closing the help returns to the page it was opened from, so a running guide or a plan is no longer dropped by a look at the help; on the help page the menu entry reads "Schließen".
- The menu entries "Neu suchen" (connections) and "Als Favorit merken" (voice) are armed like every risky action: the first click changes the footer to `Nochmal tippen = <Aktion> · 2× = abbrechen`, a second click on the same entry or a single tap within 4 s carries it out; swipe, 2× or 4 s without input cancel. "Begleitung beenden" takes a second menu click as confirmation, too.
- Glossary: the armed row for a followed ride / guide says `Nochmal tippen = Fahrt abbrechen · 2× = abbrechen` instead of "beenden"; the help line was changed likewise.

## [0.6.0] — 2026-10-14

### Changed (QIS v1)

- Conforms to the Quietglass Interaction Standard (QIS v1, `docs/BEDIENSTANDARD.md`).
- Safety: a single tap no longer ends a running ride, and a double tap no longer ends the guide. Ending a followed ride, ending the guide (menu entry "Begleitung beenden") and "search again" after a missed bus are **armed**: the first action changes the footer to `Nochmal tippen = beenden · Wischen/2× = abbrechen`, a second single tap within 4 s carries it out; swipe, hold, 2× or 4 s without input cancel. 2× is only back (help -> board, connections -> goals -> board); on the departure board and during a guide it opens the system exit dialog (which can be declined). The menu entry "Neu laden" no longer drops a followed ride.
- Footers come from one `footer()` helper in the order Tippen, Wischen, Halten, 2× and end in `2× = zurück` or `2× = Ende` (swipe part dropped first when the row is too wide, then the page counter, then the hold). Pages with a header read `NEXTSTOP · state`. "doppeltippen"/"tippen oder doppeltippen" are gone from the glasses; English uses Tap/Swipe/Hold/2×.
- Help page: "Hilfe" is the last entry of the departure list (one swipe past the last departure) and an entry of the board menu; it lists the four gestures plus what the app needs.
- Swipe direction: new switch "Wischrichtung umkehren" on the phone (tab "Brille", `invertScroll`, off by default) is honoured by every list; it used to be fixed to off.
- Phone tabs in the fixed order Haltestellen · Ziele · Brille · Verbindung · Mehr: the language moved to "Brille", the source and the addresses to the new tab "Verbindung".

## [0.5.1] — 2026-10-13

- Handy-Seite in Tabs statt einer langen Spalte: Haltestellen · Ziele · Brille · Mehr (Tab-Leiste unten, gewählter Tab bleibt), Status-Chip mit der gewählten Quelle oben. „Erweitert“ ist jetzt eine normale Karte im Tab „Mehr“.

## [0.5.0] — 2026-10-13

- **Live-Spracherkennung** beim Ziel per Sprache (privater Build, `VITE_LIVE_STT_URL`): die erkannten Wörter erscheinen schon beim Sprechen auf der Brille (neueste unten), beim Loslassen wird der Live-Text sofort genommen. Verbindet der Live-Server nicht binnen 3 s oder bricht ab, geht die Aufnahme wie bisher an den Sprachserver (`VITE_STT_URL`) – es geht nichts verloren.
- Aufnahme-Sicherheitsgrenze 30 s statt 8 s.

## [0.4.2] — 2026-10-13

### Fixed

- A running guide, a followed bus and the picked stop survive a restart of the app (phone locked, Even app unloaded it), for up to 2 hours; a guide until 30 minutes after its arrival. Your position is not part of it.
- Leaving through the system stops GPS, microphone, voice and refreshes; coming back rebuilds the page, restarts GPS and refreshes.
- The microphone request has a 5 s limit; a late "yes" switches it off again.
- The glasses listen before the first page is built.

### Changed

- Footers in one style (`Tippen = …`, `Halten = …`, `2× = …`); "Halte das Touchpad gedrückt", "Geh zur Haltestelle", "Am nächsten Halt aussteigen"; the plans footer no longer uses the cryptic "× = Umstiege".
- Store text describes the route, the voice destination and the hold gesture.

## 0.4.1

- Begleitung beim Fahren: Unter „noch N Stationen“ stehen die Halte jetzt als kurze Liste in Fahrtreihenfolge – nächster Halt mit Zeit („jetzt“, wenn der Bus dort ist), der Halt vor dem Ausstieg (mit „…“, wenn dazwischen noch Halte liegen) und der Ausstieg markiert: „● Mirabellplatz AUSSTEIGEN · 12:14“. Bei zwei Stationen bleiben zwei Zeilen, beim letzten nur der Ausstieg (groß und pulsierend wie bisher).
- „Danach: Umsteigen …“ steht kurz in der Fußzeile („Umstieg O-Bus 10 · 2/6 · GPS · 2× = Ende“).
- Deutsch: „Stationen“ statt „Halte“ – „noch 3 Stationen“, „noch 1 Station“, Ansage „In 2 Stationen aussteigen“ (Brille, Handy-Seite, Sprachausgabe). „Nächster Halt“ bleibt. Englisch unverändert.
- Haltestellennamen kürzer: Liegen alle Halte einer Fahrt im selben Ort, entfällt der Ortsname („Salzburg Mirabellplatz“ → „Mirabellplatz“). Gilt auch beim Verfolgen eines Busses von der Tafel aus (nächster und übernächster Halt, Endstation).

## 0.4.0

- Weniger Text, eine Sache groß: Abfahrtstafel, Bus verfolgen, Verbindungen und alle Warte-/Fehlermeldungen dieser Seiten haben jetzt dieselbe Form – Minuten als große Pixelziffern, daneben die Linie als Schild (oder die Haltestelle mit Bus), darunter Ziel bzw. nächster Halt fett über die ganze Breite, höchstens drei kurze Zeilen, kurze Fußzeile („Tippen: verfolgen · Halten: Ziel“).
- Abfahrtstafel nach der tatsächlich erwarteten Zeit sortiert; die Auswahl bleibt beim Aktualisieren auf demselben Bus. Ein fehlgeschlagenes Nachladen behält die Tafel statt sie durch eine Fehlermeldung zu ersetzen.
- Bus verfolgen: Tippen antwortet sofort („Fahrt wird geladen …“), ohne Seitenneuaufbau. Die Fahrt beginnt an deiner Haltestelle: zuerst „in N min“ bis der Bus hier abfährt und wo er gerade ist (in der letzten Minute fährt der Bus ins Bild), danach nächster Halt groß. Vorher zeigte NextStop den ganzen Fahrtverlauf des Busses – z. B. Halte weit weg oder minutenlang unverändert „Mirabellplatz · gleich“, was wie ein Hänger wirkte. Verspätungen werden während der Fahrt nachgeladen.
- Tippen wirkt immer: auch während die Fahrt noch lädt (zurück zur Tafel); Anfragen haben ein Zeitlimit von 15 s und zeigen dann eine Meldung.
- Ein Bild, das die Brille nicht annimmt, löst keinen Seitenneuaufbau mehr aus (der sonst alle 2 s Eingaben verschluckt hätte); es wird beim nächsten Zeichnen erneut gesendet.
- Begleitung: Warten und Fahren mit zwei bzw. drei kurzen Zeilen unter dem großen Bild.

## 0.3.7

- Hängt nicht mehr beim Start: Die Brille hört sofort auf Tippen, Halten (Ziel per Sprache) und Doppeltippen, auch während das Handy noch nach dem Standort fragt oder der erste GPS-Fix dauert. Der erste Standort wartet höchstens 10 s.

## 0.3.6

- Ansagen mit natürlicher Server-Stimme: Abbiegen zu Fuß, Bus kommt, Aussteigen, verpasste Verbindung, Ziel erreicht.

## 0.3.3

- Startseite: Halten = Ziel per Sprache sagen; „Andere Haltestelle“ ist jetzt im Menü.
- Ältere gespeicherte Einstellungen mit dem Platzhalter-Proxy wechseln einmal auf den ÖBB-Proxy des privaten Builds (Echtzeit ohne Handy-Einstellung).

## 0.3.2

- Annäherungsbalken beim Gehen füllt sich über das ganze Wegstück seit der letzten Abbiegung statt immer über die letzten 150 m.
- „noch N Halte“: die Zahl steht genau in der Bildschirmmitte.
- Pixelziffer 9 mit rundem unteren Bogen.

## [0.3.1] — 2026-10-13

### Changed

- The guide is now readable at a glance while walking and riding: the three stages of a
  journey have a page of their own with pictures (text cannot be made larger on the glasses).
  - **Walking** (with a walking route): a big arrow (144 x 144 image) on the left, the distance
    to the next turn in about 70 px high pixel digits (50 m steps from 200 m, 10 m below,
    "1,2 km", "jetzt" at the end), a thick approach bar underneath that fills as the turn comes
    closer and is full within 50 m, the street name in bold across the full width, and one small
    line of text: `Dann: O-Bus 2 Richtung Walserfeld · in 4 min`. The layout and the arrow shapes
    come from OpenGlance Nav 0.5.1 (same licence).
  - **Waiting at the stop**: the countdown ("2 min") in big digits, the line and direction as text,
    and next to it a bus-stop picture; in the last minute a bus drives in from the left (six
    frames, one per 500 ms beat).
  - **Riding**: "noch 2 Halte" as big pixel digits across the top, below it as text
    `Aussteigen: Mirabellplatz · an 02:06`. At the stop before the one to get off at, a pulsing
    "Aussteigen" warning (the digit flashes every 500 ms).
- Pictures are sent only when they change (rounded distance, bar step, minute, animation frame),
  and the 500 ms beat runs only while an animated page is on screen. A change of stage rebuilds the
  page with the other containers (at most 4 images, exactly one event capture); updates inside a
  stage are text and image updates only. `createStartUpPageContainer` is called once per run; every
  later page is a `rebuildPageContainer`.
- Walking without a route yet, a missed vehicle and the arrival stay plain text as before.
- A private build can carry the ÖBB proxy address (`VITE_OEBB_URL=https://… npm run build`, like
  `VITE_STT_URL`): ÖBB live data is then on by default and the field "Address of the ÖBB add-on" on the
  phone starts with it (leave it empty to return to it). Without the variable (public build) nothing
  changes: Transitous by default. Saved choices always win.
- Development: the demo takes `speed=N` (clock N times faster, up to 120) to drive through a whole
  journey on the desk simulator.

## [0.3.0] — 2026-10-13

### Added

- Route planning. On the phone, a new "Destinations" section: search for a place,
  address or stop (Transitous geocoder), save it as a favourite with a name of
  your own ("Home", "Work" …), reorder or remove favourites, or set a one-off
  "go now" destination. Stored with the SDK store and mirrored in localStorage.
- Glasses: new pages "Where to?" (destinations), connections (3–4 options from your
  position, one line each: `in 4 min · Bus 3 → O-Bus 7 · arr 14:52 · 1×`, details of the
  selected one below) and a step-by-step guide (walk to the stop, which vehicle at what time,
  "get off: …, n stops left", changes with stand and time, "arrived"). The guide works
  from GPS where there is a fix and from the clock otherwise, can be stepped by hand,
  notices a missed vehicle, refreshes the times of the next vehicles every minute and asks
  once before it is ended by double tap.
- Native contextual menu (tap and hold) per page to move between departures, destinations,
  connections and guide. The departures page and its gestures are unchanged; a double tap there
  still opens the system exit dialog.
- Voice input for the destination: hold the touchpad on the destinations page, speak, release
  (8 s at most). The recording goes as a WAV (16 kHz mono PCM) in a multipart form without custom
  headers to an OpenAI-compatible Whisper endpoint (`/v1/audio/transcriptions`); the glasses
  show "Heard: …" and up to three place hits (swipe, tap = connections, double-tap = drop, menu =
  save as favourite). The server address is a phone setting ("Advanced"); the public build has
  none, a private build can set a default with `VITE_STT_URL`. New permission `g2-microphone`.
- Guidance on every stage including the walks: turn arrow, distance to the turn, street and
  distance left, from a Valhalla pedestrian route (public FOSSGIS server, or `VITE_ROUTER_URL`),
  re-planned from the current position when the walker is more than 80 m off the route. Stages
  change by themselves ("Wait for Bus 3" at the stop, a warning one stop before getting off,
  change walk, "arrived"); every header shows the expected arrival of the whole journey.
- `?demo=1` (development): offline sample destinations, an invented connection built from a
  recorded Transitous answer, and `scene=`/`t=` to open a page directly in the simulator.

### Changed

- Network permission: `app.json` now lists exactly `https://api.transitous.org` and
  `https://valhalla1.openstreetmap.de` (walking directions). The
  wildcards `http://*` and `https://*` were blocked on the real glasses. A server of your own
  (MOTIS, ÖBB add-on, Whisper, Valhalla) needs its exact origin in a private `app.private.json`
  (git-ignored).
- Privacy text: favourites are now stored (on the phone only), see `docs/PRIVACY.md`.

### Geändert

- Route planen: Ziele am Handy anlegen (Ortssuche, Favoriten, „Ziel jetzt“), auf der Brille
  Verbindungen ansehen und Schritt für Schritt begleitet werden. Netzwerk-Freigabe nur noch
  für `https://api.transitous.org`.

## [0.2.2] — 2026-10-13

### Fixed

- Start language: the Even app's WebView reports English even on a German phone.
  An explicit language choice is now kept in the SDK store; without one, a German-speaking
  Even account country (AT/DE/CH/LI/LU) starts the app in German.

## [0.2.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

Alle nennenswerten Änderungen an NextStop.

## [0.2.0] — 2026-10-07

### Changed

- German and English UI. The language follows the phone and can be switched
  at the top of the phone page; the glasses redraw at once. The German text
  is unchanged.
- Store readiness: system exit dialog, privacy policy.
  - A double tap on the root screen now opens the system exit dialog
    (`shutDownPageContainer(1)`). Cancel and the app carries on unchanged;
    timers, streams and sensors stop only after you confirm. A failed call
    is caught and leaves the app running.
  - Location updates stop only after you confirm.
  - `docs/PRIVACY.md` covers every permission in `app.json`, with a German
    summary, and is linked from the README.
  - Store art in `store/` (icon, 24 px monochrome icon, background,
    tagline), generated by `tools/store-art.mjs`.
  - `min_app_version` raised from 2.0.0 to 2.2.10, the floor of SDK 0.0.16
    that `evenhub pack` already stamped.

### Geändert

- Transitous ist jetzt die Voreinstellung: es ist ohne Zusatzprogramm aus der
  Even-App erreichbar (CORS geprüft). ÖBB-Echtzeit bleibt als Option für
  Österreich, die Proxy-Adresse liegt unter „Erweitert“.
- `app.json` fragt nach dem Standort und erlaubt das Netzwerk; ohne die
  Standort-Berechtigung kam die App nie über „Warte auf GPS“ hinaus.
  `supported_languages` nennt jetzt Deutsch, die Sprache der App.
- Fehler und Wartezustände auf der Brille sagen in einfachen Worten, was zu
  tun ist, statt „Backend“, „Proxy“ oder rohe Browser-Fehler zu zeigen.
- Handy-App: ein Satz oben sagt, was als Nächstes zu tun ist; Quellenhinweis
  auf transitous.org/sources, wie die Transitous-Nutzungsregeln verlangen.

## [0.1.0] — 2026-09-25

Erste Fassung.

### Enthalten

- Abfahrtstafel für die Haltestelle, an der man gerade steht, per GPS gefunden.
- Fahrtverfolgung: der nächste Halt unterwegs, aus GPS und Uhr abgeleitet.
- Zwei Datenquellen, beide ohne Schlüssel: ÖBB (Österreich, mit Echtzeit) und
  Transitous/MOTIS (viele Länder, selbst hostbar).
- Herkunft jeder Zeit sichtbar — gemessen, gemeldet oder nur geplant.
- CORS-Proxy für die ÖBB, weil deren Schnittstelle keine Header schickt.

### Beim Bauen gefunden

Festgehalten, weil es beim nächsten Mal wieder Zeit kosten würde.

- **Die ÖBB-Gleisfelder heißen `dPltfS` und `dPltfR`**, nicht `dPlatf…` —
  obwohl direkt daneben ein `dPlatfCh` steht. Der Tippfehler liefert still
  ein leeres Feld statt eines Fehlers.
- **GPS findet am Mirabellplatz sechs Haltestellen**, 35 m auseinander, jede
  mit einem Bruchteil der Abfahrten. Die Dach-Haltestelle mit allen Steigen
  existiert, aber nichts im Datensatz verweist auf sie — sie wird über den
  Namen aufgelöst, der sich dabei ändern kann (Hanuschplatz →
  Ferdinand-Hanusch-Platz).
- **Die Brillen-Schrift ist proportional, nicht monospace.** Spalten per
  Leerzeichen richten nichts aus; es entsteht eine krumme Treppe.
- **`▸` zeichnet die Brille gar nicht.** Der Auswahlpfeil verschwand
  wortlos — jetzt ASCII.
- **Ein Schnitt auf feste Länge zerhackt Klammern**: „Salzburg Makartplatz
  (Aicherpass". Der Steig wird jetzt zuerst entfernt, dann gekürzt.
- **Transitous antwortet 403 ohne erkennbaren User-Agent.** Kein
  User-Agent und ein bloßes „node" werden abgewiesen.
- **Entfernung allein sagt nicht, ob ein Halt vor oder hinter einem liegt.**
  Eine frühere Fassung sprang bei 120 m weiter und meldete den übernächsten
  Halt, während der aktuelle noch durch die Scheibe zu sehen war. Das
  entscheidet jetzt der Fahrplan.
