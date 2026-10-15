# Changelog

## [0.11.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): seine Klicks kommen auf der Brille nie an, und Halten öffnet sonst das Menü statt die App zu erreichen. Die Seiten tragen kein `menuObject` mehr; der Menücode und der `menuItemClickEvent`-Handler bleiben, damit es wieder eingeschaltet werden kann.
- Halten in der Übersicht öffnet wieder das Menü der App (Aktionen, „Alle Quellen neu abfragen“ und **Hilfe** als Zeile); 2× in der Hilfe geht zurück ins Menü. In den Details: Halten merkt „gesehen“ vor, ein Tippen bestätigt, alles andere bricht ab (wie bisher).

## [0.11.1] — 2026-10-15

### Behoben

- Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben; jetzt hat jeder Aufruf an die Brille ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s), danach gilt der Aufruf als fehlgeschlagen und die Seite wird beim nächsten Zeichnen neu aufgebaut.

## [0.11.0] — 2026-10-14

Bedienung nach QIS v1.2.

### Geändert

- **Seitenmenü der Brille** (`menuObject`, `menuItemClickEvent`): `Hilfe`, `Aktionen`, `Neu laden`. Die Hilfe ist kein Listeneintrag im Aktionsmenü mehr; 2× in der Hilfe geht dorthin zurück, woher sie geöffnet wurde (Übersicht, Aktionen oder Details). Halten auf der Übersicht öffnet weiter die Aktionen, die Fußzeile sagt jetzt `Halten = Aktionen`.
- **„Gesehen“ ist vorgemerkt** (Übersicht: Tippen; Details: Halten): erst fragt die Fußzeile `Nochmal tippen = gesehen · Wischen/2× = abbrechen`, ein einzelnes Tippen innerhalb von 4 s markiert. Wischen, 2×, ein zweites Halten oder 4 s ohne Eingabe brechen ab (2× beendet dabei nie die App); das Tippen unmittelbar nach dem Halten (unter 0,4 s) zählt nicht als Bestätigung. Bereits gesehene Probleme lassen sich nicht erneut vormerken.
- **Keine HTTP-Codes mehr auf der Brille**: ein Serverfehler heißt `Server meldet einen Fehler`, fremder Fehlertext `fehlgeschlagen`. Die Details (`HTTP 503`, Ausnahmetext) zeigt das Handy.
- **Erster Start = Demo**: ohne Quelle zeigt die App Beispieldaten (Home-Assistant-Szene) und die Zeile `Demo · Verbindung am Handy einrichten`, fragt keine Server ab und schreibt die Beispielquelle nie in den Speicher. Die erste echte Quelle beendet die Demo.
- Die Brille wird immer nur von einem Zeichenvorgang beschrieben (Anforderungen währenddessen werden zu einem weiteren Durchlauf zusammengefasst); vorher konnte ein schnell abgebrochenes „Nochmal tippen = gesehen“ in der Fußzeile stehen bleiben.
- Hilfeseite angepasst (Menü der Brille, kein „Aktion: Tippen, dann nochmal“ mehr als eigene Zeile).

## [0.10.0] — 2026-10-14

Bedienung nach dem Quietglass-Bedienstandard (QIS v1).

### Behoben (Sicherheit)

- **2× im Aktionsmenü beendete die App** – jetzt geht 2× immer nur eine Ebene zurück (Menü → Übersicht, Hilfe → Menü, Details → Übersicht); beendet wird nur auf der Übersicht.
- **Aktionen liefen zu leicht**: Jede Aktion wird erst vorgemerkt (Tippen: „Nochmal tippen = ausführen · Wischen/2× = abbrechen“), ein zweites einzelnes Tippen innerhalb von 4 s führt sie aus. Wischen, 2× oder 4 s ohne Eingabe brechen ab. Halten im Menü macht nichts mehr.

### Geändert

- Halten auf der Übersicht öffnet immer das Menü: Aktionen, „Alle Quellen neu abfragen“ (früher Halten ohne Aktionen) und „Hilfe“ als letzter Eintrag.
- Neue Hilfeseite mit den Gesten.
- Kopfzeile `STATUS · Zustand`, Fußzeile immer in der Reihenfolge Tippen → Wischen → Halten → 2× und endend auf `2× = zurück` bzw. `2× = Ende` (englisch Tap/Swipe/Hold/2×, back/exit). Passt eine Fußzeile nicht in die Zeile, entfällt der Wischen-Hinweis.
- Handy-Tabs: Netz · Brille · Verbindung · Mehr (vorher Quellen → Verbindung). „Doppeltippen“ heißt überall „2×“.
- `invertScroll` (Handy, Tab „Brille“) gilt unverändert für jede Liste, auch Menü und Details.

## [0.9.0] — 2026-10-14

### Neu

- **Heimnetz-Wächter** (Beispiel-Server `examples/reference-server.mjs`, standardmäßig aus): Mit `STATUS_NETWATCH=1` liest der Server regelmäßig die vorhandene Nachbar-/ARP-Tabelle seines Rechners (`ip neigh`, sonst `/proc/net/arp`) – rein passiv, ohne eigene Pakete. Geräte werden per MAC geführt (zuerst/zuletzt gesehen, IP, Reverse-DNS-Name), bekannte Geräte in einer JSON-Datei (Modus 600, atomar geschrieben, Standard `~/.local/state/quietglass/netwatch.json`). Der erste Lauf gilt als Ausgangsbestand. Docker-, Bridge-, VPN- und Tailscale-Schnittstellen bleiben außen vor.
- Optionaler leichter Ping-Abgleich des eigenen privaten /24 nur mit zweitem Schalter `STATUS_NETWATCH_PING=1` (aus, nur RFC-1918-Bereiche, höchstens alle 5 min).
- Status-JSON mit `network` (`total`, `online`, `new`, `devices`); `POST /devices` mit `{"mac", "known"}` markiert ein Gerät als bekannt – mit derselben Anmeldung wie `/status` (Token oder erlaubter Tailscale-Login), ohne jede Anmeldung 403.
- Brille: neue Geräte erscheinen als Warnzeile („· Spark: Neues Gerät im Netz: android-5f3c“), Halten = gesehen; ein weiteres neues Gerät meldet sich erneut. Detailseite mit „Netz: 23 Geräte · 1 NEU“.
- Handy: neuer Tab „Netz“ mit der Geräteliste je Rechner (neue zuerst, online/offline) und „als bekannt markieren“. Deutsch und Englisch.
- Neue Umgebungsvariablen: `STATUS_NETWATCH`, `STATUS_NETWATCH_MS`, `STATUS_NETWATCH_FILE`, `STATUS_NETWATCH_IFACES`, `STATUS_NETWATCH_DNS`, `STATUS_NETWATCH_PING`, `STATUS_NETWATCH_PING_MS` (siehe `docs/PROTOCOL.md`).

## [0.8.2] — 2026-10-13

### Geändert

- Handy-Seite in Tabs statt einer langen Spalte: Quellen · Brille · Mehr (Tab-Leiste unten, gewählter Tab bleibt), Status-Chip mit der Zahl der Quellen oben.

## [0.8.1] — 2026-10-13

### Fixed

- Every action takes two taps on the glasses; a source's `confirm` now only adds the "!" mark.
- The overview footer says "Halten = Aktionen" when a source offers actions (it said "Halten = neu" although hold opened the actions).
- The open machine and detail page survive a restart of the app (the actions screen never does).
- Leaving through the system stops polling and the pulse; coming back rebuilds the page and polls at once.

### Changed

- Detail footer `Wischen = mehr · Halten = gesehen · 2× = zurück`; "Disk" throughout; clearer read-only hint.

## [0.8.0] — 2026-10-13

### Added

- Detail page per machine: in the overview a tap opens the highlighted machine with every value — warnings first (with the names of failed services), then CPU and load, RAM and swap, every disk with used/total, temperatures, GPU, network, Docker, Tailscale, uptime — five rows a page, plus three sparklines (CPU, RAM, GPU or temperature). Swipe or tap turns the page, hold acknowledges the machine's problems, double tap goes back; the footer names the gestures. Status sign top right, text full width.
- Reference server: CPU usage, load per core, RAM from `MemAvailable` with used/total, swap, disk usage of `/` and every large local disk (`disk:<mount>`, warn 90 %, critical 95 %), CPU/SoC and NVMe temperature, first NVIDIA GPU (usage, VRAM, temperature, power), network rate, running Docker containers (unhealthy ones warn), failed systemd units with names (`STATUS_IGNORE_UNITS`), watched units (`STATUS_SERVICES`), Tailscale online. Everything optional and left out where the machine cannot tell; slow tools are sampled in the background so `/status` answers in milliseconds.
- Protocol: optional `detail` text per metric (cut at 160 characters). Older apps ignore it, older sources still work.

### Changed

- Overview: each machine row shows CPU, RAM, fullest disk and temperature (the picture is narrower, the text column wider), and the header carries the worst warning nobody has seen yet ("· Spark: 5 Dienste fehlgeschlagen +2"). Failed services, full disks, stopped services and a lost tailnet are said in words.
- The glasses listen to gestures before the first page is built, so a slow page set-up can never swallow the exit double tap.

### Fixed

- A source reporting both `cpu` and `load` added two points per poll to the CPU sparkline.

## [0.7.1] — 2026-10-13

### Changed

- The pulse of a critical machine or sign now changes shape (thick frame / thin frame, disk / outline) instead of only brightness, so it stays visible whatever the gray levels do.

## [0.7.0] — 2026-10-13

### Added

- Overview of several machines: with two or more sources the status page shows one row per machine (up to four at a time): a light (disk = fine, triangle = warning, pulsing disk = critical, crossed ring = offline), the name, a CPU/load line and one line of text. A machine that does not answer is marked "offline seit 12 min" (or "noch nie erreicht"). Swipe moves between machines, a tap acknowledges the highlighted machine's worst problem.
- Private builds can ship their own sources without typing: `VITE_STATUS_SOURCES="Name|https://host:port/status;Other|https://..."`. Sources missing from the stored list are added on start (also after an update); entries you added yourself stay.
- A metric named `load` counts as the CPU line of the sparklines.

### Fixed

- Page set-up on the glasses: one `rebuildPageContainer`, then exactly one `createStartUpPageContainer`; every later page, also a layout change, is a rebuild, never a second create.

## [0.6.0] — 2026-10-13

### Added

- Sparklines for CPU, GPU and RAM: for the source in focus (the one with the highlighted problem, otherwise the one a swipe picked) the last 12 readings are drawn as three small charts under the problem list, with the latest value in the picture. Any metric whose id or label starts with cpu, gpu, ram or mem is picked up; sources without such metrics keep the plain seven-row list.
- A status sign in the top-right corner of the header (64 x 30 image): a check mark when all is well, a calm triangle for a warning, and a pulsing "!" frame (1 Hz) while something critical is unacknowledged. Acknowledging stops the pulse.
- With nothing wrong, a swipe switches the source whose sparklines are shown, and the source name is the header.

### Changed

- The header text now ends 64 px before the right edge. With sparklines the problem list shows four rows (the footer says how many more there are); a change between the graph and list layout is the only time the page is rebuilt.
- Pictures are sent only when the data changed; the status page redraws every half second only while the alarm pulses, otherwise every five seconds as before.
- `?demo=1&scene=graph|warn|critical` shows a NAS with sparklines in the simulator.

## [0.5.4] — 2026-10-13

### Changed

- Problem list and action list use all 7 body rows (was 5) and the full display width (56 instead of 46 characters), so long source names and messages are cut later.
- Header reads "WARNUNG · 2" instead of "WARNUNG  2" (count was separated by a bare double space).

## [0.5.3] — 2026-10-13

### Fixed

- Start language: an explicit choice is kept in the Even SDK store (the WebView's localStorage may not survive a relaunch); without one, a German-speaking Even account country (AT/DE/CH/LI/LU) starts the app in German, even when the WebView reports English.

## [0.5.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

## [0.5.0] — 2026-10-07

### Changed

- German and English UI.
  - Glasses and phone page follow the phone language (saved choice first,
    English as fallback); the language picker on the phone page switches the
    glasses at once. The app's own failure reasons and decimal numbers are
    localized; names, labels and units from your sources are shown as sent.
- Store readiness: system exit dialog, privacy policy.
  - A double tap on the root screen now opens the system exit dialog
    (`shutDownPageContainer(1)`). Cancel and the app carries on unchanged;
    timers, streams and sensors stop only after you confirm. A failed call
    is caught and leaves the app running.
  - `docs/PRIVACY.md` covers every permission in `app.json`, with a German
    summary, and is linked from the README.
  - Store art in `store/` (icon, 24 px monochrome icon, background,
    tagline), generated by `tools/store-art.mjs`.

## [0.4.0] — 2026-10-05

- Made the Home Assistant integration prominent in the README and repository
  app list instead of leaving it hidden under generic monitoring.
- Reworked demo mode and the simulator screenshot around a Home Assistant
  dashboard with allow-listed household actions.

All notable changes to Status Glass are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-09-25

### Added
- **Actions.** A source may offer things to trigger from the glasses; sources
  remain read-only by default and must opt in by listing them.
- Actions live on a separate screen reached by holding the temple pad, so a
  stray tap while glancing at the dashboard can never trigger anything.
- Two-tap confirmation for actions the source marks as consequential. The
  source decides, because only it knows whether an action dims a lamp or
  unlocks a door. Moving the selection cancels a pending confirmation, so the
  tap after a swipe cannot run what was highlighted before it.
- Action ids are sent in the request body rather than the path, so they need no
  escaping and do not appear in server log lines.
- Duplicate and id-less actions are dropped with a warning; a duplicate would
  run the wrong thing.
- **Home Assistant adapter** in examples/: readings and control, configured
  with two lists. The Home Assistant token stays in the adapter and never
  reaches the glasses, and the action list is an allow-list — unknown ids are
  refused and a client cannot smuggle in its own service call. Verified against
  a stand-in Home Assistant, both success and both refusal paths.
- 87 unit tests (was 63).

## [0.1.0] — 2026-09-25

First release.

### Added
- An open JSON protocol small enough to emit from a shell script, documented in
  docs/PROTOCOL.md, with numeric metrics, explicit states, thresholds and an
  inverted comparison for metrics where low is bad.
- Dependency-free reference server in examples/, about a hundred lines, verified
  serving live values.
- Defensive parsing: a source returning rubbish degrades to "unknown" and never
  takes the dashboard down. Missing ids and labels are generated; metrics with
  neither value nor state are dropped with a warning.
- A healthy dashboard renders a single line; the display grows only in
  proportion to what is wrong, worst first.
- Unreachable and stale sources are reported as "unknown", never as healthy —
  the property that makes monitoring trustworthy, covered by explicit tests.
- Acknowledgement sinks a known problem to the bottom of the list without
  hiding it, and is cleared automatically when the metric recovers.
- Per-source polling timers with exponential backoff to a five-minute ceiling,
  so one dead host neither slows the others nor gets hammered.
- Bearer tokens sent as headers, never in URLs, never logged, and never shown
  in full in the phone app.
- Plain http permitted for LAN sources but marked as unencrypted.
- 63 unit tests covering protocol parsing, threshold logic, severity ordering,
  staleness, acknowledgement lifecycle, fetch behaviour, backoff and storage.

### Known limitations
- WebSocket push is specified but not implemented; polling only in 0.1.0.
- No history or graphs.
- Acknowledgements are not persisted across restarts.
- Not yet verified on physical hardware.
