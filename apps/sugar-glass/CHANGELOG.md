# Changelog

## [0.3.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): seine Klicks kommen auf der Brille nie an, und Halten öffnet sonst das Menü statt die App zu erreichen. Die Seiten tragen kein `menuObject` mehr; der Menücode und der `menuItemClickEvent`-Handler bleiben, damit es wieder eingeschaltet werden kann.
- Halten öffnet wieder die Hilfe (2× geht zurück), die Fußzeile sagt wieder `Halten = Hilfe`. Neu laden bleibt auf Tippen. Die Wischrichtung (normal/umgekehrt) gibt es nur noch am Handy (Haken „Wischrichtung umkehren“).

## [0.3.1] — 2026-10-15

### Behoben

- Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben; jetzt hat jeder Aufruf an die Brille ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s), danach gilt der Aufruf als fehlgeschlagen und die Seite wird beim nächsten Zeichnen neu aufgebaut.

## [0.3.0] — 2026-10-14

### Geändert (QIS v1.2)

- **Seitenmenü**: Halten öffnet das Menü der Brille (`menuObject` auf jeder Seite, Klicks über `menuItemClickEvent`, wie Babel und Quiet Hub) mit **Hilfe**, **Neu laden** und **Wischen: normal / umgekehrt**. Der Wischschalter speichert `invertScroll` und baut die Seite einmal neu auf (die Beschriftung nennt den Zustand); er wirkt auch am Handy. Halten selbst öffnet die Hilfe nicht mehr, die Fußzeile sagt `Halten = Menü`; die Hilfe-Seite öffnet sich aus dem Menü, 2× geht zurück. Die Einheit (mg/dL, mmol/L) steht bewusst nicht im Menü der Brille: eine Verwechslung wäre gefährlich, sie bleibt am Handy.
- **Keine HTTP-Codes auf der Brille**: Serverfehler heißen dort `Serverfehler`. Der Statuscode (`Fehler (HTTP 503)`) steht nur am Handy.
- **Demo beim ersten Start** (v1.2 Nr. 7): ohne Serveradresse laufen simulierte Werte mit der Hinweiszeile `Demo · Verbindung am Handy einrichten` (Wert-Seite: zweite Zeile, Pumpen-Seite: statt der Handy-Akku-Zeile) und der Marke `DEMO` in der Kopfzeile, statt der leeren Einrichtungsseite. Der Hinweis „Nur Info – maßgeblich sind Pumpe und Sensor“ bleibt auf der Pumpen-Seite stehen. `?demo=1` ist unverändert und zeigt keine Hinweiszeile. Am Handy bleibt „Erster Start“ mit der Anleitung.
- Werte bleiben reine Information: keine Empfehlung, kein Rat, keine neue Warnlogik; die Kopfzeile zeigt wie bisher Wert und Alter als Zustand.
- Handy: die Bedienungs-Tabelle nennt das Menü bei „Halten“.
- Tests: Menü auf jeder Seite samt Beschriftungen (höchstens 32 Byte), Menü-Hilfe, Menü-Wischschalter (speichert, baut einmal neu auf, kehrt die Richtung um), Menü „Neu laden“, Hinweiszeile in beiden Sprachen und Zeilenbreite, Pumpen-Hinweis bleibt, keine Statuszahl auf der Brille, Halten allein tut nichts.

## [0.2.0] — 2026-10-14

### Geändert

- **Bedienung nach QIS v1** (Quietglass Interaction Standard, `docs/BEDIENSTANDARD.md`): Kopfzeile `SUGARGLASS · Zustand`, Fußzeile immer in der Reihenfolge Tippen → Wischen → Halten → 2× und mit `2× = Ende` bzw. `2× = zurück` am Schluss (ein gemeinsamer `footer()`-Helfer; ist die Zeile zu breit, entfällt zuerst der Wischen-Teil). Tippen lädt nur neu, Wischen wechselt nur die Seite – nichts auf der Brille löscht, stoppt oder sendet etwas.
- **Hilfe-Seite**: Halten öffnet sie von jeder Seite, 2× schließt sie wieder (zurück). Sie listet die Gesten und was die App braucht.
- Handy-Tabs in der festen Reihenfolge **Aktuell · Brille · Verbindung · Mehr** (Server und Token wandern in „Verbindung“); die Bedienungs-Tabelle nennt jetzt auch „Halten“ und schreibt „2×“.
- Der Hinweis „nur Information, keine Therapieentscheidungen“ bleibt unverändert; es kommen keine Empfehlungen hinzu.

## [0.1.2] — 2026-10-13

### Geändert

- Handy-Seite in Tabs statt einer langen Spalte: Aktuell · Brille · Mehr (Tab-Leiste unten, gewählter Tab bleibt), Status-Chip mit dem aktuellen Wert oben. Der Hinweis „keine Therapieentscheidungen“ bleibt über den Tabs sichtbar.

## [0.1.0] — 2026-10-13

### Added

- First version: glucose from your own Nightscout on the Even G2.
- Glucose page: the value in large pixel digits with trend arrow (Nightscout `direction`), change per 5 min, minutes since the reading, and the last 3 hours as a dot curve with the target band (70–180 by default) and the urgent-low line.
- Alerts, worst first, pulsing in the header and as a label on the value: very low (< 54), low (< 70), high (> 250), no current value (> 15 min), falling fast (double arrow or ≤ −15 mg/dL in 5 min).
- Pump page: SmartGuard mode (when reported), insulin on board, reservoir, pump and phone battery, sensor time left and state, last meal and bolus.
- Phone page: mg/dL ↔ mmol/L, target range, alert limits, server address, optional token; notice "for information only".
- `examples/sugar-bridge.mjs`: read-only proxy in front of Nightscout with a Tailscale login allow-list; it adds a "readable" token server-side so the app needs none.
- Private builds: `VITE_NS_URL` sets the address (never a token).
- Demo mode `?demo=1` with `&scene=normal|low|urgent|high|stale|falling`, `&page=2` for the pump.
