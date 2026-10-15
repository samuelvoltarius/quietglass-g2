# BYD Glass

**Quietglass** · Dein BYD auf der Even G2 — Tempo, Akku, Laden, Reifen und Warnungen im Blickfeld,
Klima und Schloss mit Rückfrage. Gebaut und getestet mit einem BYD Dolphin Surf (DiLink 3).

> **Inoffiziell, ohne Verbindung zu BYD.** Die App liest nur, was deine eigene **byd-bridge** liefert
> ([`selfhost/services/byd-bridge`](../../selfhost/services/byd-bridge/README.md)). Fernbefehle können verspätet,
> gar nicht oder doppelt ankommen — prüfe das Ergebnis im Auto oder in der BYD-App.
> Während der Fahrt gilt: Blick auf die Straße. Die Fahrt-Seite zeigt nur, was das Auto selbst schon anzeigt.

> **Auf Deutsch, kurz:** BYD Glass wählt die Startseite selbst: **beim Fahren** großes Tempo (vom Auto), Tempo-Warnung,
> Akku % + Reichweite, Leistungsbalken (Rekuperation links von null, schraffiert), Verbrauch der letzten 50 km,
> Blinker und Fernlicht als blinkendes Symbol oben rechts. **Beim Laden** Akku-Balken mit Lauflicht, kW, Restzeit,
> geladene kWh, AC/DC und „Ladung fertig“. **Geparkt** der Status: verriegelt?, Türen, alle vier Reifen mit Druck
> (bar) und Druckverlust, 12 V, SoH, Zelltemperaturen, Außentemperatur. Die **Steuerung** (Klima an mit Temperatur,
> Klima aus, Zusperren, Aufsperren) braucht immer zwei Bestätigungen: Rückfrage, dann nach ~1 s Pause die letzte
> Bestätigung; 2× = abbrechen. Ist das Auto an, ist die Steuerung gesperrt. Neue Warnungen erscheinen über jeder Seite.
>
> **In 3 Schritten loslegen**
> 1. Die Overdrive-App am Auto meldet die Werte per MQTT an deinen Broker (`overdrive/vehicle/telemetry/#`).
> 2. `byd-bridge` daneben starten und per `tailscale serve --bg --https=8471 http://127.0.0.1:8472` freigeben
>    (Zugriff nur für deinen Tailscale-Login, kein Token in der App).
> 3. In der Even-App bei BYD Glass die https-Adresse der Bridge eintragen (ein privater Build mit `VITE_BYD_URL`
>    bringt sie schon mit). **Ohne Adresse läuft eine Demo** mit erfundenen Werten (oben „DEMO“).

`?demo=1` auf der Entwicklungs-Adresse erzwingt die Demo; `&scene=tour|drive|charge|parked|warn` wählt sie
(Standard `tour`: 40 s Fahrt, 40 s Laden, 40 s geparkt), `&page=drive|charge|status|control` hält eine Seite fest.

---

## Auf der Brille

| Seite | zeigt |
|---|---|
| Fahrt | links Tempo in großen Pixelziffern, `KM/H`, Gang; `TEMPO!` + Rahmen bei der Tempo-Warnung des Autos. Rechts Akku %, Reichweite, Akku-Balken, Leistungsbalken (+ Antrieb rechts bis 100 kW, − Rekuperation links bis 40 kW, schraffiert, `REKU`). Darunter Verbrauch (50 km) · Fahrt-km, Außen · Klima · 12 V |
| Laden | Akku % + Reichweite, kW + `DC`/`AC` + Restzeit, Akku-Balken mit Lauflicht; darunter Restzeit · geladene kWh · Ladeart, Reichweite · Zellen; nach dem Laden „FERTIG“ |
| Status | Draufsicht mit vier Reifen (bar; `!` bei niedrig, invers bei Druckverlust), Schloss (zu/offen, `TÜR OFFEN`); darunter Schloss · Türen · 12 V, SoH · Zellen · Außen, Klima · Soll · Datenalter |
| Steuerung | Klima an 21° · Klima aus · Zusperren · Aufsperren (Auto an: alles gesperrt mit Hinweis); Bestätigungen als eigene Bildschirme; letzte Zeile: Ergebnis von der Bridge („gesendet …“, „BYD arbeitet …“, „erledigt“, „BYD beschäftigt“, „keine Rückmeldung“) |

Das Auto oben rechts dreht die Räder beim Fahren, zeigt einen Blitz beim Laden, ein `P` geparkt, `!` bei einer
kritischen Warnung und ein Kreuz, wenn die Daten alt sind (Auto schläft) oder die Bridge fehlt. Blinker und
Warnblinker blinken als Pfeile links/rechts, Fernlicht als Striche.

**Warnungen** (von der Bridge ausgewertet) erscheinen neu über jeder Seite (8 s oder bis Tippen), danach pulsiert
die schlimmste in der Kopfzeile: Druckverlust, Reifendruck niedrig, Tür offen (beim Fahren kritisch), 12 V schwach,
seit ≥ 10 min nicht versperrt (geparkt), Akku niedrig, Ladung fertig (Hinweis).

| Geste | wirkt |
|---|---|
| Wischen | nächste/vorige Seite; in der Steuerung: Auswahl (am Listenende weiter zur nächsten Seite), bei „Klima an“: Temperatur ±1 °C |
| Tippen | Warnungen zeigen; in der Steuerung: wählen → (Temperatur →) Rückfrage → nach 1 s Pause letzte Bestätigung = senden (jeder Schritt ≤ 8 s) |
| Halten | Hilfe (die Gesten); in einer Rückfrage: abbrechen |
| 2× | Bestätigung in jedem Schritt abbrechen, sonst App schließen |

Wechselt das Auto den Modus (losfahren, anstecken, abstellen), springt die App auf die passende Seite — außer du
bist gerade in der Steuerung beschäftigt.

## Was die App anfragt

Nur „simple requests“ ohne eigene Kopfzeilen (kein CORS-Preflight):

| Anfrage | wann |
|---|---|
| `GET /state` und dann `GET /state?since=<rev>&wait=25` | dauernd als Long-Poll: die Bridge antwortet sofort bei Änderungen, sonst nach 25 s |
| `POST /command` mit `{"action":"climate_on","value":21}` als text/plain | nur nach zwei Bestätigungen auf der Brille und nur, wenn `car_on` nicht `true` ist |

Bei Fehlern wartet die App 2 s, dann doppelt so lang bis 30 s, und zeigt „Bridge: … – zeigt letzten Stand“.

## Befehle

| Eintrag | sendet | Hinweis |
|---|---|---|
| Klima an 21° | `climate_on` 16–28 | ohne Erweiterung der pybyd-mqtt-Brücke sendet sie fest 26 °C (ab 22°) oder 19 °C — die Liste zeigt dann „(sendet 26°)“ |
| Klima aus | `climate_off` | |
| Zusperren | `lock` | nur wenn an der Bridge ein Schloss-Weg eingerichtet ist |
| Aufsperren | `unlock` | standardmäßig an der Bridge gesperrt; sonst nur im Stand (geparkt, 0 km/h) |

Die Bridge prüft alles noch einmal (Allowlist, Werte, Stillstand, ein Befehl gleichzeitig, höchstens einer je 20 s)
und protokolliert jeden Befehl.

## Build

```bash
npm install
npm test            # vitest
npm run build       # tsc + vite
npx evenhub pack app.json dist -o byd-glass.ehpk --sdk-ver 0.0.16
python3 ../../selfhost/services/byd-bridge/byd_bridge.py --selftest   # Bridge-Auswertung
```

Privater Build mit deiner Bridge: `VITE_BYD_URL=https://<host>.<tailnet>.ts.net:8471 npm run build` und packen mit
einer `app.private.json`, deren `whitelist` genau diese Origin enthält (die Brille blockiert Wildcards).

## Lizenz

MIT
