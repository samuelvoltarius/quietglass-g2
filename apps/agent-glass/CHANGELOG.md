# Changelog

## [0.1.0] — 2026-09-29

Erste Fassung. **Machbarkeitsnachweis**, bewusst klein gehalten.

### Enthalten

- Sitzungsliste aus Even Terminal, Auswahl per Wischen.
- Verlauf und Live-Strom (SSE) einer Sitzung auf der Brille.
- Erlaubnis-Anfragen mit Wischen beantworten — hoch erlaubt, runter lehnt ab.
- Ehrliche Unterscheidung zwischen steuerbaren und nur lesbaren Sitzungen.
- Kopplung durch Einfügen der vollständigen Adresse, die der Server ausgibt.

### Beim Bauen gefunden

- **Even Terminal steuert nur eigene Sitzungen.** Es liest den Verlauf jeder
  Claude-Code-Sitzung von der Platte, aber `/api/status`, `/api/prompt` und
  `/api/permission-response` antworten mit `404 Session not found`, sobald die
  Sitzung nicht von ihm selbst gestartet wurde. Steht in keiner Dokumentation.
  Von Alfred gefunden, nicht von mir.
- **`even-terminal claude` ist kein Server**, sondern ein Client, der sich an
  einen laufenden Server hängt. Der Server ist `even-terminal start`.
- **Alles liegt unter `/api`.** `/info` gibt 404 und sieht aus wie ein toter
  Server; es heißt `/api/info`.
- **`--allow-cors` ist Pflicht**, weil Brillen-App und Terminal-Server auf
  verschiedenen Ports liegen. Ohne den Schalter verwirft der Browser jede
  Antwort — dasselbe Symptom wie ein toter Server. Dritter Fall dieser Falle
  im Projekt nach LUMEN und Status Glass.
- **`EventSource` kann keinen Authorization-Header setzen.** Der Server nimmt
  den Token auch als Query-Parameter; ohne Token antwortet er sauber mit 401.
- **Der Simulator kann mehr Eingaben als dokumentiert**: `up`, `down`,
  `click`, `double_click`, `long_press`, `long_press_release`. Bisher war nur
  `click` bekannt.

### Nicht enthalten

- Der Erlaubnis-Bildschirm ist durch Tests abgedeckt, aber **nicht auf der
  Brille beobachtet** — dafür braucht es eine von Even Terminal selbst
  gestartete Sitzung.
- Keine Spracheingabe. Die kann `hermes-even-hub-app` bereits.
