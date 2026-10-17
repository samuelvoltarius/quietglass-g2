# Changelog

## [1.0.3] — 2026-10-17

### Behoben (Hardware-Test)

- **Beenden-Dialog: die Systemereignisse 4 und 5 direkt nach dem Aufruf gelten als Anzeigen und Schließen des Dialogs.** Am Gerät gemessen: 4 (FOREGROUND_ENTER) kommt ca. 150 ms nach dem Aufruf, wenn der Dialog erscheint; bei „Nein“ folgt 5 (FOREGROUND_EXIT), der Dialog ist weg, die App war nie fort; bei „Ja“ folgt auf 5 nach ca. 0,5 s die 7 (SYSTEM_EXIT). Die App hielt 4/5 bisher für Vorder-/Hintergrund und pausierte.
- Nach „Nein“ kommt die Seite jetzt sofort ohne Geste zurück; nichts wird pausiert, Timer, Mikrofon und Untertitel laufen weiter.
- Ein 2× auf der Startseite, das ankommt, während die App als im Hintergrund gilt (ein echtes 5 ohne Dialog), holt die Seite zurück und fragt danach erneut (nach dem Wiederaufbau), statt ohne Seite den Dialog zu rufen.

## [1.0.2] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [1.0.1] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.
- Nichts wird vor dem Dialog angehalten: laufende Untertitel und Mikrofon enden erst, wenn das System die App beendet.
## [1.0.0] — 2026-10-16

Neu geordnet, damit man auf der Brille und am Handy nicht mehr suchen muss. Alle Funktionen bleiben.

### Brille

- **Startbild**: genau drei Einträge – **Übersetzen**, **Englisch sprechen**, **Gespräch** – und, nur wenn die Kundenliste da ist, die Kunden eingerückt darunter. Wischen bewegt den Cursor, Tippen startet; der Cursor steht auf dem zuletzt benutzten Modus. Ohne gelernte Stimme steht unten eine Zeile „Tipp: Stimme am Handy lernen“ (nicht wählbar).
- **Englisch sprechen** (neu): Gesprächssprache Englisch, Untertitel des Gesagten, der automatische Wortfinder ist immer an (mit Sprachmodell), das Gegenüber wird auf Wunsch ins Deutsche übersetzt (Schalter am Handy, Standard an); deine eigenen Zeilen („Ich:“) werden nicht übersetzt.
- **Laufendes Bild** ruhiger: oben „Modus · ● live“ (oder „● verbinde …“, „● offline“, bei zurückgeblättertem Verlauf zusätzlich „‖ Verlauf“), unten eine einzige Hinweiszeile („Tippen: Stopp · Wischen: zurück“). Das ● bleibt, solange das Mikrofon offen ist. DEMO-Marke, Übersetzungsfehler und „Stopp?“ bleiben in der Kopfzeile.
- **2×** schließt zuerst Blatt oder Popup, **stoppt dann und geht zurück zum Start** (mit Zusammenfassung, falls an); erst 2× auf dem Startbild öffnet den Beenden-Dialog (danach unverändert neu aufgebaut). „Mein letzter Satz“ per Wischen am neuesten Stand gibt es nur noch in Übersetzen.
- **Entfernt**: Hilfe (Halten) samt Übersichtsseiten, Kundeninfo-Blatt, Zeilen „Meine Stimme lernen/löschen“ und „Personen“ in der Liste, Zeile „Ohne Kunde – Übersetzen“, Uhrzeit und Helferliste („A/B · Antworten · Info · Gedächtnis · RU→DE“) in der Kopfzeile, Fußzeile mit „Halten = …“. Seitenmenü bleibt aus.
- Ein Tipp nach einer Meldung („Mikrofon nicht freigegeben“ …) nimmt nur die Meldung weg und führt zum Startbild zurück.

### Handy

- **Drei Tabs**: **Jetzt** (Zustand, Modus-Knöpfe, Kunde für „Gespräch“, Mitschrift, Zusammenfassung, Info/Antworten/Tipp-Karten), **Meine Wörter** (Liste mit Anzahl, einzeln oder alle löschen) und **Einstellungen** in Karten: Meine Stimme (großer Knopf „Stimme lernen“ – die Brille zeigt den Text zum Vorlesen – und „Stimme löschen“ mit Rückfrage), Sprachen, Personen im Gespräch, Wortfinder, Server (eingeklappt, sobald eingerichtet), Gedächtnis, weitere Optionen, Anzeige.
- **Erster Start** (nichts eingerichtet): Einstellungen öffnet mit einer 3-Schritte-Liste (Server → Stimme → fertig); die Demo läuft weiter ohne Server.
- Personen und Modus lassen sich am Handy ändern; laufende Untertitel starten dann mit den neuen Werten neu.

### Behoben

- **Wortfinder mit gelernter Stimme**: Er springt nur noch bei deinen eigenen **fertigen** Zeilen („Ich:“) an, nie bei einer vorläufigen Zeile, deren Sprecher noch unbekannt ist (sonst suchte er Wörter für das Gegenüber). Ohne Stimmprofil bleibt es wie vorher.

## [0.9.0] — 2026-10-16

### Neu

- **Wortfinder automatisch**: Auf der echten Brille kommt Halten nie in der App an. Jetzt sucht Babel das Wort von selbst, wenn du hängen bleibst: Satz ohne Schlusszeichen und 2,5 s keine neue Erkennung, ein „ähm“/„äh“/„wie sagt man“/„how do you say“ am Ende (nach 1 s Pause), oder im englischen Gespräch ein deutsches Wort. Höchstens alle 8 s, nie doppelt für denselben Text, nie während einer Suche oder 2 s nach einem geschlossenen Popup. Schalter „Wortfinder automatisch“ am Handy (Standard an); Halten geht weiterhin.
- **Englisch-Lerner**: Spricht der Nutzer Englisch (Gesprächssprache Englisch oder überwiegend englischer Text), liefert der Wortfinder das englische Wort plus 2–3 englische Alternativen und in der zweiten Zeile die deutsche Bedeutung („→ DE: …“). Sagte er ein deutsches Wort, ist das erste englische Wort dessen Übersetzung.
- **Meine Wörter** (Tab Gedächtnis): jedes gefundene Wort bleibt am Handy (Wort → Bedeutung, neueste zuerst, höchstens 300, kein Wort doppelt), einzeln oder alle löschbar.

## [0.8.4] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

## [0.8.3] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Die Klicks auf die Menüeinträge kommen auf der Brille nie in der App an, und solange eine Seite ein Menü trägt, öffnet Halten das Menü statt die App zu erreichen (Schrittprotokoll 15.10.2026). Die Seiten tragen kein `menuObject` mehr; Menü-Code und `menuItemClickEvent`-Behandlung bleiben für später.
- **Halten** bei gestoppten Untertiteln öffnet wieder die **Hilfe** (mit Übersicht auf den späteren Seiten); während der Untertitel bleibt Halten der Wortfinder. In der Zusammenfassung steht wieder „Halten = Hilfe“.
- **Modus**: kein Menüeintrag mehr; die gewählte Zeile der Kundenliste legt ihn fest (Kunde = Kundengespräch, „Ohne Kunde“ = Übersetzen). **Kunde wechseln**: Untertitel stoppen (Tippen, Tippen), dann steht die Liste da. **Kundeninfo**: nur am Handy.
- **Meine Stimme lernen**, **Meine Stimme löschen** und **Personen** stehen als Zeilen am Ende der Kundenliste: Tippen auf die Zeile führt aus; „Meine Stimme löschen“ braucht ein zweites Tippen auf dieselbe Zeile innerhalb von 4 s (`Nochmal tippen = löschen`), Wischen/2×/4 s ohne Eingabe brechen ab.
- Hilfetexte der Brille und Hinweise am Handy beschreiben wieder die Gesten statt des Seitenmenüs.

## [0.8.2] — 2026-10-15

### Behoben

- Die Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben. Jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s); danach gilt der Aufruf als fehlgeschlagen und die Seite wird neu aufgebaut.

## [0.8.1] — 2026-10-14

QIS v1.2 (Bedienstandard, Entscheidungen nach dem Audit vom 2026-10-14).

### Geändert

- **Meine Stimme löschen** (Seitenmenü) ist scharfgeschaltet (QIS v1.2 #3): der erste Klick zeigt `Nochmal = löschen · Wischen/2× = abbrechen`, erst ein zweiter Klick auf denselben Eintrag innerhalb von 4 s löscht. Tippen, Wischen, 2× oder 4 s ohne Eingabe brechen ab; Halten nicht (damit öffnet man das Menü erneut).
- **Kunde wechseln, Modus, Personen** während laufender Untertitel: der erste Klick zeigt `Nochmal = Neustart der Mitschrift`, erst der zweite Klick innerhalb von 4 s führt aus (Neustart bzw. Stopp der Untertitel). Bei gestoppten Untertiteln wirken sie wie bisher sofort.
- **2× im Hauptbild** öffnet den System-Beenden-Dialog, ohne vorher zu stoppen (QIS v1.2 #2): die Untertitel laufen während der Frage weiter und enden erst, wenn das Beenden bestätigt wird. Abbrechen ändert nichts.
- Handy-Text zu 2× beschreibt jetzt genau das (statt „Stoppt nie Untertitel“); Halten-Text nennt das Seitenmenü statt „Sonst: Hilfe“. README entsprechend.

### Entfernt

- Unerreichbarer Ruhebildschirm mit „Wischen = Hilfe“ / „Wischen hoch = Kunde · runter = Hilfe“ samt Texten: gestoppt zeigt die Brille immer die Kundenliste.

## [0.8.0] — 2026-10-14

### Neu

- **Meine Stimme lernen** (Seitenmenü): Die Brille zeigt fünf Zeilen zum Vorlesen (`Lies laut vor · noch 16 s`, ~15 s). Das Mikrofon der Brille nimmt auf (`● MIKRO` im Kopf), der Ton geht über eine eigene Verbindung nur an den eigenen Spracherkennungs-Server (gleiche Adresse, gleicher Token wie die Untertitel; Startframe `{"type":"start","voice":"enroll"}`, dann PCM, dann `stop`). Der Server rechnet daraus einen Stimmabdruck (ECAPA-Mittelwert über ~3-s-Stücke, Ausreißer weg, zwei Stimmen werden abgelehnt) und meldet `Gespeichert … Qualität 83 %` oder warum nicht (`Zu wenig Stimme`, `Mehrere Stimmen oder Lärm`, `Server kann noch keine Stimmprofile`, `Server lehnt den Zugang ab`). Tippen oder 2× während des Vorlesens bricht ab: Mikro aus, Verbindung zu ohne `stop`, nichts gespeichert.
- **Meine Stimme löschen** (Seitenmenü): `{"type":"start","voice":"delete"}` – der Server löscht den Stimmabdruck; laufende Untertitel enden vorher (die Sitzung hielt ihn im Speicher).
- **Datenschutz**: Der Stimmabdruck ist ein biometrisches Merkmal. Er liegt nur auf dem eigenen Server (`~/whisper-unified/voices/owner.npy`, Ordner 0700, Datei 0600), wird nie geloggt oder weitergegeben; die Aufnahme selbst wird nicht gespeichert. In der App steht nur das Merkmal „Stimme gelernt“.
- Untertitel: Erkennt der Server die eigene Stimme, kommt die Zeile als Sprecher `ME` und steht als **`Ich:`** (`Me:`) auf der Brille und im Handy-Protokoll; `A`, `B` … sind dann nur die anderen. Antwort-Vorschläge reagieren nie auf `Ich`-Zeilen (eine `Ich`-Zeile bricht einen wartenden Vorschlag ab), Wortfinder und „mein letzter Satz“ nehmen bevorzugt die `Ich`-Zeilen. Mit gelernter Stimme gilt jeder Buchstabe als „Gegenüber“.
- **Personen: 2/3/4/5** (Seitenmenü, Tippen = weiter, gespeichert, Vorgabe 2): geht im Startframe an den Server (`persons`, und `speakers` = Personen − 1, wenn die Stimme gelernt ist). Der Server öffnet nie mehr Buchstaben als andere Personen; ist das Maß voll, bekommt jede Zeile den nächstliegenden. Läuft die Spracherkennung, startet sie mit der neuen Zahl neu.

### Hintergrund

- Café-Test 2026-10-14 (Brillenmikro, 2 Personen): der Server machte 7 Sprecher daraus. ECAPA-Ähnlichkeit derselben Person 0,4–0,8, anderer Personen 0,0–0,4. Mit `Personen: 2` bleiben es im Nachspielen 2 Buchstaben; mit gelernter Stimme `Ich` + `A`.
- Die Server-Seite (whisper-unified auf dem eigenen Rechner) liegt nicht in diesem Repository; ältere Server ignorieren `persons`/`speakers` und antworten auf `voice` nicht – die App meldet dann `Server kann noch keine Stimmprofile` und öffnet das Mikrofon gar nicht.
## 0.7.1

### Neu

- **Tipp-Karten** (nur Kundengespräch, wie Evens „Conversate“): läuft das Mikro, fragt Babel etwa alle 20 s – nur wenn seit der letzten Anfrage mindestens 2 neue fertige Zeilen dazukamen und gerade kein Antwortvorschlag (bzw. Wortfinder/eigener Satz) offen ist – den Proxy nach höchstens **einer** kurzen Karte: Rückfrage (`*` Tipp), gemeinter Begriff (`?`), kurze Rechnung/Tatsache (`#`) oder vorsichtiger Hinweis (`!` Achtung). Auf der Brille 8 s als kleines Popup (Titel + ein Satz, höchstens 3 Zeilen à 46 Zeichen, ASCII-Markierung, weil die Brillenschrift keine Emoji hat), niedrigste Popup-Priorität (Wortfinder > eigener Satz > Antwortvorschlag > Erklärung > Tipp-Karte).
- Die letzten 50 Karten stehen im Handy-Tab **Gespräch** (mit Uhrzeit, neueste zuerst) und gehen mit in die Zusammenfassung (als „Tipp-Karten während des Gesprächs“, damit sie dort aufgegriffen werden können); der Proxy schneidet sie vor der Shoot-Day-Rückmeldung wieder ab – sie sind Hinweise der Brille, nichts, was der Kunde gesagt hat.
- Handy: Schalter **Tipp-Karten** (Standard an).
- Proxy: `POST /context/cue {transcript, customer?, recent_titles?}` → `{"cue": {title, text, kind}}` oder `{"none": true}` (nur lesend; gleicher Kundenkontext und `X-Babel-Customer` wie die anderen Aufrufe; ohne Denken, nur JSON, Temperatur 0.3, 120 Tokens, 6 s Grenze → 504; Wiederholungen von `recent_titles` werden verworfen).

## [0.7.0] — 2026-10-14

### Neu

- Startbildschirm = **Kundenliste** (`BABEL · Kunde wählen`): Shoot-Day-Kunden (ohne „Ohne Zuordnung“) mit dem nächsten Projekttermin; Kunden mit Termin **heute** zuerst (nach Uhrzeit), dann alle anderen nach Name; letzte Zeile `Ohne Kunde – Übersetzen`. Wischen = Cursor (folgt „Wischrichtung umkehren“), Tippen = starten, 2× = Ende. Fußzeile `Tippen = starten · Wischen = wählen · 2× = Ende`.
- Tippen auf einen Kunden: Kundengespräch mit genau diesem Kunden; jede Anfrage ans Sprachmodell trägt `X-Babel-Customer: <id>` (der Proxy nimmt dessen Shoot-Day-Kontext), die Kundeninfo wird mit `customer=<id>` geholt. Letzte Zeile: Übersetzen ohne Kundenkontext (`X-Babel-Customer: -`).
- Liste nicht ladbar: `Kunden nicht erreichbar` (Tippen = neu laden) + `Ohne Kunde – Übersetzen`. Ohne Modell-Server gibt es nur die letzte Zeile.
- **Seitenmenü** der Brille (Halten → Systemmenü neben Schließen und Helligkeit, SDK `menuObject` / `menuItemClickEvent` wie Quiet Hub): `Hilfe`, `Übersicht`, `Modus: Übersetzen`/`Modus: Kundengespräch` (umschalten; läuft es, startet die Spracherkennung mit der neuen Sprache neu), `Kunde wechseln` (stoppt und zeigt die Liste), `Kundeninfo` (Seite „Kunde“ des gewählten Kunden).
- Proxy: `GET /context/customers` (nur lesend, gleiche Anmeldung/CORS wie `/context/customer`; 60 s Cache, 2 s Zeitlimit).

### Geändert

- Wischen öffnet nie mehr Hilfe oder Kunde: gestoppt bewegt es den Cursor der Liste, während der Untertitel blättert es wie bisher. Halten ist gestoppt ohne Wirkung (während der Untertitel weiter der Wortfinder). Eine Zusammenfassung legt Tippen oder 2× beiseite (zurück zur Liste); gespeichert bleibt sie.
- Die Seite „Kunde“ hat keine Modus-Zeile mehr (der Modus liegt im Seitenmenü).

## [0.6.3] — 2026-10-14

### Neu

- Modus an der Brille: **Kundengespräch** und **Übersetzen**. Gestoppt zeigt die Kopfzeile den Modus (`BABEL · Mikro aus · Kundengespräch` / `… · Übersetzen`).
- Kundengespräch: Sprache fest Deutsch (`de` an die Spracherkennung, nie `auto` – das ließ Whisper bei Rauschen englische Sätze erfinden), keine Übersetzung (der Übersetzer wird gar nicht gefragt), nur deutsche Untertitel; Antwort-Vorschläge schneller (600 ms statt 1200 ms warten, höchstens alle 8 s statt 15 s, Anfragen alle 2,5 s statt 4 s). Sprecher-Buchstaben bleiben. Übersetzen: genau wie bisher.
- Umschalten: gestoppt nach oben wischen öffnet wie bisher die Seite „Kunde“; ihre erste Zeile ist `> Kundengespräch starten` (Tippen = Modus Kundengespräch und sofort zuhören) bzw. im Kundengespräch `> Übersetzen-Modus` (Tippen = zurück zu Übersetzen, ohne zu starten). Auf späteren Seiten schließt Tippen wie bisher.
- Handy, Reiter „Gespräch“: Modus als Umschalter mit zwei Knöpfen.
- Vorgabe: Meldet Shoot Day einen Kunden, startet Babel im Kundengespräch, sonst im Übersetzen; sobald ein Modus gewählt wurde, bleibt er (gespeichert in den Einstellungen).

## [0.6.2] — 2026-10-14

### Behoben

- Hilfe „hing auf Seite 3“: Hilfe und Kunde-Seite zeigen in der Fußzeile immer `Seite x/y`; die letzte Seite endet mit `— Ende · Tippen = schließen —`, und ein weiteres Wischen nach unten schließt das Fenster (zurück zum Hauptbildschirm).
- Die Übersicht („was läuft wann“) beginnt auf einer eigenen Seite mit der Titelzeile `ÜBERSICHT · was läuft wann`.

### Neu

- Kunde aus Shoot Day (über den babel-llm-proxy, nur lesend, `GET /context/customer?full=1`, 3 s Zeitlimit beim Start und beim Öffnen): Meldet der Proxy einen Kunden, zeigt der Ruhebildschirm `Kunde: <Name> · n Ideen` und `Wischen hoch = Kunde · runter = Hilfe`. Wischen nach oben (gestoppt) öffnet die Seite „Kunde“ mit Projekt, Datum, Ort, Ideen, Storyboards (Szenentitel) und Slogans, geblättert wie die Hilfe. Wischen nach unten öffnet weiterhin die Hilfe, Halten bei laufenden Untertiteln bleibt der Wortfinder. Fehler/Zeitüberschreitung: keine Zeile, keine Seite.
- Handy, Reiter „Gespräch“: Zeile `Kunde (Shoot Day): <Name> – n Ideen, m Storyboards`.
- babel-llm-proxy: `GET /context/customer?full=1` liefert zusätzlich `date`, `place`, `ideas` (Texte), `storyboards` (`{title, scenes:[Titel]}`) und `slogans`; gleiche Anmeldung, gleicher Zwischenspeicher, nie der Prompt-Text.

## [0.6.1] — 2026-10-14

### Geändert

- Sicherheit: Die Mitschrift lässt sich an der Brille nicht mehr löschen. Halten löscht und bereitet das Löschen nicht mehr vor; bei gestoppten Untertiteln öffnet Halten die Hilfe (während der Untertitel bleibt es der Wortfinder). Löschen geht nur noch am Handy (Reiter „Gespräch“, „Mitschrift löschen“), jetzt mit Rückfrage.
- Fußzeilen und Hilfetexte angepasst („Halten = löschen“ entfällt).

## [0.6.0] — 2026-10-14

### Geändert (QIS v1)

- Folgt dem Quietglass-Bedienstandard (QIS v1, `docs/BEDIENSTANDARD.md`).
- Sicherheit: Ein einzelnes Tippen stoppt laufende Untertitel nicht mehr. Tippen bereitet den Stopp vor (`Nochmal tippen = stoppen · 2× = abbrechen`), ein zweites Tippen innerhalb von 4 s stoppt (und fasst zusammen). Wischen, Halten, 2× oder 4 s ohne Eingabe brechen ab.
- Sicherheit: Die Mitschrift löscht nicht mehr „zweimal Halten“. Halten bereitet das Löschen vor (`Nochmal tippen = löschen · …`), ein Tippen innerhalb von 4 s löscht. Wischen, Halten, 2× oder 4 s brechen ab. Ohne Mitschrift oder Zusammenfassung tut Halten nichts und die Fußzeile bietet es nicht an. Das Loslassen nach dem Halten zählt nicht als eigene Geste.
- 2× ist nur noch zurück: es schließt zuerst die Hilfe, dann ein Popup, und verlässt die App erst im Hauptbild (über den System-Dialog wie bisher). Es stoppt nie Untertitel.
- Kopfzeile ist `BABEL · Zustand`; das Mikrofon-Zeichen bleibt immer in der Kopfzeile, solange das Mikrofon offen ist. Demo-Marke, Verbindungszustand, Übersetzungsfehler (jetzt „Übersetzen: …“), „Verlauf“ und „Stopp?“ wanderten aus der Fußzeile in die Kopfzeile. Fußzeilen kommen aus einem `footer()`-Helfer in der Reihenfolge Tippen/Wischen/Halten/2× und enden auf `2× = zurück` oder `2× = Ende`; Wischen fällt zuerst weg, wenn die Zeile zu breit wird.
- Die Seitenzahl der Zusammenfassung steht in der Kopfzeile, die Fußzeile behält `Wischen = Seite`.
- Hilfeseite (Wischen bei gestoppten Untertiteln): zuerst die vier Gesten in Fußzeilen-Reihenfolge und was die App braucht, danach wie bisher jede Hilfsfunktion mit Auslöser und Zustand.
- Handy: Reiter `Gespräch · Sprachen · Gedächtnis · Brille · Verbindung · Mehr`. Server-Adressen und Schlüssel liegen unter „Verbindung“; der Schalter für die Wischrichtung bleibt unter „Brille“.
- Unverändert: Wischen am neuesten Stand übersetzt weiter den letzten eigenen Satz (zeigt nur ein Popup, ändert und sendet nichts).

## [0.5.0] — 2026-10-14

### Neu — Antwort-Vorschläge

- Beendet das **Gegenüber** (Sprecher-Buchstabe ≠ „Ich bin Sprecher“; bei „automatisch“ oder ohne Sprecher: eine Zeile, die nicht in deiner Sprache ist) eine Frage oder einen Satz, auf den man antwortet, schlägt dein Sprachmodell **einen** kurzen Satz vor (höchstens 12 Wörter) – als Popup „Antwort: …“ in der Gesprächssprache, bei einer Fremdsprache mit kurzer deutscher Übersetzung in Klammern. Kontext: die letzte Minute plus die drei passendsten Einträge aus dem eigenen Gedächtnis.
- Streng: Braucht es keine Antwort, antwortet das Modell genau „-“ und es erscheint nichts. Höchstens ein Vorschlag pro 15 s, nie während du sprichst; hast du schon geantwortet, wird ein verspäteter Vorschlag verworfen. 64 Tokens, Temperatur 0,3, Denken aus, 8 s.
- Popups kommen nie übereinander: Wortfinder/eigener Satz vor Antwort-Vorschlag vor Erklärung. Wartendes erscheint danach, solange es noch aktuell ist (Vorschlag 8 s, Erklärung 30 s).
- Schalter „Antwort-Vorschläge“ (an). Die Demo ohne Server zeigt ein Beispiel.

### Neu — Meine Sätze übersetzen

- Schalter „Meine Sätze übersetzen“ (aus): Deine eigenen Sätze (Sprecher-Buchstabe oder – ohne Sprecher/automatisch – in deiner Sprache erkannt) werden in die **Gesprächssprache** übersetzt und groß als „→ …“ in den Untertiteln gezeigt, zum Vorlesen. Normale Richtung bleibt: gesprochene Sprache → „Übersetzen in“. Die Handy-Hilfe erklärt beide Richtungen.
- Auf Abruf, wenn die Sprechererkennung danebenliegt: **am neuesten Stand nochmal zum Neuesten wischen** = deinen letzten Satz übersetzen (Popup „→ …“). Ausläufer derselben Wischbewegung lösen es nicht aus.

### Neu — Übersicht: was läuft wann

- Kopfzeile beim Zuhören zeigt kompakt nur Aktives, z. B. „● MIKRO · RU→DE · A/B · Antworten · Gedächtnis“; passt es nicht in 46 Zeichen, fallen Uhrzeit, Info, Gedächtnis … zuerst weg, das Mikro nie.
- Jedes Popup trägt seine Art: „Info:“, „Antwort:“, „Wort:“, „→“ – auf der Brille und in der Mitschrift am Handy.
- **Hilfe auf der Brille:** Wischen bei gestoppten Untertiteln (oder Knopf am Handy) zeigt jede Funktion mit Auslöser und ob sie gerade an ist; Tippen = zurück, Wischen blättert.
- Handy: Tabelle **Übersicht** oben im Tab Gespräch – Untertitel, Übersetzung, Sprecher, Info-Popups, Antwort-Vorschläge, Eigene Sätze, Wortfinder, Mitschrift, Zusammenfassung, Gedächtnis – mit Schalter, Auslöser und Live-Status (Server live/Demo, Gedächtnis verbunden/nicht verfügbar).
- Mitschrift am Handy markiert Antwort-Vorschläge („Antwort: …“) und übersetzte eigene Sätze („→ … zum Vorlesen“); beides bleibt mit „Letzte Mitschrift behalten“ erhalten.

### Geändert

- Die Kopfzeile zeigt beim Zuhören den Live-Status statt „Hört zu“/„Info“/„Wortfinder“; die Art des Popups steht jetzt vorne im Popup.
- Eine Erklärung, die während eines Wortfinder-Popups fertig wird, wartet und erscheint danach (vorher: nur am Handy).

## [0.4.0] — 2026-10-13

### Neu — Wortfinder

- **Halten während der Untertitel** = Wortfinder: Fehlt dir im Kundengespräch ein Wort, schickt Babel die letzten ~20 Sekunden der Mitschrift an dein Sprachmodell („Der Sprecher sucht ein Wort …“). Als Popup erscheint das wahrscheinlich gesuchte Wort plus 2–3 Ausweichwörter in einer Zeile (höchstens 40 Zeichen, z. B. „Kostenvoranschlag · Angebot · Offerte“); ist eine Übersetzung eingestellt, darunter das Wort in der Zielsprache. Antwort nach spätestens 8 s, sonst „kein Vorschlag“. Schnell gehalten: 40 Tokens, Temperatur 0,1, Denken aus.
- Neue Einstellung „Ich bin Sprecher: automatisch / A / B“ – automatisch = wer zuletzt vor dem Halten sprach. Mit Sprecher-Buchstabe zählen vor allem deine eigenen Sätze; die vorläufige Zeile (der Satz mit der Lücke) geht mit.
- Halten bei gestoppten Untertiteln löscht wie bisher die Mitschrift (zweimal halten). Fußzeile „Tippen = Stopp · Halten = Wort“, Handy-Hilfe angepasst. Ohne Server zeigt die Demo ein Beispiel.

### Neu — eigenes Gedächtnis

- Babel hat ein **eigenes** Gedächtnis auf deinem Server (babel-llm-proxy, neue Endpunkte `/memory`): Nach jeder Zusammenfassung werden Datum, Titel, Zusammenfassung und **Abmachungen** abgelegt (die Zusammenfassung fragt jetzt auch nach Abmachungen). Eine JSON-Datei neben dem Proxy, atomar geschrieben, nur für den Besitzer lesbar (600), höchstens 500 Einträge. Kein Zugriff auf irgendein anderes Gedächtnis.
- Die Erklär-Popups bekommen die 3 besten Treffer zum aktuellen Thema als „Notizen des Nutzers“ und dürfen an ein früheres Gespräch erinnern – nur wenn es konkret passt; sonst antwortet das Modell genau „-“ und es erscheint nichts.
- Handy: neuer Tab **Gedächtnis** – Liste (Datum, Titel, Abmachungen), einzeln löschen, alles löschen (zweimal tippen), Notiz hinzufügen, alles als Text exportieren. Schalter „Eigenes Gedächtnis“ im Tab Gespräch (an).
- Ältere Proxys ohne `/memory`: der Tab sagt „nicht verfügbar“, sonst läuft alles wie bisher, ohne Fehlermeldungen.

### Proxy (babel-llm-proxy)

- `POST /memory`, `GET /memory?limit=`, `DELETE /memory/<id>`, `DELETE /memory`, `POST /memory/search` (Stichwortsuche nach BM25, reine Standardbibliothek). Gleiche Anmeldung wie der Chat-Endpunkt, CORS erlaubt jetzt DELETE. Datei per `BABEL_MEMORY_FILE` (Vorgabe: `babel-memory.json` neben dem Skript, gitignored). Selbsttest: `python3 babel_llm_proxy.py --selftest`.

## [0.3.3] — 2026-10-13

### Geändert

- Handy-Seite in Tabs statt einer langen Spalte: Gespräch · Sprachen · Brille · Mehr (Tab-Leiste unten, gewählter Tab bleibt). Server-Einstellungen stehen nicht mehr eingeklappt, sondern als normale Karten unter „Mehr“ (mit eigenem Speichern-Knopf). Status-Chip oben zeigt „Quelle → Ziel“. Meldungen bleiben über den Tabs sichtbar.

## [0.3.2] — 2026-10-13

### Geändert — Sprachmodell-Text erscheint, während er entsteht

- Übersetzung, Zusammenfassung und Erklärungen fragen das Sprachmodell mit `"stream": true` (Server-Sent-Events). Die Brille zeigt den Text schon beim Schreiben (höchstens alle 300 ms neu gezeichnet): die Übersetzung einer Untertitelzeile ersetzt sich Schritt für Schritt, Zusammenfassung und Erklärung wachsen.
- Rückfall: Antwortet Server oder Proxy mit normalem JSON, wird das wie bisher gelesen; bricht der Stream vor dem ersten Wort ab oder lehnt der Server `stream` ab, kommt einmal eine normale Anfrage. Denkblöcke (`reasoning_content`, `<think>`) werden nie gezeigt.
- Lange Zusammenfassungen werden auf der Brille nicht mehr abgeschnitten: kurze Punkte, darunter die ausführlichen, seitenweise („Seite 1/3 · Wischen = blättern“). Lange Erklärungen bekommen den ganzen Bildschirm.
- Mehr Platz für lange Gespräche: Zusammenfassung bis 3000 Tokens (vorher 900), Mitschrift bis 48 000 Zeichen an das Modell (vorher 12 000), Übersetzung mit eigener Längengrenze statt der 300 Tokens des Proxys.


## [0.3.1] — 2026-10-13

### Fixed

- **Blank glasses after a Bluetooth drop:** a reconnect set the page as lost but kept the last view, so an unchanged caption skipped the rebuild. A reconnect or a return to the foreground now always rebuilds the page (never a second `createStartUpPageContainer`).
- Gestures are wired before the first page is drawn, and page writes run one at a time (the ticker could start a second creation while the first was still on its way).
- A refused microphone is said on the glasses ("Mikrofon nicht freigegeben. In der Even-App erlauben, dann tippen.") instead of looking like an ignored tap.
- The microphone no longer stays open for ever: it switches off after 60 s without the speech server ("Spracherkennung nicht erreichbar – Mikro aus.") and in any case after 90 minutes.
- A recogniser that throws while stopping no longer leaves the app believing it still listens.
- Leaving through the system (another app, the system menu) closes the microphone; coming back rebuilds the page — the microphone reopens only on a tap. A system exit or crash closes it for good.

### Changed

- Clearing the transcript takes a second hold within 4 s; the footer says "Nochmal halten = Mitschrift löschen".
- New opt-in on the phone, off by default: "Letzte Mitschrift auf diesem Handy behalten" — the last conversation (at most 300 lines) and its summary survive the phone lock and a restart. Clearing the transcript or switching the option off deletes the stored copy. Privacy notes and store text say so.
- Footer "Tippen = Start · 2× = Ende"; the speaker hint names the voice print (ECAPA) instead of "grob an Stimmlage".

## [0.3.0] — 2026-10-13

### Added — conversation companion

- **Streaming speech recognition**: the app asks the server for streaming (`"stream": true`
  in the start frame). A server that supports it re-transcribes a sliding window about
  every 0.8 s and sends provisional lines (`partial`, with the agreed `stable` prefix)
  and final lines; servers without it ignore the flag and keep working as before.
  Reference server: `selfhost/services/whisper/babel_stream.py`.
- **Transcript**: the phone page shows the running conversation (time, speaker,
  translation, provisional line); the glasses show the newest lines, the provisional
  one marked with `…`.
- **Speaker labels** `A:` / `B:` from the server's lightweight change detector
  (pitch + timbre, CPU). Clearly different voices work; similar voices may share a letter.
- **Summary** when you stop listening (tap): short on the glasses, detailed on the phone,
  in the UI language, from your own OpenAI-compatible language model.
- **Explanations**: when the newest line holds a factual question or an unusual term,
  the language model writes a short explanation that pops up on the glasses for 15 s
  (tap closes it) and is listed on the phone. No web search.
- **Header sign** top right: an ear with sound waves while listening, a notebook while
  summarising, a light bulb for an explanation. Captions use the full width.
- Settings: speaker labels, explanations, automatic summary (all on by default).
- The demo (no server) is now a short two-speaker dialogue with a demo explanation and summary.

### Changed

- Hold clears the whole conversation (transcript, summary, explanations).
- Wider caption lines (the body is full width).

## [0.2.3] — 2026-10-13

### Fixed

- Start language: an explicit choice is kept in the Even SDK store (the WebView's localStorage may not survive a relaunch); without one, a German-speaking Even account country (AT/DE/CH/LI/LU) starts the app in German, even when the WebView reports English.

## [0.2.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

All notable changes to Babel Glass are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-10-07

### Changed

- German and English UI.
  - Glasses and phone page follow the phone language (German or English,
    English otherwise); switch it at the top of the phone page and the
    glasses redraw at once. Independent of the caption languages.
  - The status row on the glasses is fitted to one row in both languages:
    the microphone indicator always stays, hints give way first.
  - Server settings on the phone moved under "Advanced: server".
- Store readiness: system exit dialog, privacy policy.
  - A double tap on the root screen now opens the system exit dialog
    (`shutDownPageContainer(1)`). Cancel and the app carries on unchanged;
    timers, streams and sensors stop only after you confirm. A failed call
    is caught and leaves the app running.
  - The microphone closes before the dialog appears and reopens if you cancel.
  - `docs/PRIVACY.md` covers every permission in `app.json`, with a German
    summary, and is linked from the README.
  - Store art in `store/` (icon, 24 px monochrome icon, background,
    tagline), generated by `tools/store-art.mjs`.
  - `min_app_version` raised from 2.0.0 to 2.2.10, the floor of SDK 0.0.16
    that `evenhub pack` already stamped.

### Added
- OpenAI-compatible translation provider (vLLM, Ollama, LM Studio, llama.cpp
  server): strict prompt, temperature 0.1, timeout, optional bearer token,
  cleanup of quotes, preambles and reasoning blocks. Selectable next to
  LibreTranslate in the phone app; both configurations are kept.
- examples/translate-server.py: LibreTranslate-compatible server on Meta
  NLLB-200, covering Belarusian, which Argos/LibreTranslate does not.
- Language selects with Russian, Belarusian, Ukrainian, German, English and
  more, "auto" for the spoken language and a custom-code escape hatch.
  Free-text codes stored by 0.1.0 are normalised on load.
- "Show original as Latin transliteration" (Russian, Belarusian, Ukrainian;
  ASCII output), applied to the original line on the glasses only.
- With the spoken language on "auto", Whisper's detected language is passed
  to providers that need a concrete source (the LLM prompt).
- Translation failures are shown on the glasses (`translate: HTTP 400`)
  instead of being dropped silently.
- Captions already in the target language are not sent for translation.

### Fixed
- Phone app: changing the mode and then the swipe setting (or the reverse)
  silently reverted the first change, because each handler merged into the
  settings captured at render time.
- Phone app: a validation error re-rendered the form and discarded what had
  been typed.
- Wrapping counted UTF-16 units, so decomposed umlauts (u + U+0308) counted
  twice. Captions and translations are now NFC-normalised and wrapped by
  displayed characters.
- Changing the speech server or spoken language while listening had no effect
  until captioning was restarted; the connection is now reopened.
- whisper-server.py: Whisper's lazy segment generator was consumed on the
  event loop, blocking every connection while decoding; a region-tagged or
  unsupported language ("be-BY") made transcription raise and dropped the
  connection; a malformed text frame closed it. Replies keep non-ASCII text
  unescaped.

## [0.1.0] — 2026-09-25

First release.

### Added
- Live captions from the glasses microphone, streamed to a speech recognition
  server the user configures — self-hosted by default rather than by exception.
- Separate, swappable speech and translation providers, so either can be
  self-hosted independently.
- Reference speech server (examples/whisper-server.py), about eighty lines on
  faster-whisper, documenting the wire format by implementing it.
- LibreTranslate-compatible translation, optional.
- Caption buffer that keeps exactly one in-progress line and replaces it on each
  partial result, so revisions do not make the display stutter; only final
  results are committed to history.
- Four modes — Conversation, Lecture, Travel, Caption only — differing in rows,
  width and whether the original is shown beneath the translation.
- Scroll-back through the transcript, with new speech returning to the live edge.
- Automatic reconnection with exponential backoff, because a dropped connection
  cannot be fixed by a user with no hands free.
- Mock speech and translation providers for development without infrastructure,
  labelled MOCK on the glasses so their output cannot be mistaken for real.
- Microphone opens only on explicit tap; MIC shown for as long as it is open,
  with no setting to hide it.
- Tolerant reply parsing accepting several common server response shapes.
- 64 unit tests covering revision handling, history bounds, translation
  attachment, scroll-back, reply parsing, backoff, provider behaviour and
  configuration validation.

### Known limitations
- Latency is dominated by the configured server and model.
- No speaker separation.
- Not yet verified on physical hardware.
