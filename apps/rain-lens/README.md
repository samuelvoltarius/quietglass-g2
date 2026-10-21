# RainLens

**Quietglass** · Das Wetter direkt auf deiner Even Realities G2.

> **Kurz gesagt:** RainLens zeigt dir das Wetter von jetzt, den nächsten Stunden und drei Tagen auf der Brille. Kein Konto, kein Schlüssel, kein eigener Server.
>
> **So startest du:**
> 1. RainLens in der Even-App installieren und öffnen.
> 2. Den Standort erlauben, wenn die Even-App fragt – oder am Handy einen Ort eintippen (z. B. „Hallein“ oder „Wien“) und antippen.
> 3. Auf der Brille: **Tippen** lädt neu, **Wischen** wechselt zwischen Jetzt, Stunden, 3 Tagen und dem Cockpit, **2×** beendet. (Halten am optionalen R1-Ring zeigt zusätzlich die Hilfe.)
>
> **Optional:** Koordinaten von Hand eingeben (unter „Erweitert“) – nur nötig, wenn die Ortssuche deinen Ort nicht kennt.

RainLens zeigt nicht mehr nur Regen, sondern das komplette Wetterbild: aktuelle Temperatur und gefühlte Temperatur, Wetterlage, Luftfeuchte, Bewölkung, Wind und Böen, Niederschlag, die nächsten Stunden sowie eine Drei-Tage-Prognose. Die Informationen sind für das monochrome 576 × 288-Display priorisiert und bleiben mit wenigen Gesten erreichbar.

![RainLens im Even-Hub-Simulator](docs/screenshot.png)

## Funktionen

- aktuelles Wetter mit Temperatur, gefühlter Temperatur und WMO-Wetterlage
- klare monochrome Pixel-Piktogramme für Sonne, Wolken, Nebel, Regen, Schnee und Gewitter
- Luftfeuchte, Bewölkung, Niederschlag, Windrichtung, Windstärke und Böen
- zwölf kommende Stunden mit Temperatur und Regenwahrscheinlichkeit
- Drei-Tage-Prognose mit Höchst-/Tiefstwerten und Sonnenauf-/untergang
- Telefonstandort, oder ein Ort per Namenssuche (Open-Meteo-Geocoder, ebenfalls ohne Schlüssel); Koordinaten von Hand unter „Erweitert“
- ohne Standort zeigt die Brille keine erfundenen Werte, sondern sagt, was zu tun ist
- Tippen aktualisiert, Wischen wechselt die Ansicht, 2× beendet (Halten nur am R1-Ring: Hilfe)
- verständliche Hinweise bei Netzfehlern auf Brille und Handy
- Deutsch, Englisch, Französisch, Spanisch und Italienisch
- keine Anmeldung und kein eigener API-Schlüssel erforderlich
- nur im privaten Build (`VITE_RADAR=1`): animiertes Regenradar als vierte Ansicht, mit Grundkarte (Grenzen, Küste, Seen, große Flüsse, Ortsnamen) und dem nächsten Ort in der Kopfzeile
- **Cockpit** (letzte Ansicht): alles auf einen Blick, groß gesetzt – siehe unten

## Cockpit-Ansicht

![Cockpit-Ansicht (Vorschau mit Ersatzschrift)](docs/cockpit-preview.png)

Der ganze Bildschirm als ein Bild aus vier Kacheln, mit echten Schriften (fett, mehrere Größen):

- **links** das Radar mit Fadenkreuz (dein Standort), gestricheltem Entfernungsring, Nordpfeil und Windzeiger, darunter die Loop-Leiste (letzte Stunde durchgezogen, nächste Stunde gestrichelt mit dem Regen je Viertelstunde) und „HH:MM · Ort“. Im öffentlichen Build ohne Radar steht dort ein großes Piktogramm des aktuellen Wetters.
- **rechts** groß die Antwort: „REGEN IN ~25 MIN“, „REGNET JETZT“, „TROCKEN BIS 18:00“ oder „TROCKEN“ (Schnee nach Wettercode), berechnet aus den Viertelstundenwerten von Open-Meteo (ab 0,1 mm je Viertelstunde). Darunter TEMP, GEFÜHLT, FEUCHTE, HIMMEL, WIND, BÖEN, REGEN 2 H und WARNUNG.
- **WARNUNG**: amtliche Warnungen von GeoSphere Austria für Orte in Österreich (höchste Stufe, z. B. „▲ STURM (gelb)“), sonst „–“. Zusätzlich eine eigene **Böen-Warnung** am Handy (Tab „Mehr“, standardmäßig aus).
- **Tippen** spielt den Radar-Loop einmal ab, dann wieder das Standbild.

Übertragen werden nur Kacheln, die sich geändert haben (die Uhr: eine Kachel pro Minute). Der Baukasten dafür liegt in `src/screen/` und ist zum Kopieren in andere Quietglass-Apps gedacht.

## Datenquelle

RainLens lädt die Vorhersage direkt von Open-Meteo (`api.open-meteo.com`) und sucht Orte über den Open-Meteo-Geocoder (`geocoding-api.open-meteo.com`, Ortsdaten von GeoNames). Beide antworten ohne Schlüssel und mit `access-control-allow-origin: *`, funktionieren also direkt aus der Even-App. Die freie Nutzung ist laut den Open-Meteo-Bedingungen auf nicht-kommerzielle Zwecke und weniger als 10 000 Aufrufe pro Tag begrenzt; die Daten stehen unter CC BY 4.0, der Hinweis steht unten in der Handy-App.

### Radar und Karte (nur privater Build)

Das Radar kommt von RainViewer (`api.rainviewer.com`, `tilecache.rainviewer.com`; laut deren Bedingungen nur privat/zu Lernzwecken, mit sichtbarer Quellenangabe auf der Radarseite). Die Grundkarte darunter lädt nichts aus dem Netz: Grenzen, Küstenlinie, Seen, große Flüsse und Orte stammen aus [Natural Earth](https://www.naturalearthdata.com) 1:10m (gemeinfrei / public domain), auf Europa zugeschnitten, vereinfacht und in `src/radar/map-data.ts` eingebettet (~117 KB, nur im Radar-Teil des privaten Builds). Neu erzeugen: `node scripts/build-map-data.mjs <Ordner mit den Natural-Earth-GeoJSON-Dateien>`.

### Warnungen (GeoSphere Austria)

Für Orte in Österreich fragt die Cockpit-Ansicht `https://warnungen.zamg.at/wsapp/api/getWarningsForCoords?lon=…&lat=…&lang=de` ab – die öffentliche Schnittstelle hinter warnungen.zamg.at, ohne Schlüssel und mit `Access-Control-Allow-Origin: *` (geprüft am 13.10.2026). Außerhalb Österreichs wird nicht gefragt (der Dienst antwortet dort 404).

Die App übermittelt nur die zur Prognose benötigten Koordinaten bzw. den eingetippten Ortsnamen. Der gewählte Ort, eigene Koordinaten und die Sprachwahl bleiben lokal auf dem Gerät.

## Entwicklung

```bash
npm install
npm test
npm run build
npm run dev
npm run sim
```

Noch nicht auf echter G2-Hardware geprüft. Wetterdaten sind modellbasierte Prognosen; amtlich sind nur die GeoSphere-Warnungen im Cockpit (Österreich).

Cockpit-Vorschau neu erzeugen: `node scripts/cockpit-preview.mjs` (Node ≥ 22.18, zeichnet mit der Ersatz-Pixelschrift).

## Datenschutz

Welche Daten wohin gehen, was gespeichert wird und wie du es löschst: [docs/PRIVACY.md](docs/PRIVACY.md).
