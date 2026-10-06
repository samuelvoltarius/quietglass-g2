# RainLens

**Quietglass** · Das Wetter direkt auf deiner Even Realities G2.

> **Kurz gesagt:** RainLens zeigt dir das Wetter von jetzt, den nächsten Stunden und drei Tagen auf der Brille. Kein Konto, kein Schlüssel, kein eigener Server.
>
> **So startest du:**
> 1. RainLens in der Even-App installieren und öffnen.
> 2. Den Standort erlauben, wenn die Even-App fragt – oder am Handy einen Ort eintippen (z. B. „Hallein“ oder „Wien“) und antippen.
> 3. Auf der Brille: **Tippen** lädt neu, **Wischen** wechselt zwischen Jetzt, Stunden und 3 Tagen, **Doppeltippen** beendet.
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
- Tap aktualisiert, Wischen wechselt die Ansicht, Doppeltipp beendet
- verständliche Hinweise bei Netzfehlern auf Brille und Handy
- Deutsch, Englisch, Französisch, Spanisch und Italienisch
- keine Anmeldung und kein eigener API-Schlüssel erforderlich

## Datenquelle

RainLens lädt die Vorhersage direkt von Open-Meteo (`api.open-meteo.com`) und sucht Orte über den Open-Meteo-Geocoder (`geocoding-api.open-meteo.com`, Ortsdaten von GeoNames). Beide antworten ohne Schlüssel und mit `access-control-allow-origin: *`, funktionieren also direkt aus der Even-App. Die freie Nutzung ist laut den Open-Meteo-Bedingungen auf nicht-kommerzielle Zwecke und weniger als 10 000 Aufrufe pro Tag begrenzt; die Daten stehen unter CC BY 4.0, der Hinweis steht unten in der Handy-App.

Die App übermittelt nur die zur Prognose benötigten Koordinaten bzw. den eingetippten Ortsnamen. Der gewählte Ort, eigene Koordinaten und die Sprachwahl bleiben lokal auf dem Gerät.

## Entwicklung

```bash
npm install
npm test
npm run build
npm run dev
npm run sim
```

Noch nicht auf echter G2-Hardware geprüft. Wetterdaten sind modellbasierte Prognosen und keine amtlichen Unwetterwarnungen.
