# RainLens

**Quietglass** · Eine vollwertige Wetter-App für die Even Realities G2.

RainLens zeigt nicht mehr nur Regen, sondern das komplette Wetterbild: aktuelle Temperatur und gefühlte Temperatur, Wetterlage, Luftfeuchte, Bewölkung, Wind und Böen, Niederschlag, die nächsten Stunden sowie eine Drei-Tage-Prognose. Die Informationen sind für das monochrome 576 × 288-Display priorisiert und bleiben mit wenigen Gesten erreichbar.

![RainLens im Even-Hub-Simulator](docs/screenshot.png)

## Funktionen

- aktuelles Wetter mit Temperatur, gefühlter Temperatur und WMO-Wetterlage
- klare monochrome Pixel-Piktogramme für Sonne, Wolken, Nebel, Regen, Schnee und Gewitter
- Luftfeuchte, Bewölkung, Niederschlag, Windrichtung, Windstärke und Böen
- zwölf kommende Stunden mit Temperatur und Regenwahrscheinlichkeit
- Drei-Tage-Prognose mit Höchst-/Tiefstwerten und Sonnenauf-/untergang
- Telefonstandort oder frei speicherbare Koordinaten; Salzburg als Fallback
- Tap aktualisiert, Wischen wechselt die Ansicht, Doppeltipp beendet
- Demo-Fallback bei Netzfehlern
- Deutsch, Englisch, Französisch, Spanisch und Italienisch
- keine Anmeldung und kein eigener API-Schlüssel erforderlich

## Datenquelle

RainLens lädt die Vorhersage direkt von Open-Meteo. Die App übermittelt nur die zur Prognose benötigten Koordinaten. Manuelle Koordinaten und die Sprachwahl bleiben lokal auf dem Gerät.

## Entwicklung

```bash
npm install
npm test
npm run build
npm run dev
npm run sim
```

Noch nicht auf echter G2-Hardware geprüft. Wetterdaten sind modellbasierte Prognosen und keine amtlichen Unwetterwarnungen.
