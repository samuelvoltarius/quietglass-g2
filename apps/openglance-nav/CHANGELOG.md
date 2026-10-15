# Changelog

## [0.17.13] — 2026-10-15 (privat, Beta)

### Behoben

- **Keine Nebenstraßen auf der Karte:** die Straßen wurden einmal für den Rahmen der ganzen Route angefragt; ab 25 km Ausdehnung absichtlich gar nicht (auf einer 116-km-Fahrt also nie). Die Karte folgt aber dem Auto. Jetzt kommen die Straßen aus der Umgebung des Autos (Radius 1,9 km im Auto, 1,2 km zu Fuß, mit Nebenstraßen bzw. Wegen) und werden nachgeladen, sobald man sich dem Rand auf 600 m nähert – vom eigenen Overpass-Server. Protokoll `streets` (Dauer, Anzahl, Fehler).

## [0.17.12] — 2026-10-15 (privat, Beta)

### Behoben (Brille + Schritt-Protokoll)

- **HUD läuft** (0.17.11 bestätigt: Seite angenommen) – Ursache war der 16-Zeichen-Bildname bzw. die Bildmaße.
- **App hing nach 2× in der Fahrt:** 2× öffnete die Beenden-Rückfrage des Systems; nach „Abbrechen“ schlug jeder Aufruf an die Brille mit `InvalidAccessError` fehl, die Anzeige blieb auf dem letzten Bild stehen. Jetzt öffnet 2× in der Fahrt die System-Rückfrage nicht mehr, sondern fragt selbst „Nochmal tippen = Stopp“; Tippen beendet die Navigation und führt zur Ziel-Liste (dort neues Ziel wählen). In der Liste beendet 2× die App wie bisher; wird dort „Abbrechen“ gewählt, baut die App die Seite neu auf (Protokoll `exit`).

## [0.17.11] — 2026-10-15 (privat, Beta)

### Behoben (Versuch 2, Schritt-Protokoll 0.17.10)

- **HUD-Seite weiter abgelehnt, auch mit 8 Containern** – die Anzahl war es also nicht. Der Vergleich mit den angenommenen Seiten zeigt zwei Dinge, die nur der HUD hat: der Bildname `hud-arrow-bottom` hat 16 Zeichen (Doku: „max 16 chars“; alle angenommenen Namen ≤ 13) und Bildhöhen von 100 und 62 px (angenommen: 144 und 56, Vielfache von 8). Jetzt: Namen `hud-arr-top`/`hud-arr-bot`, Pfeil 192 × 192 (zwei Hälften 192 × 96), Tempo-Bild 184 × 64. Ein Test hält Namen ≤ 13 Zeichen und Bildseiten in 8er-Schritten.

## [0.17.10] — 2026-10-15 (privat, Beta)

### Behoben (Schritt-Protokoll 0.17.9)

- **Die Brille lehnte die HUD-Seite bei jedem Aufbau ab** („rebuild refused“, je ~2 s) – deshalb blieb nach dem Wischen die Karte stehen und der HUD erschien nie. Die HUD-Seite hatte 10 Container (6 Text + 4 Bild); angenommen werden Seiten mit 8 (Abbiegen) und 7 (Karte), am 14.10. hing auch der HUD mit 9. Jetzt hat der HUD 8: Entfernung und Straße teilen sich ein zweizeiliges Feld unter dem Pfeil, „ZU SCHNELL“ steht in der Hinweiszeile, wenn dort nichts anderes steht (das Tempo-Bild ist bei zu schnell ohnehin invertiert). Ein Test hält alle Seiten bei höchstens 8 Containern.

## [0.17.9] — 2026-10-15 (privat, Beta)

### Geändert

- **Brillen-Liste ohne „zuletzt“-Zeilen:** nur noch Termine, Favoriten, Routen, Laden/Gipfel. Ein gesprochenes Ziel steht nur in der Liste, solange es das aktive Ziel ist.

### Neu

- **„Wo ist mein Auto“** in der Brillen-Liste (private Fassung mit BYD-Brücke): der letzte von der BYD-Cloud gemeldete Standort mit Alter („vor 12 min“); Tippen führt zu Fuß hin. Der Standort steht unter einer festen Kennung und landet in keiner Liste.
- **Eigene Ortssuche** (private Fassung, `VITE_GEOCODER_URL`, Dienst `selfhost/services/glass-geocode`): fragt Photon und Nominatim gleichzeitig und merkt sich Antworten einen Tag, spricht wie Photon. Gemessen 0,2–1 s statt 13–15 s.

### Behoben

- Ortssuche brach nach 10 s ab, Photon brauchte unterwegs 13–15 s: Zeitlimit jetzt 20 s.

## [0.17.8] — 2026-10-15 (privat, Beta)

### Neu

- **HUD-Layout auf der Brille wählen:** im Auto schaltet Wischen der Reihe nach HUD → klassisch → Karte (andere Richtung rückwärts); die Wahl bleibt gespeichert und steht auch am Handy.
- **Akku und Reichweite aus der BYD-Cloud**, wenn das Auto selbst schweigt (Brücke `battery.src: "cloud"`), im HUD mit „Cloud“ markiert; Cloud-Werte älter als 3 h werden nicht gezeigt.
- **Eigener Overpass-Server** (private Fassung, `VITE_OVERPASS_URL`, nur Tailnet; Österreich, Deutschland, Italien): Straßen der Karte, Blitzer und Gipfel kommen dort zuerst her, weil die öffentlichen Server unterwegs 406/429 lieferten. Außerhalb, oder wenn der eigene nicht erreichbar ist, wie bisher die öffentlichen.

### Behoben

- Das Schritt-Protokoll schrieb bei 0.17.7 noch „0.17.6“; die Version kommt jetzt aus `app.json`.

## [0.17.7] — 2026-10-15 (privat, Beta)

### Behoben (aus dem Schritt-Protokoll der echten Brille)

- **Wischen kam in der Fahrt-Ansicht nie an.** Die Eingabe lag auf der kleinen Textzeile unter dem Straßennamen; sobald deren Text nicht hineinpasste, scrollte die Firmware ihn selbst und die App sah kein Wischen (laut Even-Doku: „If content overflows and the container has isEventCapture: 1, the firmware scrolls it.“). Jetzt fängt auf allen Bildseiten (Abbiegen, HUD, Karte, Gipfel) ein leeres Vollbild-Textfeld hinter allem die Eingabe – das von Even empfohlene Muster für Bild-Apps. Wischen = Abbiegen ↔ Karte.
- **Stoppen auf der Brille:** Halten kam im Protokoll nie an. Ein Tippen ohne andere Aufgabe fragt jetzt nach dem Stopp, ein zweites Tippen binnen 4 s beendet (Halten tut dasselbe, falls es ankommt).
- **Brille lehnt jeden Seitenwechsel ab** (0.17.5, 114 km: Anzeige blieb auf „Route wird berechnet“): nach 3 Ablehnungen in Folge baut die App die Seite wie beim Start neu auf (rebuild + create), protokolliert als `page.recover`.

### Protokoll

- `nav.start` meldet Modus und HUD-Layout (der HUD erscheint nur im Modus Auto – im Protokoll war er nie zu sehen), `lag` meldet die Sichtbarkeit der Seite (~750 ms jede Sekunde = Handy drosselt die verborgene Seite, kein blockierter Thread).

## [0.17.6] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- **Seitenmenü vorerst aus.** Das Schritt-Protokoll von 0.17.5 zeigt: die Brille zeigt das Menü, aber seine Klicks kommen nie in der App an, und solange eine Seite ein Menü hat, öffnet Halten das Menü statt die App zu erreichen. Damit waren Ansicht, HUD-Layout, Tempo-Hinweise und „Navigation beenden“ unerreichbar.
- Zurück zu den Gesten, die auf der Brille funktionieren: **Wischen** wechselt Abbiegen ↔ Karte, **Halten** fragt nach dem Stopp, **Tippen** bestätigt (alles andere bricht ab). HUD-Layout und Tempo-Hinweise am Handy. Schalter `SIDE_MENU` in `src/main.ts`, sobald Menü-Klicks ankommen.

## [0.17.5] — 2026-10-15 (Diagnose-Version, privat)

### Neu

- **Schritt-Protokoll für Fehler, die nur auf der echten Brille auftreten** (nur private Fassung mit eigenem Verkehrsdienst): jeder Aufruf an die Brille mit Dauer und Ergebnis, jedes Ereignis von der Brille (Tippen, Menü, System), jeder Seitenwechsel, Routen-Phasen, Fehler und Hänger des JS-Threads gehen alle 3 s an `POST <Verkehrsdienst>/diag` (nur Tailnet). Keine Positionen. Anlass: lange Routen bleiben auf „Route wird berechnet…“ stehen und 2× reagiert nicht, im Test nicht nachstellbar.

## [0.17.4] — 2026-10-15 (Store-Fassung 0.17.3)

### Behoben

- **Navigation blieb wieder auf „Route wird berechnet…“ stehen** (15.10., St. Michael → Salzburg, mit 0.17.1): Route, Tempolimits und Verkehr waren in gut einer Sekunde da, aber die Brille nahm die HUD-Seite nicht an - die App versuchte es alle 5 s neu, die Anzeige blieb auf der vorigen Seite. Jetzt schaltet die App nach zwei abgelehnten HUD-Seiten für diese Sitzung auf die klassische Abbiege-Seite um, die die Brille annimmt. Warum die Brille die HUD-Seite ablehnt, ist noch offen (auf Hardware zu klären).

## [0.17.1] — 2026-10-15

### Behoben

- **Anzeige blieb auf „Route wird berechnet…“ hängen** (14.10., Salzburg → St. Michael im Lungau): Die Route war nach 0,03 s da und die Tempolimits kurz danach geholt - die App lief weiter, nur die Brille zeigte nichts Neues mehr. Die Anzeige-Updates laufen nacheinander, und auf die Antwort der Brille wurde ohne Zeitlimit gewartet: eine einzige verlorene Bluetooth-Antwort hielt jede weitere Anzeige auf. Jetzt ist jeder Aufruf begrenzt (Seite 8 s, Text 5 s, Bild 10 s); bleibt die Antwort aus, gilt die Seite als kaputt und wird beim nächsten Takt neu aufgebaut, alle Texte werden neu geschrieben.

## [0.17.0] — 2026-10-14

### Neu

- **Große Tempo-Zahl im HUD**: Die Geschwindigkeit steht links unter dem Tempolimit-Schild in großen Ziffern (49 px hoch statt Textgröße) mit kleinem `km/h`. Die Brille kennt nur eine Schriftgröße (SDK 0.0.16: kein Größenfeld am Textcontainer), daher ist die Zahl das vierte (und letzte erlaubte) Bild der HUD-Seite, 184 × 62.
- **Zu schnell** dreht die Zahl um (helle Fläche, dunkle Ziffern) - sichtbar ohne zu lesen; das geht sofort raus. `GPS` steht klein über `km/h`, wenn die Auto-Verbindung auf das Handy-GPS zurückgefallen ist.
- Gesendet wird nur, wenn sich die angezeigte Zahl ändert, höchstens einmal pro Sekunde; die Texte (Entfernung, Hinweise) gehen immer zuerst raus, die Zahl bremst sie nicht. Ein Fix bei gleicher Geschwindigkeit schickt nichts.

## [0.16.0] — 2026-10-14

### Geändert (QIS v1.2)

- **Seitenmenü der Brille** (`menuObject`, Klicks über `menuItemClickEvent`): Hilfe, Ansicht (Abbiegen / Karte), HUD-Layout wechseln, Tempo-Hinweise ein/aus (beides auch aus der Liste) und **Navigation beenden**. Das Menü gehört zur Seite: es wird nur beim Seitenwechsel neu gesetzt (Liste ↔ Navigation, Sprachwechsel), nie pro GPS-Fix oder im 1-s-Takt. Die Einträge sind Umschalter bzw. setzen den Wert ausdrücklich, kein Eintrag zeigt einen Zustand (dafür müsste die Seite neu gebaut werden).
- **Hilfe** ist keine Listenzeile mehr, sondern ein Menüeintrag; sie öffnet über der Seite, von der aus sie geöffnet wurde. Aus einer laufenden Navigation kommt man mit 2× oder Tippen dorthin zurück - die Navigation wird dabei nicht verworfen.
- **Stopp**: Halten (und der Abstand „Halten, dann Tippen“) stoppt/fragt nichts mehr. Der erste Klick auf „Navigation beenden“ fragt (`Nochmal tippen = stoppen · Wischen/2× = abbrechen`), ein zweiter Klick auf den Eintrag oder ein einzelnes Tippen innerhalb von 4 s stoppt; Wischen, Halten, 2×, ein anderer Eintrag oder 4 s ohne Eingabe brechen ab. Ein Tippen unmittelbar nach dem Klick (400 ms) zählt nicht als Bestätigung.
- **Ansicht**: Wischen während der Navigation wechselt die Ansicht nicht mehr (und speichert nichts); „Ansicht: Abbiegen“ / „Ansicht: Karte“ im Menü setzen sie ausdrücklich.
- **2× in der Routenwahl**: geklärt - dort führt noch nichts; 2× geht zurück zur Liste und beendet nur den noch nicht begonnenen Start. Liefe schon eine Navigation, wäre 2× wie überall der Beenden-Dialog des Systems, nie ein stilles Stoppen.
- **Fußzeilen** kommen alle aus dem gemeinsamen `footer()`-Helfer (`src/glasses/footer.ts`, Reihenfolge Tippen/Wischen/Halten/2×, Wisch-Teil zuerst weg, wenn die Zeile zu breit ist). Aus der Nachrichtentabelle sind alle `*Footer`-Sätze verschwunden; übrig sind Aktionswörter (`w.*`). Fehler- und Start-Seite ohne „Halten = stoppen“; Aufnahme-Seite `Tippen = fertig · 2× = zurück`.
- Handy: neuer Tab **Verbindung** (Routenserver, Ortssuche-Server, Demo-Route) in der Reihenfolge Ziel · Routen · (Gipfel) · Brille · Verbindung · Mehr; Wischrichtung und echte Straßen wanderten nach „Brille“, „Mehr“ hat Sprache und Quellen. Die Gestentabelle sagt „2×“ statt „Doppelt tippen“ und nennt das Seitenmenü.
- HUD-Latenz unverändert (`docs/HUD-LATENZ.md`): keine Bild-Uploads pro Fix, kein Seiten-Neubau pro Fix oder Tick - getestet (`tests/hud-main.test.ts`).
- Tests: Menü je Seite (Namen, 32 Byte), Stopp per Menü-Klick/Tippen/Abbruch/Ablauf, Hilfe über der Navigation, Ansicht ohne Wischen, HUD-Layout- und Tempo-Hinweise-Umschalter, Footer-Helfer, Tab-Reihenfolge.

## 0.15.1

- Verkehrsdienst angebunden (eigener Dienst im Tailnet): Stau, Sperren und Umfahrungen erscheinen, sobald dort eine Datenquelle (TomTom/ASFINAG) eingetragen ist.

## [0.15.0] — 2026-10-14

### Neu: Routenwahl, Tempo-Hinweise an festen Messstellen, Verkehr und Umfahrung

- **Routenwahl (Auto)**: beim Start ohne Zwischenstopps fragt OpenGlance den Router nach bis zu zwei weiteren Wegen (Valhalla `alternates: 2`). Bietet er mehr als einen an, zeigt die Brille vor dem Start bis zu drei Zeilen, z. B. `A 34 min · 41 km · A1 · +12 min Stau` / `B 38 min · 33 km · B158 · Akku −2 %`: Zeit, Strecke und was die Wege unterscheidet, so weit es passt – Stau (mit Verkehrsdienst), Akku-Unterschied zum schnellsten Weg (nur mit Auto-Verbindung; Verbrauch des Autos, über 80 km/h Schnitt etwas mehr), Maut (wenn der Router es sagt), Hauptstraße. **Wischen** = wählen, **Tippen** = los, **2×** = zurück zur Liste. Nur ein Weg: keine Wahl. Neuberechnungen und eine nach dem Beenden durch das Handy wieder aufgenommene Navigation nehmen ohne Frage den schnellsten.
- **Tempo-Hinweise an festen Messstellen** (Standard an, nur Auto): etwa 300 m vor einer in OpenStreetMap eingetragenen festen Messstelle (`highway=speed_camera`, Geräte von `enforcement=maxspeed`-Relationen), bei hohem Tempo mindestens 10 s vorher, neutral `Tempo beachten · 50` (Limit der Messstelle, sonst das aktuelle). Abgefragt einmal pro Route über Overpass (Korridor-Rechtecke, gemerkt). Vorrang unter Zucker niedrig & fallend, Bremshinweis und Stau/Sperre unter 3 km, über Akku, Termin, Ladesäule. Auf der Brille steht nie „Blitzer“ oder „Radar“.
  - **In Deutschland immer aus** (StVO § 23 Abs. 1c): grober Umriss Deutschlands; im 20-km-Grenzband entscheidet eine Rückwärtssuche beim Ortssuche-Server (nur die Mitte einer ~1-km-Zelle, nur wenn eine Messstelle voraus ist), bis dahin und bei Fehlern bleibt der Hinweis aus. Eine Route ganz in Deutschland fragt Overpass gar nicht. README erklärt den Grund neutral (keine Rechtsberatung).
  - **Handy**, Tab „Brille“: „Tempo-Hinweise (feste Messstellen)“ mit Hinweis zu Deutschland.
- **Verkehr (privater Build, `VITE_TRAFFIC_URL`)**: neuer eigener Dienst `selfhost/services/glass-traffic` (Python, nur Standardbibliothek) mit TomTom Traffic Incidents v5 + Flow (Schlüssel nur am Server) und ASFINAG DATEX II (Registrierung nötig, siehe README des Dienstes). Die App schickt nur die Routenlinie voraus an den eigenen Dienst – nie die Position an TomTom.
  - Vor dem Start: Verzögerung je Weg in der Routenwahl (`+12 min Stau`, `Sperre`).
  - Beim Fahren: alle 2 min und nach einer neuen Route (frühestens 15 s nach der letzten Anfrage, nie zwei gleichzeitig): `Stau in 4,2 km · +9 min`, `Sperre in 800 m`, `Baustelle in …` (nur mit Verzögerung), bis 30 km voraus.
  - **Umfahrung**: mit ≥ 5 min Verzögerung (oder Sperre) voraus werden die anderen Wege des Routers mit ihrem eigenen Verkehr verglichen; spart einer ≥ 5 min: `Umfahrung spart 7 min · Tippen`, **Tippen** nimmt ihn. Das Tippen gilt nur, solange genau diese Zeile zu sehen ist (sonst wie bisher: neue Route abseits der Route, Laden in der Nähe bei knappem Akku) – kein Konflikt mit bestehenden Tipp-Bedeutungen, daher kein Seitenmenü-Eintrag nötig. Fahrten mit Zwischenstopps: kein Umfahrungsangebot.
  - Hinweis-Vorrang gesamt: Zucker niedrig & fallend › Bremshinweis › (Zu schnell, Mitte, eigenes Feld) › Zucker niedrig › Stau/Sperre < 3 km › Tempo-Hinweis › Umfahrung › Stau weiter weg › Akku › Termin › Ladesäule.
- Klassisches Layout: dieselben Hinweise in der kleinen Zeile unter der Karte (statt der Ladesäule).
- QIS v1.1: Routenwahl mit Kopf `OPENGLANCE · Route wählen`, Fußzeile `Tippen = los · Wischen = wählen · 2× = zurück`; Hilfe-Zeile 4 nennt die Umfahrung. Alle neuen Texte in Deutsch und Englisch auf Breite geprüft.
- Tests: Alternativen (Parsen, nur Auto ohne Stopps), Routenwahl-Zeilen/Breiten/Wischen, Messstellen (Overpass-Abfrage, Relationen, Korridor, Abstand mit Tempo, Wortwahl), Deutschland-Prüfung (Umriss, Grenzband, Rückwärtssuche je Zelle mit Drosselung), Vorrang, Verkehr (Parsen, Abstand entlang der Route, Texte, Abfrage-Takt ohne Sturm, Umfahrungs-Entscheidung), App mit Fake-Bridge (Routenwahl, 2×, Stau, Umfahrung per Tippen, Anzahl Anfragen, Neuberechnung ohne Wahl); Dienst: 13 Python-Tests mit erfundenen TomTom-/DATEX-Antworten.
- Der private Build braucht die Origin des Verkehrsdienstes in der Whitelist der (nicht eingecheckten) `app.private.json` (`build-private.mjs` trägt `services.traffic` ein).

## 0.14.1

- Termine aus dem Tagesstart brauchen keinen Schlüssel mehr im Paket: hinter `tailscale serve` erkennt der Daemon den Träger am Tailscale-Login. `VITE_BRIEF_TOKEN` ist optional.

## [0.14.0] — 2026-10-14

### Neu: HUD-Layout fürs Auto, Bremshinweis, Zu-schnell-Warnung, Reichweite – und weniger Verzögerung

Nach einer Testfahrt: die Navigation wirkte verzögert, das Layout lenkte ab, die Pfeile waren zu klein. Analyse mit Zahlen: `docs/HUD-LATENZ.md`. Vorschau: `docs/hud-preview.png`.

- **Weniger Verzögerung (alle Layouts)**: Zeichenaufträge stauen sich nicht mehr hinter langsamen Bild-Uploads – während eines Zeichnens laufende Anfragen teilen sich genau ein folgendes, das den neuesten Stand zeigt. Unveränderte Textfelder werden nicht mehr neu geschrieben. GPS-Intervall ausdrücklich 1 s. Nach einem Seitenaufbau kennt der Renderer die Texte darauf (behebt Geisterzeichen beim ersten kürzeren Update).
- **HUD-Layout (Auto, Standard „neu“)**, im Stil eines Head-up-Displays, einfarbig, Mitte frei:
  - **rechts**: großer Abbiegepfeil 200 × 200 px (vorher 144), darunter die Entfernung und eine Zeile Straße,
  - **links**: Tempolimit-Schild, darunter das aktuelle Tempo (`52 km/h`, zu schnell `!57! km/h`, `GPS` bei Rückfall aufs Handy),
  - **oben links klein**: Ankunft · Rest-km · Zucker (wie seit 0.12) und `Akku 72% → 41% · 180 km`,
  - **unten Mitte genau eine Hinweiszeile**, Vorrang: Zucker niedrig & fallend › Bremshinweis › Zucker niedrig › Akku bei Ankunft knapp › Termin (Ankunft früh/spät) › nächste Ladesäule.
  - Nur Pfeil (bei neuem **Manövertyp**) und Schild (bei neuem **Limit**) sind Bilder; Entfernung, Tempo und alle Zeilen sind Text. Pro GPS-Punkt wird **kein** Bild gesendet. Die Entfernung läuft zwischen zwei Fixes mit dem Tempo weiter (höchstens 4 s), ein 1-s-Takt aktualisiert nur Text.
  - Abseits der Route, Neuberechnung, GPS-Suche und „Nochmal tippen = Stopp“ erscheinen auf derselben Seite (kein Seiten-Neubau).
  - **Handy**, Tab „Brille“: „HUD-Layout (Auto)“ neu / klassisch. Klassisch = die bisherige Abbiegeseite. Zu Fuß und mit dem Rad unverändert.
- **Bremshinweis**: aus den Tempolimits der Route (einmal pro Route geladen) werden die Stellen gesucht, an denen das Limit sinkt (z. B. Ortsschild 100 → 50). Rollstrecke d = (v² − vₜ²) / (2·0,8 m/s²) + 3 s·v → `▼ 50 in 300 m – vom Gas`; Bremsstrecke mit 1,5 m/s² + 1 s·v → `BREMSEN · 50 in 120 m` (nach dem Schild `BREMSEN · 50 jetzt`). Bleibt stehen, bis das Tempo höchstens 5 km/h über dem neuen Limit liegt (oder das Schild 150 m zurückliegt); springt nie von „Bremsen“ zurück auf „vom Gas“. Ohne bekannte Limits kein Hinweis. Kein Ton, keine Vibration (das SDK hat dafür keine API).
- **Zu schnell** (Mitte des Sichtfelds): `ZU SCHNELL  58 / 50`, wenn das Tempo das aktuelle Limit um mehr als 3 km/h (bis 50) bzw. 5 km/h (darüber) übersteigt – erst nach 2 s am Stück, weg nach 2 s darunter. Nie bei unbekanntem Limit oder wenn die Position, aus der das Limit stammt, älter als 10 s ist. Während die Warnung steht, schweigt der Bremshinweis (die Zeile zeigt den nächsten Hinweis). Nur Text.
- **Reichweite**: die Reichweite der byd-bridge (`battery.range_km`), sonst geschätzt aus SoC × nutzbare kWh (Einstellung, Standard 43,2) ÷ Verbrauch (50-km-Wert des Autos, sonst 16 kWh/100 km wie bisher), dann mit `≈` markiert.
- **Tempolimits der ganzen Route** am öffentlichen Router: lange Routen in bis zu 4 Teilanfragen nacheinander (1,1 s Abstand, wie bisher nur einmal pro Route); der eigene Server bekommt weiter eine Anfrage.
- Tests: Bremsformeln und -zustände, Hinweis-Vorrang, Zu-schnell-Schwellen/Verzögerung/unbekanntes Limit/Vorrang, Fortschreibung, Reichweite, Layout in den Grenzen der G2 (≤ 4 Bilder ≤ 288 × 144, ≤ 8 Texte, ≤ 12 Container, ein Eingabefeld, SDK-Validierung, Mitte frei), Zeilenbreiten Deutsch/Englisch für alle Manöver, Bild-Uploads mit Fake-Bridge gezählt.
- QIS v1: unverändert; Pfeil, Tempo und Hinweise in Deutsch und Englisch auf Breite geprüft.

## [0.13.0] — 2026-10-14

### Neu: Termine von heute in der Zielliste (privater Build, optional)

- **Quelle**: der eigene Quiet-Hub-Daemon (`GET /brief/appointments`, Bearer-Token wie `/report`). Er mischt die eigenen Kalender (ICS) und Shoot-Day-Projekte des Tages und findet die Orte; OpenGlance fragt sonst niemanden. Build-Variablen `VITE_BRIEF_URL` (Daemon-Adresse) und `VITE_BRIEF_TOKEN` (nur private Builds). Fehlt eines davon: nichts angezeigt, keine Anfrage.
- **Wann gefragt**: beim Start und alle 5 min, solange die Zielliste zu sehen ist (6 s Zeitlimit, eine Anfrage zur Zeit; auch nach einem Fehler erst wieder nach 5 min). Fehler bleiben still: die Liste behält, was sie hatte. Kein Abfragen während der Fahrt.
- **Zielliste**: heutige Termine mit gefundenem Ort, die noch kommen oder vor höchstens 30 min begonnen haben (höchstens 3), stehen **zuerst**, markiert mit `▸`, z. B. `▸ 10:30 Kunde … · Musterdorf`. Die Markierung sitzt in der Cursor-Spalte, die Zeile hat 42 Zeichen: zuerst kürzt sich der Titel (ganze Wörter, „…“), Zeit, Ort und Abfahrt bleiben; ist für den Titel kein Platz mehr, entfällt er. Ganztägige Termine und solche ohne gefundenen Ort erscheinen nicht. Der Cursor bleibt auf seinem Eintrag, wenn Termine dazukommen oder wegfallen.
- **Tippen** = hinfahren (mit dem Auto, der normale Ablauf). Nur der Ort landet wie jedes Ziel unter „zuletzt“, der Titel bleibt im Speicher der App.
- **Vor der Abfahrt**: ist die Fahrzeit bekannt (vorhandene Routenanfrage, höchstens eine je Termin alle 5 min, nur solange die Liste offen und ein Standort da ist), zeigt die Zeile `los in 12 min`, `jetzt los!` oder bei mehr als 90 min `los um 13:45` (spätester Aufbruch = Beginn − Fahrzeit − 5 min Puffer).
- **Während der Fahrt zum Termin**: die Fußzeile der Abbiegeseite sagt `Ankunft 10:22 · 8 min früher`, `· 5 min zu spät` oder `· pünktlich` (passt in die Zeile: notfalls ohne „Ankunft“, dann ohne Akku, dann ohne Strecke). Auf der Karte ein kurzes `8 früh` / `5 spät` hinter dem Tempo, wenn es auf die Platte passt. Die Zucker-Warnung hat Vorrang; kurz vor einer Abbiegung entfällt die Fußzeile wie bisher. Nur Text-Aktualisierung über den normalen Zeichenweg, kein Seitenneubau pro GPS-Punkt.
- **Bei Ankunft** eine zusätzliche Zeile `Termin: <Titel> · Babel: Kundengespräch` (nur ein Hinweis). Ist die Karte eingestellt, wechselt die Brille bei Ankunft am Termin einmal auf die Textseite, damit die Zeile Platz hat.
- Nach einem Neustart der App findet eine wieder aufgenommene Navigation ihren Termin über den Ort (±50 m) wieder.
- **Handy**: Schalter „Termine aus dem Tagesstart“ im Tab „Brille“ (nur sichtbar, wenn der Build Daemon-Adresse und Token hat; dann standardmäßig an). Im Demo und mit der Demo-Route aus.
- QIS v1: Zielliste mit Terminen (alle Cursor-Positionen) und Ankunftsseite in Deutsch und Englisch auf Breite, Fußzeilen-Reihenfolge und Ende geprüft; die Fahrt-Fußzeile in allen Varianten (Akku, Zucker, Demo, früh/spät) höchstens 56 Zeichen.
- Der private Build braucht die Daemon-Origin in der Whitelist der (nicht eingecheckten) `app.private.json`.
- Datenschutz: Termindaten kommen nur vom eigenen Daemon (`docs/PRIVACY.md`).

## [0.12.0] — 2026-10-14

### Neu: Zucker im Fahr-HUD (privater Build, optional)

- **Kleiner Wert mit Trendpfeil** (z. B. `128↗`) beim Autofahren mit Route: in der Fußzeile der Abbiegeseite (vor einer Abbiegung entfällt die Fußzeile wie bisher) und auf der Karte hinter dem Tempo. Nur Information, nie ein Rat.
- **Quelle**: dein eigener Nightscout-kompatibler Server (`GET /api/v1/entries/sgv.json?count=3`), Adresse aus dem Build (`VITE_SUGAR_URL`, optional `VITE_SUGAR_TOKEN` als `?token=`). Einmal pro Minute, nur während der Navigation im Auto. Ohne Adresse: nichts angezeigt, keine Anfrage.
- **Alt**: über 15 Minuten wird der Wert als `128?` markiert (ohne Pfeil, ohne Warnung), über eine Stunde ausgeblendet.
- **Warnung** bei unter 80 mg/dl und fallend (FortyFiveDown/SingleDown/DoubleDown) oder unter 70 mg/dl in jede Richtung: `! 72↓ niedrig & fallend` bzw. `! 65→ niedrig` ersetzt die Fußzeile (auf der Karte die Tempo-Zeile), auch kurz vor einer Abbiegung, bis der Wert wieder passt. Kein Ton, keine Vibration.
- **Handy**: Schalter „Zucker im Fahr-HUD“ im Tab „Brille“ (nur sichtbar, wenn der Build eine Adresse hat; dann standardmäßig an).
- **Ruhig**: Netzwerkfehler ändern nichts an der Anzeige und lösen keinen Seitenneubau aus; der Text wird über den normalen, verglichenen Zeichenweg aktualisiert. Keine neuen Container.
- Der private Build braucht die Server-Origin in der Whitelist der (nicht eingecheckten) `app.private.json`.
- Datenschutz: Zuckerwerte kommen nur von deinem eigenen Server (`docs/PRIVACY.md`).

## [0.11.0] — 2026-10-14

### Geändert (QIS v1)

- Bedienung nach dem Quietglass-Bedienstandard (QIS v1, `docs/BEDIENSTANDARD.md`).
- **Sicherheit:** Halten beendet die Navigation nicht mehr. Halten fragt nur („Nochmal tippen = stoppen · Wischen/2× = abbrechen“, über der Karte „Nochmal tippen = Stopp“); ein einzelnes Tippen innerhalb von 4 s beendet, Wischen, zweites Halten, 2× oder 4 s ohne Eingabe brechen ab. Ein Tippen unmittelbar nach dem Halten (unter 0,4 s, das Loslassen selbst) zählt nicht.
- 2× bricht eine offene Stopp-Frage ab, statt die App zu verlassen; in Sprechen, Laden, Gipfel und Hilfe geht 2× zurück, in der Navigation bleibt es „Ende“ (mit Systemfrage, Navigation bleibt gemerkt).
- Angekommen: Tippen führt zur Zielliste (vorher Halten).
- Kopfzeilen `OPENGLANCE · Zustand`, Fußzeilen in der Reihenfolge Tippen/Wischen/Halten/2× und mit `2× = zurück` oder `2× = Ende`; „Doppeltipp“ heißt überall „2×“. Kopf und Fuß dürfen 56 Zeichen lang sein (`ROW_WIDTH`), Textzeilen weiter 46. Die Fahrt-Fußzeile (Rest-Strecke, Ankunft) bleibt wie sie war: im Auto soll nichts anderes dort stehen.
- Neue Hilfeseite („Hilfe“, letzter Eintrag der Zielliste) mit den Gesten der App. `invertScroll` gilt wie bisher für die Listen (Wischrichtung am Handy umkehrbar).

## [0.10.0] — 2026-10-14

### Neu: Gipfel in der Nähe

- **Brille, Kompassband**: neuer Listeneintrag „Gipfel in der Nähe …“ (am Handy einschalten, Tab „Gipfel“). Oben ein Band mit Kompass-Skala (±60°, N/NO/O … beschriftet), die Gipfel als Dreiecke nach ihrer Richtung relativ zur Blickrichtung, darüber Name, Höhe und Entfernung („GAISBERG / 1287M 5,2KM“) in bis zu drei Zeilen ohne Überlappung; außerhalb des Bandes nur gezählt (Pfeil + Anzahl am Rand). Gezeigt werden die 7 nächsten – Wischen schaltet auf die 7 höchsten.
- **Blickrichtung**: beim Gehen/Fahren der GPS-Kurs (ab ~1 m/s, nicht älter als 15 s), im Stehen die am Handy gesetzte „Blickrichtung im Stehen“ (N, NO … NW), sonst Norden oben. Unter dem Band steht, welche gilt („Richtung 245° SW · GPS-Kurs“), dazu Anzahl und höchster Gipfel.
- **Liste**: Tippen auf dem Band öffnet die nach Entfernung sortierte Liste („2,3 km · NO · Gaisberg 1287 m“), Wischen wählt, Tippen navigiert hin (wie ein gesprochenes Ziel: landet unter „zuletzt“), Halten zurück zum Band, Doppeltipp zurück zur Zielliste.
- **Handy, neuer Tab „Gipfel“**: Umkreis 10/25/50 km, Blickrichtung im Stehen, Knopf „Gipfel laden“, Liste mit Entfernung, Richtung (Himmelsrichtung + Grad) und Höhe; „Als Ziel“ übernimmt einen Gipfel mit der vorhandenen Ziel-Logik. Hinweis „© OpenStreetMap-Mitwirkende (ODbL)“.
- **Daten sparsam**: `natural=peak` mit `name` und `ele` über die öffentliche Overpass-API, als Formular-POST ohne eigene Kopfzeilen (kein Preflight). Pro Gebiet (5-km-Zelle, Radius + 4 km) genau eine Anfrage, gespeichert am Handy (bis 4 Gebiete, 30 Tage; ein größerer Radius bedient einen kleineren). Kein Abfragen im Hintergrund: nur beim Öffnen der Seite, auf Knopfdruck oder einmal beim Betreten einer neuen Zelle, während die Seite offen ist; höchstens alle 20 s.
- Server der Reihe nach: overpass-api.de (neu in der Whitelist), overpass.private.coffee. Am 14.10.2026 mit curl geprüft: overpass-api.de antwortet mit `Access-Control-Allow-Origin: *`, zeitweise 504; maps.mail.ru bewusst nicht genutzt (Standort darf nicht dorthin), overpass-api.de 406 ohne Browser-Referer.

## 0.9.0
- **Auto-Verbindung (privater Build, `VITE_BYD_URL`)**: OpenGlance liest beim Autofahren mit Route alle ~5 s den Stand der eigenen byd-bridge (`GET /state`, einfache Anfrage ohne eigene Kopfzeilen, kein Preflight; sonst alle 60 s für die Handy-Zeile). **Nur lesen** – an das Auto wird nie etwas gesendet.
- **Tempo vom Auto**: ist der Wert frisch (Bridge nicht `stale`, jünger als 10 s), zeigt die Brille das Tempo des Autos statt des GPS. Sonst wie bisher GPS, dezent markiert: „GPS“ in der sonst leeren Zeile der Tempo-Spalte bzw. „km/h·GPS“ auf der Karte; die Spaltenbreite bleibt.
- **Akku bei Ankunft** in der Fußzeile der Abbiegeseite: „87 % → ~62 %“ = Akku jetzt − Rest-km × Verbrauch (letzte 50 km vom Auto, sonst 16 kWh/100 km) ÷ nutzbare Kapazität. Die Bridge liefert keine Kapazität → neue Handy-Einstellung „Akku nutzbar (kWh)“, Vorgabe 43,2 kWh (Dolphin Surf, großer Akku).
- **Warnung unter 10 %**: „Ankunft ~6 % – Ladestopp planen“ unter der Straße (vor der nächsten Ladestation), Fußzeile „Tippen = Laden in der Nähe“ – ein Tippen öffnet die vorhandene Liste „Ladestation in der Nähe“.
- Handy-Seite, Tab Routen: Abschnitt „Auto (BYD)“ mit „Auto verbunden: 87 % · 296 km“ (bzw. „Bridge antwortet nicht“) und der Kapazität.

## 0.8.1
- Handy-Seite in Tabs statt einer langen Spalte: Ziel · Routen · Brille · Mehr (Tab-Leiste unten, gewählter Tab bleibt), Status-Chip mit dem aktiven Ziel oben.

## 0.8.0
- **Geschwindigkeit auf der Brille** (Auto und Rad): aktuelle km/h aus dem GPS, geglättet; „—“ statt 0, wenn unbekannt oder älter als 5 s. Abbiegeansicht: schmale Spalte links neben dem Pfeil, Karte: Zeile unten links auf eigener Platte („52 | 50 km/h“).
- **Tempolimit** der aktuellen Straße aus Valhalla `trace_attributes` (`edge.speed_limit`, dazu `edge.speed`) – in derselben einen Anfrage pro Route, die schon die Straßennamen holt. Mehr als 5 km/h drüber: „!57!“ (die Anzeige ist nur grün, also Hervorhebung als Text). Öffentlicher Router (FOSSGIS): eine Anfrage 1,2 s nach der Route, bei langen Routen nur der Anfang, der in eine normale URL passt.
- **Google Maps ohne Google-API**: „In Google Maps öffnen“ für das gewählte Ziel, die Planung und jede gespeicherte Route (Handy und PC-Seite). Ins Suchfeld lassen sich Google-Maps-Links (`?q=`, `/place/…/@…`, `!3d…!4d…`, `/dir/…`, `?ll=`) und Koordinaten einfügen – sie werden ohne Suchserver zum Ort. Kurzlinks (maps.app.goo.gl) gehen ohne Server nicht; die App sagt das.
- **Live-Spracherkennung** beim Ziel per Sprache (privater Build, `VITE_LIVE_STT_URL`): die Wörter erscheinen beim Sprechen auf der Brille, beim Loslassen wird der Live-Text genommen. Verbindet der Live-Server nicht binnen 3 s oder bricht ab, geht die Aufnahme wie bisher an `VITE_STT_URL`. Aufnahme-Sicherheitsgrenze 30 s statt 8 s.

## 0.7.2
- Gespeicherte Routen werden mit einem eigenen Routen-Speicher abgeglichen (`VITE_ROUTES_URL`, privater Build): am PC geplante Routen stehen in der Zielliste, am Handy gespeicherte/gelöschte am PC. Abgleich beim Start, beim Öffnen der Zielliste und nach jeder Änderung.
- Neue PC-Planungsseite (`planner.html`, `npm run build:pc`) mit Karte (Leaflet/OSM), Ladestationen und Speichern.
- Routen-IDs sind jetzt geräteübergreifend eindeutig; Löschungen werden gemerkt, damit sie überall ankommen.

## [0.9.1] — 2026-10-14

### Behoben

- Nach „Angekommen“ hing die Brille: Schlug der Seitenwechsel einmal fehl, wurde er bei jedem neuen GPS-Punkt erneut versucht – jeder Versuch blockiert die Brille für Sekunden. Jetzt höchstens alle 5 s ein neuer Versuch, und die Ankunftsseite wird nicht mehr bei jedem GPS-Punkt neu gezeichnet.
- Akku (jetzt und bei Ankunft, über die BYD-Bridge) erscheint auch in der Karten-Ansicht, nicht nur in der Pfeil-Ansicht.

## [0.7.1] — 2026-10-13

Street names and charging stations from your own servers in a private build,
because the public Overpass servers were unreliable (overpass-api.de answered
406, overpass.private.coffee timed out).

### Added

- **`VITE_STREETS_URL`** (private build; `selfhost/build-private.mjs` sets it to
  the own Valhalla): the street names along the route come from Valhalla's
  `trace_attributes` with the route's own shape - one GET `?json=` without a
  preflight, measured 0.13 s for a city route and 0.24 s for Salzburg-Vienna
  (17 000 shape points). Consecutive edges of one street are joined, so a
  road gets one label. The streets around the route still come from Overpass
  when it answers and join in; failure of either is silent as before.
- **`VITE_CHARGERS_URL`** (private build): charging stations from your own
  read-only server (`selfhost/services/chargers`): official registers
  (E-Control Austria incl. the ad-hoc price per kWh, Bundesnetzagentur
  Germany), plain GET `/chargers?lat&lon&radius` or `?boxes=…`, the answer in
  Overpass element format so the parser is unchanged. Overpass is not asked
  then; at most one request every 5 s instead of 30 s.
- **Price per kWh** ("0,59 €/kWh") on the glasses' "Charging nearby" list and
  in the phone's list along a planned route, when the server knows it.
- Development only: `?chargers=1` switches charging stations on in the
  simulator.

### Unchanged

- Without the two variables (public build) everything works as in 0.7.0 with
  the public Overpass servers. Error texts are the same.

## [0.7.0] — 2026-10-13

Plan routes ahead on the phone, save them, and charging stations for the
electric car (wish from Alfred: "Wege online planen und speichern, und
Ladestationen (optional)").

### Added

- **Route planner on the phone**: start (a searched place, or the position at
  the moment of starting), up to three stops, destination, car / bike / on foot.
  "Route berechnen" routes once through all points (Valhalla `locations`,
  same GET `?json=` without preflight), preview with distance, time and a line
  drawing of the route (SVG from the route's own points, no map tiles, no new
  hosts). "Route speichern" under a name; saved routes can be edited, renamed
  and deleted.
- **Saved routes on the glasses**: in the destination list after the places
  (`↑`, "Route, 2 Stopps"). Tap starts from the current position: near the
  planned start as planned, far from it but close to the planned line joined
  there (stops behind are left out), otherwise straight to the first stop.
  Arrivals at stops are turns of their own ("Stopp 1: Ladepark") and are
  announced as stops. A reroute keeps the stops not yet passed.
- **Charging stations** (switch on the phone, off by default), OpenStreetMap
  `amenity=charging_station` via the public Overpass API (already used for the
  overview streets, so no new origin): along a planned route (2 km corridor,
  distance from the start, power, sockets CCS/CHAdeMO/Typ 2, places; "Als
  Stopp" inserts it in order and recalculates); "Ladestation in der Nähe" on
  the glasses list (three nearest fast ones, ≥ 50 kW where known, tap
  navigates); while driving "Laden in 12 km · 150 kW" under the road and a
  marked plate on the overview map. At most one request per 30 s, answers
  reused, 18 s timeout, errors in words. Bicycle-only and private stations are
  left out. Credits: "Ladestationen: OpenStreetMap über Overpass API (ODbL)".
- **Navigation resumes** after the phone ended the app (screen lock, Even
  review criterion): the running navigation is remembered (`activeSince`) and
  picked up again at the next start when it is less than 6 h old; a hold, the
  arrival or leaving with double tap forgets it.
- System lifecycle events: back in front redraws the page; ended by the system
  switches microphone, GPS and timers off.

### Fixed

- A microphone permission that answered only after the 5 s timeout left the
  microphone on; it is now switched off as soon as that late answer arrives.
- Without a speech server (public build) the list no longer advertises "Halten
  sprechen".
- `selfhost/build-private.mjs` now also sets the speech server (`VITE_STT_URL`)
  for OpenGlance.

## [0.6.0] — 2026-10-13

Destinations are chosen on the glasses, and can be spoken (user feedback from the
real glasses, beta 0.5.5: "only shows the route to Tamsweg, does not let me pick
another one or start it, no voice input").

### Added

- **Destination list as the start page**: saved places, then the last five
  destinations ("zuletzt"), at most five visible around the cursor; the active
  destination is marked `●`, the cursor `→`. Swipe chooses, tap starts navigation
  and makes it the active destination. The footer names the gestures.
- **Travel mode on the glasses**: the last row of the list ("Unterwegs: Auto"),
  tap switches car → bike → on foot.
- **Speaking a destination**: hold on the list records from the glasses
  microphone until release (hard stop after 8 s), the recording goes as WAV to the
  own Whisper server (`VITE_STT_URL`, form post without extra headers, so no CORS
  preflight), the words are looked up with Photon; up to three places, swipe
  chooses, tap navigates, hold saves as a favourite. Without a speech server, too
  short, nothing understood, server or place search unreachable: each says so on
  the glasses with what to do. The microphone is always switched off again
  (release, double tap back, exit, timeout).
- Spoken destinations that were not saved are kept as recent ones (`recent` in the
  stored data, at most five, same place within ~30 m replaced).
- Development only (vite dev server): `?at=lat,lon` position, `?to=lat,lon,Name`
  destination, `?heard=Text` instead of the transcription, for the simulator.

### Changed

- **A start always shows what it is doing**: "Suche Standort…" while waiting for
  the GPS (only when no fix younger than 2 min is known; before, every start
  waited up to 12 s for a new fix with nothing changing on the glasses),
  "Route wird berechnet…" while routing. Hold cancels.
- **Errors in plain words with the way out**, two lines: "Kein GPS-Standort. /
  Standort für Even am Handy erlauben.", "Routing-Server nicht erreichbar. /
  Tailscale / Internet am Handy an?", "Routing-Server antwortet nicht.", "Keine
  Verbindung. / Das Handy ist offline."; footer "Tippen = nochmal · Halten =
  Zielliste".
- Hold while navigating stops and goes back to the destination list; on arrival
  the footer says so.
- Private build: the speech server origin is whitelisted and the `g2-microphone`
  permission declared.

### Findings (start problem)

- The own Valhalla answered every route the glasses asked for on 13.10. (log on
  the server: four requests from the phone's GPS position to Tamsweg - car, on
  foot, bike, car - all HTTP 200 in 0.05–0.5 s), and in the simulator with the real
  servers tapping started navigation. The start itself worked; what was missing
  was a way to choose another destination on the glasses (a tap while navigating
  did nothing, hold only went back to "Ziel: Tamsweg") and any sign of progress
  while the GPS was being asked.


## [0.5.3] — 2026-10-13

Street names on the map (user feedback from the real glasses: "the overview needs
street names").

### Added

- **Street labels on the map**: bold capitals, 14 px tall, own pixel font, in a
  black box with a 1 px border. Shown: the street of the next turn, the street the
  car is on, and up to three more big streets in view. Horizontal whatever way the
  map is turned, never overlapping each other, the car, the turn ring, the
  destination, the compass or the text plate; at most 16 characters
  ("Straße" becomes "Str.", longer names are cut with a dot).
- Overpass query now asks for `tags` of roads (footpaths without); `name`, else the
  first `ref`, is read from the answer.
- The text line top left adds the street: "→ 300 m · Linzer Gasse" (shortened to
  fit, or left out).
- Demo (`?demo=1&scene=map`) draws named example streets.

### Changed

- The very first page per bridge is preceded by one ignored `rebuildPageContainer`
  (measured on real glasses: otherwise taps may not arrive); then `create` exactly
  once, afterwards only rebuilds.
- The mock route uses German street names (Rainerstraße, Linzer Gasse, Hellbrunner Allee).

## [0.5.0] — 2026-10-13

Readable at a glance while driving (user feedback: "map too small ... impossible
while driving").

### Changed

- **Turn view**: a big arrow (144 x 144, 32 px strokes) on the left; the distance
  to the turn in huge pixel digits (70 px tall, twice the old height, rounded:
  "950 m", "150 m", "1,2 km") on the right with a thick eight-block approach bar
  beneath; the road name in bold type across the full width (drawn as an image
  in two 288 x 56 halves, because the glasses text is too small); a footer with
  remaining distance and arrival time, also while driving. Within 200 m of the
  turn the footer goes: only arrow, distance and road remain.
- **Map**: fills the whole display (four 288 x 144 images), heading-up when a
  direction is known (route ahead, GPS heading off route), north-up otherwise;
  thick route, the car as a large chevron low on the picture, ring on the next
  turn, destination square, compass; zoom in steps so the next turn is always
  visible. One short line of text on a plate top left: the next turn,
  "-> 960 m". It is sent only when the route, streets, turn or zoom step change,
  and otherwise at most every 4 s after 12 m of travel or 12 degrees of turn;
  tiles that look the same are not resent.
- Distances on the big card are rounded calmly: 50 m steps from 200 m, 10 m below.
- Three glasses pages: turn view (4 images), map (4 images), plain text (none).
  At most four images per page, exactly one input-capturing container.

### Fixed

- **The map stayed empty** (most visibly in the demo): switching the view called
  `createStartUpPageContainer` a second time, which the glasses refuse as
  "invalid", so the map image was never sent. Pages after the first are now
  replaced with `rebuildPageContainer`.
- The demo route had no corners (a straight line); it now has a right turn, a
  bending road and a roundabout. Demo-only URL parameter `scene=far|near|map`
  starts on a given picture.

## [0.4.2] — 2026-10-13

### Fixed

- Start language: the Even app's WebView reports English even on a German phone.
  An explicit language choice is now kept in the SDK store; without one, a German-speaking
  Even account country (AT/DE/CH/LI/LU) starts the app in German.

## [0.4.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

## [Unreleased]

### Added
- Real streets on the overview map: OpenStreetMap data from the public
  Overpass API, one request per route (after 1.5 s on the overview), main
  roads bright, side streets dim, footpaths faint and only on foot; cut to the
  picture and capped. Falls back to the route alone on any failure. Switch
  under Advanced; attribution on the phone page; PRIVACY.md updated.
- Turn card: the distance to the turn in large pixel digits and an eight-block
  approach bar that fills as the turn comes closer.

### Changed
- Images are sent only when they change: the arrow on a new manoeuvre, the
  card when its digits or bar change (at most every 2 s while counting
  down), the overview marker after 6 px and 5 s. Previously the arrow went
  out with every text update and the overview with every ~11 m.
- The fake diagonal grid behind the overview route is gone.
- Double tap asks the glasses for the exit confirmation
  (`shutDownPageContainer(1)`); cancelling keeps navigating.
- Pixel arrow drawn larger (80 px); U-turn and roundabout patterns fixed to
  the 10 × 10 grid.

## [0.4.0] — 2026-10-06

Works right after install, for anyone. Map Glass is merged in.

### Added
- Routes through the free public OpenStreetMap routing server of FOSSGIS e.V.
  (`valhalla1.openstreetmap.de`) when no server is entered — nothing to host.
  Its terms are kept: at most one request per second, automatic reroutes at
  least 15 s apart, an `X-Client-Id`, attribution with a fix-the-map link.
- Place search by name or address via Photon (`photon.komoot.io`), on an
  explicit Search only, with a cache and a rounded position bias. "Go here"
  saves the result and selects it in one step.
- Overview map on the glasses, ported from Map Glass with its projection
  fixes (uniform scale, centring, antimeridian) and tests. Swipe switches
  between the turn arrow and the overview; the choice is remembered.
- German and English, following the device language, with real umlauts.
- Plain error messages: no GPS, no connection, server busy, no way found,
  too far for the chosen way of travel.
- First-run guidance on phone and glasses; travel choice as words and icons.

### Changed
- An empty router address now means the public server, not the mock. The
  demonstration route is a separate switch under Advanced and is labelled
  `DEMO` (was `MOCK`).
- Walking is the default way of travel.
- Server addresses, demo route, coordinates and swipe direction moved under
  "Advanced". `app.json` now declares the network and location permissions.

## [0.3.0] — 2026-10-05

- Replaced the ambiguous fixed pixel symbol with large manoeuvre-specific
  arrows for left, right, straight, U-turn, roundabout, and arrival.
- Kept the text arrow as a redundant fallback next to the distance.

All notable changes to OpenGlance Navigation are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-25

First release.

### Added
- Turn-by-turn navigation on OpenStreetMap data via Valhalla — no API key, no
  account, no quota, and self-hostable.
- Walking, cycling and driving modes. Driving deliberately shows only the
  arrow, the distance and the road name; a test asserts the footer stays empty
  so decoration cannot creep back in.
- Automatic rerouting after three consecutive fixes more than 40 m off route,
  with a single stray fix ignored so GPS noise cannot discard a valid route.
- Manoeuvre progress measured along the route rather than by proximity, so a
  road that doubles back does not announce the wrong turn.
- Polyline decoding at explicit precision, with a test pinning the
  factor-of-ten difference between Valhalla's precision 6 and the more common 5.
- Position projection onto the route, used for both off-route detection and
  remaining distance.
- Arrival detection that stays arrived even if a later fix drifts.
- Provider interface with a Valhalla implementation and a mock router for
  development without a server, labelled MOCK on the glasses.
- Valhalla manoeuvre types mapped to a normalised set, with unknown types
  defaulting to "straight" rather than inventing a turn.
- Saved places and coordinate entry; no geocoding, deliberately, so no third
  service is required.
- Location updates use a 5 m distance filter to spare battery while stationary,
  and stop when navigation stops.
- 68 unit tests covering geodesy, polyline decoding, projection, Valhalla
  parsing, manoeuvre advancement, reroute hysteresis, arrival and the display.

### Known limitations
- No map: text and an arrow only, which is what 576 x 288 monochrome allows.
- No geocoding, lane guidance, waypoints or speed display.
- Valhalla only; OSRM and GraphHopper fit the interface but are not implemented.
- **Not verified on physical hardware.** The simulator supplies no GPS, so the
  position pipeline is covered by unit tests with synthetic fixes rather than by
  a real journey. Do not rely on it as your only navigation.
