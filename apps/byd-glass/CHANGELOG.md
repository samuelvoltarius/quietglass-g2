# Changelog

## [0.7.0] — 2026-10-23

### Neu (Entscheidung Alfred 23.10.2026, Regeln der Panoptes-Abstimmung)

- **Seite „Steuern“ auf der Brille** (QUS v1, Textliste): genau **Zusperren**, **Aufsperren** und **Vorheizen 10 / 20 / 30 min**. Kein Klima-aus (die Sitzung endet von selbst), keine Temperaturwahl. Die Seite gibt es nur, solange die Bridge `control.enabled` meldet, und sie zeigt nur die Einträge, die die Bridge annimmt; schaltet die Bridge ab, verschwindet sie sofort.
- **Jeder Befehl braucht zwei Taps:** der erste fragt die Bridge (sie prüft alles und sendet nichts; eine Ablehnung zeigt die Brille mit dem Text der Bridge, z. B. „Auto ist an – am Display bedienen“), der zweite **binnen 4 s** sendet. Wischen oder 2× bricht ab, nach 4 s verfällt die Frage („nicht gesendet“). Keine Fußzeile bietet „Halten“ an.
- **Ergebniszeile nur aus der Bridge:** „gesendet – warte auf das Auto …“, dann „bestätigt“ oder „nicht bestätigt“ (die Bridge bestätigt nur aus frischer Telemetrie nach dem Befehl). Bleibt die Antwort auf den zweiten Tap aus: „keine Antwort – unklar, ob gesendet“, bis der Befehlsstand der Bridge Klarheit bringt. Nie ein falscher Erfolg.
- Handy, Tab „Auto“: Karte „Steuern“ (was die Bridge erlaubt, ob das Auto aus ist, wie der letzte Befehl ausging). Das Handy selbst sendet nichts.
- Die Demo bietet keine Steuerung und sendet nie etwas.

### Bridge (`selfhost/services/byd-bridge`)

- Befehle nur mit `BYD_CONTROL=1` (weiterhin Standard `0`), Aufsperren zusätzlich `BYD_ALLOW_UNLOCK=1`, Vorheizen `BYD_PREHEAT=1`. **Immer aktiv, nicht abschaltbar, fail-closed:** frisches `power_level` 0 von `surfmate/vehicle/telemetry/power_level` (live, ≤ 180 s, retained zählt nie), Rückfrage mit Einmalwert (8 s), ≥ 15 s Abstand, ≤ 6 Befehle pro Stunde (in `BYD_RATE_FILE`, übersteht Neustarts), Telegram-Meldung **vor** jedem Aufsperren (fehlt sie oder schlägt fehl: abgelehnt), kein Klima-aus, JSONL-Log ohne Einmalwert/Geheimnis/Token.
- Steuerweg nur noch der signierte Kanal von pybyd-mqtt: Zusperren und Vorheizen über `cmd/signed`, Aufsperren über das eigene Thema `brille/unlock`. Unsignierte Themen und `BYD_ACTION_URL` entfallen (`BYD_LOCK_TOPICS`, `BYD_CLIMATE_TEMP_TOPIC`, `BYD_ACTION_URL` werden ignoriert).
- Vorschlag für pybyd-mqtt / `befehl_gate.py` (Vorheizen mit Dauer, Aufsperren nur von der Brillen-Quelle, Telegram durch das Gate selbst) liegt als Patch unter `proposed/` – nur gemeinsam mit der Panoptes-Sitzung einspielen. Bis dahin funktioniert von der Brille nur Zusperren.

## [0.6.0] — 2026-10-23

### Geändert (Panoptes-Abstimmung 23.10.2026, verbindlich)

- **Daten von Panoptes statt Overdrive.** Die Auto-App Panoptes (Nachfolger von Overdrive, für viele BYD-Modelle) meldet unter `surfmate/vehicle/telemetry/<feld>`. Die byd-bridge liest standardmäßig dieses Thema (`BYD_TOPIC`, Overdrive bleibt per Umgebung möglich). Neue Zuordnung: Schloss aus `unlocked_lf` (statt `locked`), Türen aus `door_open_lf/rf/lr/rr` (statt `door_open`), dazu Kofferraum/Motorhaube (`trunk_open`, `hood_open`, mit Warnung), Kilometerstand direkt aus `odometer`, Gebläsestufe (`ac_fan`, sonst `ac_wind`), Reifentemperaturen (`tyre_t_*`). Die alten Overdrive-Namen werden weiter gelesen.
- **Keine Fahrzeugbefehle mehr von der Brille.** Seite „Steuerung“ (Klima an/aus, Zusperren, Aufsperren) samt Rückfragen entfernt, ebenso die Steuer-Karte am Handy und der Befehlsaufruf im Client. Keine Fußzeile und keine Hilfezeile bietet einen Befehl an. Die Bridge lehnt `POST /command` standardmäßig mit `403 control_disabled` ab (`BYD_CONTROL` ist jetzt `0`; `1` nur mit Freigabe der Panoptes-Abstimmung) und sendet dann nichts an den Broker.
- **Keine „Innentemperatur“.** Der Dolphin Surf hat keinen Innenraumfühler; `climate_setpoint` ist der Sollwert (17–33, 25 = neutral). Brille und Handy zeigen beim Klima nur noch an/aus und die Stufe („AN · STUFE 2“), nie eine Temperatur.
- **Fehlende Werte werden weggelassen, nie als 0 gezeigt.** Panoptes läuft auf vielen Modellen: Cockpit-Zellen ohne Wert fallen weg und der nächste bekannte Wert rückt nach (z. B. 12 V, Außen, SoH); am Handy verschwinden Zeilen, Kennzahlen und Reifenkarten ohne Wert. Der Status-Kopf lässt ein unbekanntes Schloss weg.
- Fußzeilen bieten kein „Halten“ mehr an (vom Bügel kommt Halten nie an, Schrittprotokoll 21.10.): „Tippen = Warnungen · Wischen = Seite · 2× = Ende“. Die Hilfeseite bleibt per Ring-Halten erreichbar und listet nur Tippen, Wischen, 2×.
- Store-Text, Berechtigungstext und Datenschutz auf „nur Anzeige“ angepasst; Vorschau-Bilder neu erzeugt.
- Bridge: neue Tests `test_byd_bridge.py` (Themen-Zuordnung mit echter Panoptes-Stichprobe, fehlende Felder, Befehle standardmäßig abgelehnt – nur Fakes, kein Broker).

## [0.5.0] — 2026-10-20

### Geändert (QUS v1 „keine Textwand“)

- **Brille: Fahrt, Laden und Status sind jetzt ein Cockpit-Bild** statt Bildern plus Textzeilen. Links der Akku-Ring (Ladestand groß in der Mitte, darunter die eine Zeile, die gerade zählt: Warnung, Verbindungsproblem oder „Stand 14:05“); rechts klein „BYD  14:05“, **eine große Aussage** (Fahrt: Tempo; Laden: Ladeleistung oder FERTIG; Status: Reichweite) und sechs Kennzahlen in drei Spalten (Fahrt: Leistung, Verbrauch, Reichweite, Klima, Außen, Trip; Laden: Reichweite, geladen, Rest, Typ, Zellen, Stand; Status: km, Klima, Schloss, Türen, Reifen, Stand). Eine offene Tür, ein unversperrtes Auto oder ein Reifenproblem rahmen ihre Kachel. Unten eine Hinweiszeile. Es werden nur geänderte Kacheln gesendet (die Uhr allein ändert nur oben rechts); während der Beenden-Dialog offen sein kann, wird keine Kachel gesendet.
- Steuerung, Warnungs-Überlagerung, Hilfe und Wartebild bleiben Textseiten (die doppelte Bestätigung ist unverändert).
- **Handy: genau drei Tabs in einer Zeile** (Jetzt / Auto / Einstellungen) im Look von Rain Lens: Statusbanner, Hero-Karte mit dem Ladestand, 2×2-Kennzahlen, Karten-Leiste der Reifen; „Auto“ mit Laden, Details und Steuerung (eingeklappt); „Einstellungen“ mit Bridge-Karte (eingeklappt, sobald eingerichtet), Brille, Sprache und Mehr. Erststart: Drei-Schritt-Checkliste, die Demo läuft ohne Bridge.
- Das animierte Auto-Zeichen mit Blinkern entfällt (das Cockpit ersetzt es). Die Kopfzeile der Warnungen pulsiert weiter auf den Textseiten.
- Vorschau-Bilder: `store/preview-cockpit.png` (+ `-warn`), erzeugt mit `QG_PREVIEW=1 npx vitest run tests/cockpit.test.ts`.
- Unverändert: kein Seitenmenü, Beenden-Dialog (4/5-Ablauf), begrenzte Aufrufe, Neuaufbau der ersten Seite, doppelte Bestätigung jedes Befehls.

## [0.4.7] — 2026-10-17

### Behoben (Hardware-Schrittprotokoll)

- **Beenden-Dialog: Ereignis 4 und 5 direkt nach dem Aufruf sind das Erscheinen und Schließen des Dialogs, nicht die App.** Am Gerät gemessen: `shutDownPageContainer(1)` liefert `true` nach ca. 60 ms (nur „Aufruf angenommen“), FOREGROUND_ENTER (4) kommt ca. 150 ms später, wenn der Dialog aufgeht, und FOREGROUND_EXIT (5), wenn er nach „Nein“ wieder verschwindet; bei „Ja“ folgt auf die 5 nach ca. 0,5 s das Systemende (7). Die App liest 4 nach dem Aufruf jetzt als „Dialog steht“ (nichts wird darübergezeichnet) und 5 als „Dialog weg“: nach „Nein“ kommt die Seite sofort ohne Geste wieder, Stream und Timer laufen unverändert weiter, nichts wird pausiert. Ein 2× auf der Startseite fragt dann sofort wieder.

## [0.4.6] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.4.5] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.
- Systemende (Ereignis 6/7) beendet jetzt ausdrücklich die App.
## [0.4.4] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

## [0.4.3] — 2026-10-15

### Neu

- **Werte aus der BYD-Cloud, wenn das Auto schweigt:** Meldet das Auto selbst (Overdrive) nichts Frisches, nimmt die Brücke Ladestand und Reichweite aus der BYD-Cloud (dieselben Werte wie in Home Assistant). Die Brille kennzeichnet das mit „Cloud“ hinter dem Ladestand; am Handy steht, wie alt die Cloud-Werte sind.
- **Standort des Autos** am Handy (Status): Link „In Google Maps öffnen“ mit Alter der Position; dazu der Kilometerstand.

## [0.4.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Seine Klicks kommen auf der Brille nie an, und solange eine Seite ein Menü trägt, öffnet Halten das Menü statt die App zu erreichen (Schrittprotokoll 15.10.2026). Die Seiten tragen kein `menuObject` mehr; der Menü-Code und der `menuItemClickEvent`-Handler bleiben.
- Halten öffnet wieder die Hilfe (Gestenseite; nur 2× geht zurück); in einer Autobefehls-Rückfrage bricht Halten weiter ab, in der Temperaturwahl tut es nichts.
- Fußzeilen nennen `Halten = Hilfe` wieder (fällt bei zu breiter Zeile nach dem Wischen weg, 2× bleibt); Hilfetexte und Handy-Gestentabelle beschreiben wieder die Gesten statt des Seitenmenüs.
- Wischen und Tippen wie bisher: Wischen = Seite bzw. Auswahl, Tippen = Warnungen bzw. wählen/bestätigen.

## [0.4.1] — 2026-10-15

### Behoben

- Die Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben. Jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s); danach gilt der Aufruf als fehlgeschlagen und die Seite wird neu aufgebaut.

## [0.4.0] — 2026-10-14

### Geändert — Bedienstandard QIS v1.2 (docs/BEDIENSTANDARD.md)

- **Seitenmenü der Brille** (Halten → Systemmenü, SDK `menuObject` / `menuItemClickEvent` wie Babel Glass und Quiet Hub): `Hilfe`. Die App hat keine eigenen Einstellungen auf der Brille, deshalb nur dieser Eintrag. Hilfe schließt eine Warnungs-Einblendung und eine offene Autobefehls-Rückfrage (nichts bleibt dahinter scharf) und zeigt die Gestenseite; nur 2× geht zurück. Die Seite trägt das Menü bei jedem Aufbau neu, ein Sprachwechsel baut sie einmal neu auf.
- **Halten öffnet keine Hilfe mehr** und steht in keiner Fußzeile mehr. Es bricht weiter eine Autobefehls-Rückfrage ab (Rückfrage oder letzte Bestätigung), sonst tut es nichts.
- **Sicherheit unverändert:** Autobefehle behalten beide Bestätigungen und die 8-s-Frist je Schritt (strenger als die 4 s des Standards, bewusst: Auto). Nichts an Bridge oder Protokoll geändert.
- **Erster Start = Demo:** Ohne Adresse läuft die Demo wie bisher; neu führt die Fußzeile der Seiten Auto/Laden/Status mit `Demo · Verbindung am Handy einrichten · 2× = Ende` (Wischen und Tippen fallen weg, wenn die Zeile zu breit wird; die Steuerungsliste behält ihre Gesten).
- **Keine HTTP-Codes auf der Brille:** „Serverfehler“ ohne Statuszahl. Das Handy (Tab „Verbindung“) zeigt weiter `Serverfehler (503)`.
- Handy: Gestentabelle nennt das Seitenmenü bei Halten.
- Tests: Menü mit „Hilfe“ auf der Seite, Halten allein öffnet nichts, Menü-Hilfe lässt eine Rückfrage verfallen, Demo-Fußzeile in beiden Sprachen und innerhalb der Zeilenbreite, keine Statuszahl auf der Brille.

QIS-Stand: v1.2.

## [0.3.0] — 2026-10-14

### Geändert (QIS v1)

- Folgt dem Quietglass-Bedienstandard (QIS v1, `docs/BEDIENSTANDARD.md`).
- Sicherheit: Autobefehle behalten beide Bestätigungen (Rückfrage, dann nach kurzer Pause die letzte Bestätigung) und die 8-s-Frist. Neu: Wischen oder Halten in einer Rückfrage bricht ab (vorher wurde Wischen ignoriert), die Fußzeile sagt `Nochmal tippen = weiter|SENDEN · Wischen/2× = abbrechen`. Temperaturwahl: Wischen ±1 °C wie bisher. Nichts an Bridge oder Protokoll geändert.
- 2× ist nur noch zurück: in der Warnungs-Einblendung schließt es sie (vorher verließ es die App), auf den Seiten bleibt es Ende.
- Kopfzeile ist `BYD · Zustand`; Fußzeilen kommen aus einem `footer()`-Helfer in der Reihenfolge Tippen/Wischen/Halten/2× und enden auf `2× = zurück` oder `2× = Ende` (Wischen fällt zuerst weg, wenn die Zeile zu breit wird). „Tippen = Warnungen“ steht nur, wenn Warnungen da sind.
- Halten öffnet eine Hilfeseite mit den Gesten (auf allen Seiten, auch ohne Verbindung).
- Handy: Reiter `Auto · Laden · Steuern · Brille · Verbindung · Mehr`. „Brille“ enthält den Schalter für die Wischrichtung und die Gestentabelle; die Bridge-Adresse liegt unter „Verbindung“; „Mehr“ hat Sprache, Datenschutz und Version.

## [0.2.1] — 2026-10-13

### Geändert

- Steuern: Zusperren und Aufsperren stehen jetzt ganz oben, Klima darunter. Ablauf und doppelte Bestätigung unverändert.

## [0.2.0] — 2026-10-13

### Sicherheit

- **Doppelte Bestätigung für jeden Befehl** (Zusperren, Aufsperren, Klima an, Klima aus): Auswahl → Rückfrage
  „Wirklich aufsperren? Tippen = weiter, 2× = abbrechen“ → nach ~1 s Pause die anders aufgebaute letzte
  Bestätigung „LETZTE BESTÄTIGUNG >>> AUFSPERREN <<< · Tippen = senden“. Tippen in der Pause zählt nicht,
  Doppeltipp bricht in jedem Schritt ab, jeder Schritt läuft nach 8 s ab, Wischen in einer Rückfrage tut nichts.
- **Auto an = keine Steuerung**: Meldet die Bridge `car_on`, zeigt die Steuerung „Auto ist an – Steuerung nur bei
  ausgeschaltetem Auto“, alle Punkte sind gesperrt und es wird nichts gesendet. Wird das Auto während einer
  Rückfrage eingeschaltet, schließt sie sich; die Sperre wird direkt vor dem Senden noch einmal geprüft.

### Neu

- Klima an mit Wunschtemperatur (die Bridge kann `climate_temp`): erst Temperatur wählen (Wischen ±1 °C, 16–28 °C),
  dann die zwei Bestätigungen. Die Punkte „Temperatur +/−“ entfallen.
- Handy-Seite, Tab Steuern: Regeln erklärt (nur bei ausgeschaltetem Auto, Aufsperren nur in P bei 0 km/h, doppelte
  Bestätigung, Temperatur wählen) und Hinweis, wenn das Auto gerade an ist.
- Demo: im Fahr-Modus ist das Auto „an“, Befehle werden wie bei der Bridge abgelehnt.

## [0.1.0] — 2026-10-13

### Neu

- Erste Version: dein BYD auf der Even G2, Daten von der eigenen `byd-bridge` (Overdrive-Telemetrie über MQTT).
- Startseite nach Modus: Fahrt (großes Tempo, Tempo-Warnung, Akku % + Reichweite, Leistungsbalken mit
  Rekuperation, Verbrauch 50 km, Blinker/Fernlicht im Symbol), Laden (Akku-Balken mit Lauflicht, kW, Restzeit,
  kWh, AC/DC, „fertig“), Status (Schloss, Türen, vier Reifen mit Druck und Druckverlust, 12 V, SoH, Zellen, außen).
- Steuerung mit Rückfrage: Klima an (16–28 °C), Temperatur ±, Klima aus, Zusperren, Aufsperren (nur im Stand und
  nur, wenn die Bridge es erlaubt); Ergebnis von der Bridge in der letzten Zeile.
- Warnungen erscheinen neu über jeder Seite, danach pulsierend in der Kopfzeile.
- Long-Poll (`/state?since=&wait=25`), nur einfache Anfragen ohne Preflight; Befehle als text/plain-POST.
- Handy-Seite in Tabs statt einer langen Spalte: Auto (Status, Schloss, Reifen, 12 V) · Laden · Steuern
  (was die Bridge erlaubt, letzter Befehl, Bedienung) · Mehr (Bridge-Adresse, Wischrichtung, Sprache);
  Status-Chip oben, Warnungen immer sichtbar über den Tabs.
- Ohne Bridge-Adresse: Demo mit erfundenen Werten und Hinweis auf der Handy-Seite. Privater Build: `VITE_BYD_URL`.
