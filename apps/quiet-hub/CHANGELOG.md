# Changelog

## [0.9.6] — 2026-10-17

### Behoben (Hardware-Schrittprotokoll)

- **Beenden-Dialog: Ereignis 4 und 5 direkt nach dem Aufruf sind das Erscheinen und Schließen des Dialogs, nicht die App.** Am Gerät gemessen: `shutDownPageContainer(1)` liefert `true` nach ca. 60 ms (nur „Aufruf angenommen“), FOREGROUND_ENTER (4) kommt ca. 150 ms später, wenn der Dialog aufgeht, und FOREGROUND_EXIT (5), wenn er nach „Nein“ wieder verschwindet; bei „Ja“ folgt auf die 5 nach ca. 0,5 s das Systemende (7). Die App liest 4 nach dem Aufruf jetzt als „Dialog steht“ (nichts wird darübergezeichnet) und 5 als „Dialog weg“: nach „Nein“ kommt die Seite sofort ohne Geste wieder, Timer, Polls und Streams laufen unverändert weiter, nichts wird pausiert. Mikrofon-Audio und Ereignis 8 lassen den Dialogzustand unberührt. Ein 2× auf der Startseite fragt danach sofort wieder.

## [0.9.5] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.9.4] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.

## [0.9.3] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

## [0.9.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Die Klicks aus dem Menü kommen auf der Brille nie an, und Halten öffnet bei einer Seite mit Menü nur das Menü (auch das Sprechen auf der Agent-Seite und die Zuhause-Details waren damit nicht erreichbar). Die Seiten tragen kein `menuObject` mehr; der Menü-Code und der `menuItemClickEvent`-Handler bleiben für später.
- Halten tut wieder, was es vor dem Menü tat: in der Sitzung sprechen, bei Licht/Rollo die Details, sonst aktualisieren.
- Hilfe: wieder die letzte Zeile der Übersicht („Hilfe — Bedienung“); jede Geste schließt sie.
- Sprachnotiz verwerfen: Halten auf der Abschrift schärft das Verwerfen („Nochmal tippen = verwerfen“), ein Tippen verwirft, Wischen/2×/Zeit brechen ab. Fußzeile der Abschrift: `Tippen = senden · Halten = verwerfen · 2× = zurück`.
- Nur am Handy (hatte nie eine Geste): „Ruhe während der Agent arbeitet“ und „Alle Meldungen gelesen“.

## 0.9.1 — 2026-10-15
### Behoben
- Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben; jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s), danach wird die Seite neu aufgebaut.

## 0.9.0
QIS v1.2 (Quietglass Interaction Standard, `docs/BEDIENSTANDARD.md`, Abschnitt „QIS v1.2 rulings“) – Quiet Hub ist jetzt konform.
- **Zuhause-Detail: Wischen schaltet nie mehr** (v1.2 #5). Halten auf Licht oder Rollo öffnet wie bisher das Detail; dort wechselt Wischen nur noch zum nächsten Licht/Rollo derselben Liste (Raum bzw. Favoriten, rundum; die Listenauswahl folgt, 2× landet auf dem Gerät). Tippen öffnet eine kleine Auswahl: Licht `Aus · 30 % · 60 % · 100 %` (dazu `An`, wenn das Licht keine Helligkeit meldet – evtl. nur an/aus), Rollo `Auf · Zu · Stopp`. Wischen wählt darin, Tippen führt aus, 2× schließt ohne Aktion. Dieselben Daemon-Aufrufe wie vorher (`brightness` 0/30/60/100, `turn_on`, `open`/`close`/`stop`). Schlösser, Alarm und Garage: unverändert zweistufig, ohne Detail. Fußzeile `Tippen = Auswahl · Wischen = Gerät · 2× = zurück`, in der Auswahl `Tippen = ausführen · Wischen = wählen · 2× = zurück`. Menü-Eintrag heißt jetzt „Details“.
- **2× verwirft keine Aufnahme mehr** (v1.2 #2). 2× während der Aufnahme beendet sie, behält sie und geht eine Ebene zurück (Gespräch → Sitzungen, aus einer Meldung → Übersicht); Hinweis „Sprachnotiz bleibt · im Gespräch senden“. Auch 2× auf „Verstanden: …“ geht zurück und behält die Abschrift. Öffnet man das Gespräch wieder, steht sie da; Tippen sendet. Eine neue Aufnahme überschreibt sie nicht („Sprachnotiz wartet · erst senden/verwerfen“).
- **Verwerfen ist eine geschärfte Aktion** (v1.2 #3): Brillen-Menü auf der Abschrift = `Verwerfen · Hilfe`. Der erste Klick schärft („Nochmal tippen = verwerfen · Wischen/2× = abbrechen“), ein Tippen oder ein zweiter Klick innerhalb 4 s verwirft. Wischen, 2× oder 4 s ohne Eingabe brechen ab; dann sendet Tippen wie gewohnt.
- **Hilfe nur noch im Seitenmenü** (v1.2 #1): die letzte Zeile „Hilfe — Bedienung“ der Übersicht entfällt (fünf Seitenzeilen, darunter zwei Hinweiszeilen). „Hilfe“ steht in jedem Brillen-Menü.
- **Erster Start = Demo** (v1.2 #7): ohne Server-Adresse zeigt die Brille die Demo-Daten mit der Zeile `Demo · Verbindung am Handy einrichten` statt einer leeren „nicht verbunden“-Seite. Sobald am Handy ein Server gespeichert ist, gilt nur noch der echte Hub (keine Demo-Daten mehr, ein Fehler zeigt sich sofort); wird die Adresse gelöscht, kommt die Demo zurück. `?demo=1` bleibt die Demo ohne Hinweis.
- **Fehler ohne Codes** (v1.2 #8): eine fehlgeschlagene Aktion meldet „Fehlgeschlagen: Hub meldet einen Fehler“ statt „Hub-Fehler 500“; der genaue Fehler steht im Handy-Tab „Mehr“ (Technisch).
- **Wörter** (v1.2 #9): Zuhause-Hinweise rechts mit „=“ statt Doppelpunkt („Tippen = an/aus“, „Halten = Details“). Handy: „2× = Seitenwahl“ statt „2× tippen“/„double tap“, die Sprachnotiz-Zeile nennt 10 min und „2× = zurück, die Sprachnotiz bleibt“; der Zuhause-Tab erklärt Detail und Auswahl. Demo-Antwort ohne „Doppeltippen“.
- Tests: `tests/qis12.test.ts` (Aufnahme behalten, Verwerfen geschärft, Hilfe, Demo-Hinweis, keine HTTP-Codes, Glossar) und `tests/zuhause.test.ts` (Auswahl je Licht/Rollo, Wischen wechselt nur das Gerät, **kein Wischen löst je einen Home-Assistant-Aufruf aus** – Liste, Raum, Detail, Auswahl).

## 0.8.2 – Nachtrag: Daemon-Beispiele (ohne neue App-Version) – Termine für OpenGlance
- **Termine mit Koordinaten.** Jeder Termin im Kalenderblock von `/brief` trägt `startIso` (ISO mit Offset der `BRIEF_TZ`) und `allDay`; findet die Ortssuche seinen Ort, außerdem `lat`, `lon`, `placeLabel`. Gleicher Ortsspeicher wie das Wetter am Terminort (7 Tage); gleichzeitige Fragen nach demselben Ort teilen sich eine Anfrage. Die Ortssuche wartet höchstens 3 s; das Wetter wartet nicht auf sie.
- **Neuer Endpunkt `GET /brief/appointments`** (gleiche Anmeldung wie `/report`): nur `{date, at, status, events}`, für die Navigations-App OpenGlance. Aus der letzten Liste, solange sie jünger als 2 min ist (auch aus einem vollen `/brief`), sonst Kalender + Ortssuche neu – kein Wetter, keine anderen Blöcke, eine Abfrage zur Zeit. Ohne Kalenderquelle `status: "off"`, Kalender weg `status: "error"` mit leerer Liste, `BRIEF=off` → 404.
- Koordinaten und Titel stehen in keinem Protokoll. Tests: `tests/brief-appointments.test.mjs`.
- Die Brillen-App (`src/`) ist unverändert; Deploy = `examples/quiet-hub-brief.mjs` und `examples/quiet-hub-daemon.mjs` + Neustart des Daemons.

## 0.8.2
Tagesstart: das Wetter folgt dir – und deinen Terminen.
- **Wetter am aktuellen Standort.** Die App fragt das Handy beim Laden des Tagesstarts nach dem Standort (gleicher Weg wie Shoot Day: Brücke `getAppLocation`, Berechtigung `location` in `app.json` mit ehrlicher Beschreibung). Gerundet auf 2 Nachkommastellen (~1 km), 30 min gemerkt, 4 s Zeitlimit – der Tagesstart wartet nie länger und geht sonst ohne Koordinaten los. Gesendet als `GET /brief?lat=..&lon=..` (`refresh=1` geht weiter). `BRIEF_LAT`/`BRIEF_LON` sind jetzt nur noch der **Ausweichort**; ohne beides bleibt „Wetter“ aus. Der Wetterblock meldet `place: "here"|"default"`, die Brille zeigt „Wetter hier“ bzw. „Wetter (Standard)“.
- **Daemon:** `lat`/`lon` werden geprüft (Zahlen, −90..90 / −180..180, beide oder keins; sonst `400`), erneut auf ~1 km gerundet, Wetter je gerundetem Ort ~2 min zwischengespeichert. Koordinaten stehen **nicht** im Zugriffsprotokoll (es enthält keinen Query).
- **Wetter am Terminort.** Heutige Termine mit Ort (ICS `LOCATION`, Shoot-Day-Projektort; Online-Links/Zoom werden übergangen) bekommen die Vorhersage zur Terminstunde, bis zu 3, z. B. `10:30 Musterdorf 9° · Regen 60%` (Wind ab 30 km/h). Termine < 10 km vom Standort bekommen keine Zeile, eine Vorhersage je Ort (~10 min gemerkt). Der Ort wird mit der Open-Meteo-Ortssuche (`BRIEF_GEOCODE_URL`) gefunden: ganzer Text, dann Teil nach dem letzten Komma, dann Ort ohne PLZ; nur der Ortstext verlässt den Daemon; Treffer 7 Tage im Speicher.
- **Neue Quelle Shoot Day** (`BRIEF_SHOOT_URL`, optional `BRIEF_SHOOT_TOKEN`): heutige Projekte (Datum `2026-10-14 10:30`, `2026-10-14`, `14.10.2026 10:30`) als „Kunde – Projekt“, mit den ICS-Terminen gemischt und sortiert; gleiche Zeit + ähnlicher Titel zählt einmal. Ein Ausfall von Geokodierung, Vorhersage oder Shoot Day lässt die anderen Blöcke unberührt.
- **Handy-Tab „Tagesstart“:** eine Zeile sagt, ob der Standort genutzt wird; ohne Freigabe: „Standort nicht freigegeben – Wetter für den Standardort“.
- Neue Berechtigung im Paket: `location`. (`app.private.json` ist nicht Teil des Repos und braucht denselben Eintrag.)

## 0.8.1
QIS v1 (Quietglass Interaction Standard, `docs/BEDIENSTANDARD.md`) – Quiet Hub ist jetzt konform.
- **Sicherheit: 2× stoppt nie mehr.** In der Agent-Sitzung (auch aus einer Meldung geöffnet) geht 2× nur noch zurück. Stoppen ist eine bewusste Aktion: Tippen auf den laufenden Agenten (oder Menü „Stoppen“) schärft sie, die Fußzeile sagt „Nochmal tippen = stoppen · Wischen/2× = abbrechen“, ein zweites Tippen innerhalb von 4 s stoppt. Wischen, 2× oder 4 s ohne Eingabe brechen ab (die Fußzeile kommt von selbst zurück). Beendet der Agent inzwischen, passiert nichts.
- **Freigabe-Karten, Menü Erlauben/Ablehnen:** Tippen schärft nur die gewählte Zeile (Erlauben, Ablehnen oder eine vLLM-Antwort), erst das zweite Tippen auf dieselbe Zeile sendet. Wischen wählt und entschärft; 2× lässt die Karte unbeantwortet offen. Das Brillen-Menü wählt die Zeile und schärft sie, der Tipp danach sendet. Home-Assistant-Schloss/Alarm/Garage: das zweite Tippen gilt ebenfalls nur 4 s (vorher bis 10 s).
- Schon vorher zweistufig und unverändert: Drucker pausieren/abbrechen, Gerät schalten (alte Daemons). Bewusst nicht geschärft: Frage aus der Vorschlagsliste senden (die Frage steht markiert da, Hauptaktion), bestätigte Sprachnotiz senden (Abschrift wird erst angezeigt), Licht/Szene im Zuhause, Rollo-Stopp im Detail.
- **Fußzeilen und Kopf:** Kopf `QUIET HUB · Seite · Zustand`, Fußzeile immer in der Reihenfolge Tippen → Wischen → Halten → 2×, endet mit `2× = zurück` (Unterseite) bzw. `2× = Ende` (Übersicht). Gebaut mit dem gemeinsamen `footer()` (`src/glasses/footer.ts`); ist die Zeile zu breit, entfällt zuerst „Wischen“, dann „Halten“. Wörter nach Glossar: „2×“, „Tippen/Wischen/Halten“, englisch Tap/Swipe/Hold/back/exit. Tests prüfen jede Seite in Deutsch und Englisch auf Reihenfolge, Ende und Breite.
- **Hilfe:** letzter Eintrag der Übersichtsliste (Tippen öffnet), außerdem in jedem Brillen-Menü. Die Seite nennt Tippen, Wischen, Halten, 2× in dieser Reihenfolge, Menü/Ring und „Braucht: Hub-Daemon“. Der Hinweis auf wartende/arbeitende Agenten auf der Übersicht ist dafür eine Zeile (Karte, sonst Meldung, sonst Arbeitender); die Agent-Zeile zählt sie weiterhin.
- **Handy-Tabs:** `[Tagesstart · Zuhause] · Brille · Verbindung · Mehr` (Verbindung stand zuerst). Ohne gemerkten Tab (erster Start) öffnet weiterhin „Verbindung“. Die Steuerungstabelle in „Brille“ folgt der Reihenfolge Tippen, Wischen, Halten, 2×.
- **Wischrichtung umkehren** gilt an einer einzigen Stelle für alle Listen (Übersicht, Agenten, Sitzungen, Karten, Zuhause, Drucker, Meldungen, Tagesstart); neuer Test.
- Druckseite: Aktion heißt „Druck abbrechen“ statt „Abbrechen“ (eindeutig neben „abbrechen“ als Entschärfen).

## 0.8.0
- **Neue Seite „Tagesstart“ (Morgen-Briefing):** ein Tippen zeigt alles auf einen Blick – Termine heute, Wetter mit „Regen ab 14:00“, Zucker der letzten Nacht, Auto, Drucker und Server. Kompakte Zeilen mit festen Trennern „ · “ (die Brillenschrift ist proportional). Passt nicht alles auf eine Seite, blättert Wischen blockweise weiter (Fußzeile „1/2“); Tippen oder Halten lädt neu, 2× zurück. Menü: „Neu laden“. Auch als fünfte Zeile der Übersicht mit Kurzfassung („nächster 09:00 · 9° Regen ab 14:00“), im Brillen-Menü der Übersicht und in der Seitenwahl (Ring).
- **Der Daemon sammelt alles selbst** (`GET /brief`, gleiche Anmeldung wie `/report`; `?refresh=1` fragt alle Quellen neu), die Brille hält keine fremden Adressen oder Tokens. Jeder Block ist optional, hat sein eigenes Zeitlimit und eigene Fehlermeldung, Ergebnisse werden ~2 min zwischengespeichert; fällt eine Quelle aus, bleiben ihre letzten Werte bis 30 min sichtbar (markiert „alt“). Im `/report` steht der zuletzt gesammelte Stand (`brief`), so kommt eine Aktualisierung über den bestehenden Long-Poll.
  - Termine: ICS-Adressen (`BRIEF_ICS_URLS`, mehrere), ganztägige und mehrtägige Termine, Zeitzonen (TZID inkl. Outlook-Namen), Serien DAILY/WEEKLY (INTERVAL, COUNT, UNTIL, BYDAY), einfache MONTHLY/YEARLY, EXDATE und verschobene Einzeltermine. Ohne Quelle: „keine Kalenderquelle“.
  - Wetter: Open-Meteo für `BRIEF_LAT`/`BRIEF_LON` – jetzt, Min/Max, Regen aus 15-Minuten-Werten, danach stündlich („Regen ab 14:00“, „Regen bis 15:30“, „kein Regen“).
  - Auto: BYD-Bridge `/state` (`BRIEF_BYD_URL`) – Akku %, Reichweite, lädt/geladen, verriegelt.
  - Zucker: Sugar-Bridge (Nightscout nur lesen, `BRIEF_SUGAR_URL`) – aktueller Wert mit Trend und Alter, letzte Nacht 22–07 Uhr Min/Max, Minuten unter 70 / über 180 (Sensorlücken zählen nicht). „keine Werte“, wenn leer. **Nur zur Information.**
  - Drucker: Klipper-Bridge `/api/printer` (`BRIEF_KLIPPER_URL`), sonst der vorhandene Moonraker des Daemons.
  - Server: Status-Glass-Server (`BRIEF_STATUS_URLS` „Name|URL,…“) – ok/weg je Rechner und neue Geräte im Heimnetz.
- Handy: neuer Tab „Tagesstart“ mit denselben Blöcken und „Neu laden“, dazu die Einstellung **„Tagesstart als Startseite bis 11:00“** (aus = wie bisher).
- Ältere Daemons: die Seite sagt „Daemon auf Quiet Hub 0.8.0 aktualisieren“. Demo (`?demo=1`) mit allen Blöcken.
- Brillen-Menü der Übersicht: „Aktualisieren“ entfällt zugunsten von „Tagesstart öffnen“ (höchstens sechs Einträge; Halten aktualisiert weiterhin).

## 0.7.0
- **Neue Seite „Zuhause“ für Home Assistant:** links die Liste (zuerst Favoriten, dann Räume), rechts der Zustand der gewählten Zeile. Pro Raum „Alle Lichter“ und „Alle Rollos“ (ab zwei Geräten), Sensoren nur zur Anzeige (Temperatur, Feuchte, Bewegung, Akku – schwacher Akku steht in der Raum-Zusammenfassung).
- Tippen schaltet sofort (Zustand wechselt gleich auf der Brille), Szenen starten, ein Raum öffnet sich. Halten auf einem Licht öffnet das Detail: Wischen dimmt in 10-%-Schritten, Tippen an/aus. Halten auf einem Rollo: Wischen auf/zu, Tippen Stopp. 2× geht Detail → Raum → Liste → Übersicht. Menü: „Dimmen / Details“.
- Schlösser, Alarm und Garagentor sind ausgeblendet, außer `HA_SENSITIVE` nennt sie – dann immer zweistufig: der Daemon gibt beim ersten Tippen nur einen einmaligen Code (30 s), erst das zweite Tippen auf dieselbe Zeile führt aus.
- Daemon: `GET /home`, `POST /home/action`, `POST /home/confirm`; Ansicht auch im `/report` (`homeView`), Home Assistant wird alle 5 s abgefragt (`HA_POLL_MS`), Änderungen gehen über den bestehenden Long-Poll an die Brille. Konfiguration: `HA_FAVORITES`, `HA_AREAS`, `HA_EXCLUDE`, `HA_SENSITIVE`, `HA_HOME=off`. URL und Token bleiben im Daemon.
- Handy: neuer Tab „Zuhause“ mit derselben Liste; Favoriten und Reihenfolge werden im Daemon festgelegt (Hinweis im Tab).
- Ältere Daemons: die alte Geräteliste geht weiter (Tippen schaltet jetzt sofort statt nach zweitem Tippen).
- Demo (`?demo=1`): Favoriten, drei Räume, Gruppen, Sensoren und ein Demo-Schloss mit Bestätigung.

## 0.6.9
- Handy-Seite in Tabs statt einer langen Spalte: Verbindung · Brille · Mehr (Tab-Leiste unten, gewählter Tab bleibt), Status-Chip „verbunden/offline“ oben, Meldungen immer sichtbar über den Tabs.

## 0.6.8
- **Live-Abschrift beim Sprechen:** Während man den Touchpad hält, erscheint der Text sofort auf der Brille („● Ich höre …“, neueste Wörter unten). Beim Loslassen geht er direkt zur Bestätigung – kein Hochladen, keine zweite Erkennung. Live-Erkennung über WebSocket (privater Build: `VITE_LIVE_STT_URL`); ohne sie, bei Verbindungsabbruch oder leerer Abschrift wird wie bisher die WAV-Aufnahme hochgeladen.
- Sprachnachrichten bis 10 Minuten (vorher 2); Daemon nimmt bis 24 MB Audio an, Wartezeit auf Whisper wächst mit der Länge.
- **Antworten Wort für Wort:** Der Daemon hält `GET /report?since=<rev>&boot=<id>&wait=25` offen und antwortet, sobald sich etwas ändert (Long-Poll, gzip). Die Brille nutzt das, wenn der Daemon es in `/report`/`/health` (`live.longPoll`) anbietet, sonst wie bisher alle 1,5/5 s. Relay schickt Zwischenstände alle 250 ms statt 800 ms.

## 0.6.7
- Sprachnachrichten bis 2 Minuten (vorher 18 s, lange Sätze wurden abgeschnitten); Wartezeit auf die Abschrift bis 90 s.

## 0.6.6

Quiet while the agent works.

- **"Ruhe während der Agent arbeitet"** (phone page, off by default; also
  "Ruhe beim Arbeiten an/aus" in the glasses menu of the Agent page). While the
  agent on display (open session, or any agent on the overview) works, the
  glasses go nearly dark: all text emptied, header and body at text brightness
  0, a single "·" at brightness 1 in the footer as a sign of life, and the face
  replaced by one black (= transparent) frame. The 500 ms face animation sends
  nothing while quiet. SDK 0.0.16 has no display-off call; everything is done
  in place with `textContainerUpgrade` (`textColor`) and one image update, no
  rebuild and no second create.
- **Back at once** when the agent is done (answer and suggestions), a
  permission card arrives, an alert comes in, a message or confirm countdown
  shows, the mic records or a transcript waits, help or the picker is open, or
  the link breaks.
- **Tap or swipe while quiet** wakes the display for 20 s (progress and tool
  steps) and does nothing else; afterwards it goes quiet again while the agent
  still works. Every gesture while awake keeps it awake. Double tap (stop /
  back / exit) and hold (voice note) are unchanged.
- Simulator helpers: `?quiet=1` switches quiet on for one run, `?finish=<s>`
  lets the busy demo agent finish after s seconds.

## 0.6.5

Getting out of alerts, suggestions that fit the alert.

- **One double tap out of an alert.** A session opened from Meldungen used to
  climb session -> session list (reloading) -> agent list -> overview: three
  double taps, and on a running agent the first one was STOP. Now double tap in
  a session opened from an alert goes straight to the overview, never stops
  (Stop stays in the menu); the cursor sits on "Meldungen" while unread alerts
  are left. Footer: "läuft … · 2× zurück · Menü: Stopp". Opened alerts leave the
  list at once.
- **Suggestions with context.** The Spark vLLM now gets the last question, the
  last answer, the tool steps and earlier turns of the session; permission cards
  also get the tool and the command or file. Every answer, reopened session and
  opened alert gets a new list (a generation number drops late answers for
  another question/session); the three options shown last are filtered out and
  named in the prompt; temperature 0.7. On failure still none (no fallback).
  An alert from another session never shows the previous session's list.
- **Permission cards.** Swipe picks "Erlauben", "Ablehnen" or one of the vLLM's
  replies for this card (each with allow/deny); a deny reply is sent to the
  agent as its next message once the run ends. Double tap now goes back to the
  overview and leaves the card waiting (it used to deny); the menu still allows
  or denies directly.
- **Glasses react at once.** The first report is no longer awaited before the
  gesture handler (a slow daemon made the glasses black and deaf for up to 8 s);
  "verbinde …" is drawn first.
- **Microphone never stays open.** Releasing "hold" before the mic answered left
  it open for good; a late "on" is now switched off again, and the 18 s limit
  always ends a recording.
- Daemon: event titles no longer lose every "s" (regex typo).

## 0.5.1

Never show demo data when disconnected; connection diagnostics.

- **No silent demo fallback.** An unreachable daemon at startup used to show
  demo agents, devices and a printer while every action went nowhere. Demo data
  now exists only behind `?demo=1`. Disconnected, every page says "Nicht
  verbunden" with the exact reason (server missing / unreachable / wrong token /
  timeout / not https) and the server host; automatic retry with backoff
  (2, 5, 10, 30 s) and on tap. Daemon stand-ins for Home Assistant / Moonraker
  show "nicht eingerichtet" instead of fake items.
- **https check.** The installed app runs on an https origin and cannot call
  `http://` servers (mixed content). The app refuses to try and says
  "Server muss https sein - z. B. https://<pi>.<tailnet>.ts.net:8443".
  `scripts/start-pi.sh` now puts the Tailscale HTTPS names (from
  `tailscale serve status --json`) into the pairing QR, http only with a warning.
- **Phone page.** Connection status (host, last success, last error), inline
  "Verbindung testen", QR button on top when not connected; settings are written
  to the SDK store and read back, the client reloads and polls immediately.
- **Daemon access log**: one token-free line per request to the journal
  (`[access]`), relay heartbeats skipped.
- **Daemon CORS preflight fixed.** The `OPTIONS` answer was a 204 with a body and
  `Content-Length: 2`; WebKit (iPhone) treats that as a failed preflight, so the
  real request never followed. Now a clean 204 plus `Access-Control-Max-Age`.
- Phone page shows the raw error of the last failed request ("Technisch: ...").
- Failed actions (send, approve ...) now say why on the glasses.

## 0.5.0

A clearer hub: everything on one overview, a native menu per page, confirmed voice.

- **Overview shows everything, no setup.** Online agents with dots (`●` idle,
  `*` busy, `!` waiting, `○` offline), unread alerts, lights on, printer progress
  and what needs you right now. Agents appear from the relays by themselves;
  every empty page says in one line what is missing. No phantom agent when none
  is connected.
- **Fixed status line** (header, updated in place): page, connection, unread,
  busy agents, waiting cards.
- **Native contextual menu** per page (<= 6 verbs, <= 32 bytes, ids non-zero,
  re-supplied on every rebuild): Agent *Stop / New session / Switch agent*,
  Alerts *Mark all read*, Home, Printer, card *Allow / Deny*, Help. Gestures stay
  as shortcuts; risky menu actions keep the confirming tap.
- **Voice with confirmation.** `● Aufnahme …` -> release -> `Verstanden: …` ->
  tap sends, double tap discards. "Send immediately" is a phone setting (off by
  default). Daemon: `POST /agent/voice?ask=0` transcribes only (older apps keep
  the old behaviour).
- **Feedback and help.** Every action answers in the footer (sent, allowed,
  denied, stopped, new session, ...); a help sheet lists the controls.
- **R1 ring.** Ring double tap opens a page picker (never exits), swipe selects.
- **Long answers in pages** (six rows; swipe turns, last page = questions),
  tool calls as one line, permission cards with tool and command.
- **Robust input.** Missing `eventType` = CLICK, missing
  `currentSelectItemIndex` = 0, 300 ms scroll cooldown, selections kept in state.
- **Fewer BLE writes.** Only changed containers are upgraded, the icon only when
  it changes, a rebuild only when the menu (page) changes.
- **Fast entry.** Launching from the glasses menu opens the Overview.
- **Daemon: phone mirror.** waiting/done/error events and finished prints go to
  Home Assistant's `notify.mobile_app_*` (auto-detected, read-only; pin with
  `HA_NOTIFY_SERVICE`, off with `HA_NOTIFY=off`). `/report` approvals now carry
  the `tool`. Relay protocol unchanged.
- Screenshot scenes for the simulator: `?demo=1&scene=card|busy|long|empty|alerts`.

## 0.4.0

Real session control for every agent, a real Stop, and a way back from every page.

- **Sessions on the glasses.** Agent list -> session page (`+ New session`,
  `» Continue`, recent sessions with age) -> open session. German and English.
- **Hermes via the evenhub-bridge.** The relay (and the daemon's own Hermes) can
  talk to the `hermes-evenhub-bridge` WebSocket: hello/token, session list, new,
  switch, streamed answer, tool activity, interrupt, reconnect with backoff.
  `relay.json`: `"bridge": {"url": "ws://…", "tokenEnv": "EVENHUB_BRIDGE_TOKEN"}`;
  the token is read at runtime from the environment or `~/.hermes/.env` and is
  never stored or printed. `hermes chat -q` stays as fallback and now continues
  a session with `--resume <id>`.
- **Claude / Codex sessions.** Claude `-p --resume <session_id>` (id read from
  the stream-json output; session list from `~/.claude/projects`), optional
  `--continue`. Codex `thread/start` vs `thread/resume`, `thread/list`.
- **Real Stop.** Double tap while an agent runs: Hermes bridge `stop`, Codex
  `turn/interrupt`, and for every CLI the whole process tree is killed
  (`taskkill /T /F /PID` on Windows, the process group on Linux/macOS). The
  status shows `[gestoppt]`; the daemon reports `stopped` and `stopConfirmed`.
- **Daemon API.** `GET /agent/sessions`, `POST /agent/session/new`,
  `POST /agent/session/select`, `POST /relay/reply`; `/agents` and `/report`
  carry `session`, `transport`, `stopped`.
- **Back never fails.** Footer hint `2× = zurück` on every page; double tap
  discards a running recording; a notification no longer pulls you out of the
  agent page; gesture decoding prefers an explicit double-tap code over an empty
  payload next to it; phone setting to reverse the swipe direction.
- **Voice.** Max 18 s, minimum length, and clear errors on the glasses
  (`Mikrofon nicht freigegeben`, `Spracherkennung nicht erreichbar`).
- **Suggestions only from the Spark vLLM.** Follow-up options for every agent kind
  and for permission cards come from vLLM (`VLLM_URL`, `VLLM_MODEL`, default
  `qwen`, Qwen thinking off, temperature 0.3, 6 s timeout, asynchronous). If it
  fails there are no suggestions (and a log line) - never agent-supplied or canned.
- Agent logic moved to `examples/quiet-hub-agents.mjs` (copy it next to the
  relay).

## 0.3.0

Multi-agent relay, voice, Home Assistant and Moonraker.
