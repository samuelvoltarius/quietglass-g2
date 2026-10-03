# Dayline

**Quietglass** · Kalender und Erinnerungen in einer Tageslinie.

![Dayline im Even-Hub-Simulator](docs/screenshot.png)

Dayline kombiniert Termine und Aufgaben, ohne einen Cloudanbieter vorzuschreiben. Eine `.ics`-Datei kann direkt auf dem Telefon ausgewählt oder in die Phone-UI eingefügt werden; dafür ist kein Server nötig. Für laufende Synchronisierung liegt zusätzlich eine kleine lokale JSON-Bridge bei. Die Oberfläche und die Brillensteuerung unterstützen Deutsch, Englisch, Französisch, Spanisch und Italienisch.

## Start

```bash
npm install
node examples/dayline-bridge.mjs
npm test
npm run build
npm run dev
npm run sim
```

Die G2 stellt selbst **keine Kalender-, Erinnerungs- oder allgemeine iOS-API** bereit. Dayline umgeht das nicht heimlich, sondern macht die Integrationsgrenze explizit. Noch nicht auf echter Hardware geprüft.
