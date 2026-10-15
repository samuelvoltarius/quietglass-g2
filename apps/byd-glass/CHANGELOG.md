# Changelog

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
