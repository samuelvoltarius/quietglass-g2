# Changelog

## [0.10.0] — 2026-10-20

### Geändert (QUS v1 „keine Textwand“)

- **Brille: der Status der offenen Sitzung ist jetzt ein Cockpit-Bild.** Links das Maskottchen in einem Ring (schreibt, solange der Agent arbeitet; Ring gestrichelt, wenn der Unterbrechen-Dialog offen ist, blass ohne Verbindung), darunter der Sitzungstitel; rechts klein „AGENT  14:05“, **eine große Aussage** (ARBEITET / BEREIT / OFFLINE) und sechs Kennzahlen in drei Spalten (Agent, Sitzung, Dauer, Schritte, Werkzeug, Zugriff). Unten eine Hinweiszeile. Es werden nur geänderte Kacheln gesendet (das Maskottchen bewegt sich alle 1,5 s, die Dauer ist auf 5 s bzw. Minuten gerundet, damit nicht jede Sekunde ein Bild über Bluetooth geht); während der Beenden-Dialog offen sein kann, in der Pause und nach dem Beenden wird keine Kachel gesendet.
- **Wischen auf dem Cockpit öffnet die Antwort als Lesetext** (Kopfzeile mit Sitzungstitel, Neuestes unten, Wischen blättert seitenweise, Tippen = neueste Seite); **2× geht zurück zum Cockpit**, auf dem Cockpit fragt 2× nach dem Beenden. Tippen auf dem Cockpit liest die Antwort vor, Halten schlägt Unterbrechen vor (wie bisher erst nach zweitem Tippen).
- Freigaben, Fragen, Fehler, Sitzungsliste und Hilfe bleiben Textseiten und nehmen das ganze Display (die Liste Erlauben/Ablehnen mit Bestätigen ist unverändert). Das kleine Gesicht in der Kopfzeile entfällt, die Kopfzeile ist eine volle Zeile.
- Neu im Zustand: `steps` zählt die Werkzeuge seit der letzten Anweisung (Zelle „Schritte“).
- **Handy: genau drei Tabs in einer Zeile** (Jetzt / Sitzungen / Einstellungen) im Look von Rain Lens: Statusbanner, Hero-Karte mit dem Zustand, 2×2-Kennzahlen, ein Senden-Knopf; Sitzungen mit Liste, Verwalten (eingeklappt) und dem ganzen Verlauf; Einstellungen mit Verbindungskarte (eingeklappt, sobald ein Token da ist), Brille, Vorlesen (eingeklappt) und Sprache. Erststart: Drei-Schritt-Checkliste, die Demo läuft ohne Token.
- Vorschau-Bilder: `store/preview-cockpit.png` (+ `-warn`), erzeugt mit `QG_PREVIEW=1 npx vitest run tests/cockpit.test.ts`.
- Unverändert: kein Seitenmenü, Beenden-Dialog (4/5-Ablauf, `onBack`-Wiederaufbau), begrenzte Aufrufe, Neuaufbau der ersten Seite, Freigaben nie als Wischrichtung.

## [0.9.6] — 2026-10-17

### Behoben (Hardware-Schrittprotokoll)

- **Beenden-Dialog: das 4/5 direkt nach dem Aufruf ist der Dialog selbst, nicht die App.** Am Gerät gemessen: nach `shutDownPageContainer(1)` kommt Systemereignis 4 (FOREGROUND_ENTER), wenn der Dialog *erscheint*, und 5 (FOREGROUND_EXIT), wenn er nach „Nein“ *weg* ist (die App war nie weg); bei „Ja“ folgt auf die 5 nach ca. 0,5 s die 7. Die App liest das jetzt so: 4 = Dialog steht, es wird nichts gezeichnet; 5 = Dialog weg, die Seite kommt sofort und ohne Geste wie beim ersten Start zurück; Timer, Polls und Streams laufen durchgehend weiter, nichts wird pausiert.
- Ein 2× auf der Startseite, das ankommt, während die App sich im Hintergrund glaubt (5 ohne Dialog), geht nicht verloren: es fragt wieder, und die Seite kommt nach „Nein“ zurück (die Pause blockiert den Wiederaufbau nicht mehr).

## [0.9.5] — 2026-10-17

### Behoben (Hardware-Test)

- **Nach „Nein“ im Beenden-Dialog tat das erste 2× nichts.** Das erste 2× ist selbst das Signal „App ist wieder da“: es startet den Wiederaufbau der Seite (rebuild + create), und im selben Augenblick ging der Dialog-Aufruf los, solange die Seite noch entstand, und ging verloren. Jetzt wartet der Dialog-Aufruf auf den Wiederaufbau (höchstens 10 s) und danach 300 ms, und fragt erst dann. Ein einzelnes 2× nach „Nein“ öffnet den Dialog also wieder.
- Während der Dialog offen sein könnte, zeichnen Timer, Polls und Streams nicht mehr auf die Brille (Seitenaufrufe könnten ihn überdecken); die Daten werden weiter gesammelt, die Seite kommt beim nächsten Tippen/Wischen/2× komplett zurück.

## [0.9.4] — 2026-10-17

### Behoben (Store-Prüfung, Wiederholung)

- **Beenden-Dialog: das Ergebnis von `shutDownPageContainer(1)` beendet die App nicht mehr.** Auf der Brille kommt `true` schon, wenn der Dialog *angezeigt* wird (am Gerät gemessen: ca. 58 ms nach dem 2×), nicht erst bei „Ja“. Die App hielt das für eine Bestätigung und stellte sich tot; nach „Nein“ öffnete ein weiteres 2× den Dialog nicht mehr (Prüfer, Even Hub). Jetzt läuft die App weiter, ganz gleich was der Aufruf liefert; beendet wird sie nur vom System (App wird geschlossen und/oder Systemereignis 6/7). Die Seite wird nicht sofort neu gezeichnet (der Dialog könnte noch offen sein und von einem Seitenaufruf überdeckt werden), sondern beim nächsten Tippen, Wischen oder 2× bzw. bei FOREGROUND_ENTER wie beim ersten Start neu aufgebaut; dann wird das Ereignis normal verarbeitet, also öffnet 2× direkt nach „Nein“ den Dialog wieder.

## [0.9.3] — 2026-10-16

### Behoben (Store-Prüfung)

- Nach „Nein“ im Beenden-Dialog öffnete 2× den Dialog nicht mehr – die App baut die Seite jetzt wie beim ersten Start neu auf.

## [0.9.2] — 2026-10-15

### Geändert (auf echter Brille gemessen)

- Seitenmenü vorerst aus (`SIDE_MENU = false`): Die Klicks des Menüs kommen auf der Brille nie an, und solange eine Seite ein Menü trägt, öffnet Halten dieses Menü statt die App zu erreichen (Schrittprotokoll 15.10.2026). Die Seiten tragen kein `menuObject` mehr; Code und `menuItemClickEvent`-Behandlung bleiben.
- Halten = Sitzungsliste öffnen; während der Agent arbeitet: Unterbrechen scharfschalten, ein Tippen bestätigt, alles andere bricht ab.
- Hilfe ist wieder die letzte Zeile der Sitzungsliste (Halten, Wischen bis „Hilfe“, Tippen); Tippen oder 2× schließt sie. Hilfe- und Handy-Texte beschreiben wieder diese Gesten.

## [0.9.1] — 2026-10-15

### Behoben

- Die Anzeige konnte bei einer verlorenen Antwort der Brille für immer auf der letzten Seite stehen bleiben. Jetzt hat jeder Aufruf ein Zeitlimit (Seite 8 s, Text 5 s, Bild 10 s); danach gilt der Aufruf als fehlgeschlagen und die Seite wird neu aufgebaut.

## [0.9.0] — 2026-10-14

### Geändert — Bedienstandard QIS v1.2 (docs/BEDIENSTANDARD.md)

- **Seitenmenü der Brille** (Halten → Systemmenü, SDK `menuObject` / `menuItemClickEvent` wie Babel Glass und Quiet Hub): `Hilfe` und `Sitzungen`. Hilfe öffnet die Gestenseite von jedem Bildschirm aus und kehrt dorthin zurück (Tippen oder 2×); `Sitzungen` öffnet die Sitzungsliste. Die Seite trägt das Menü bei jedem Aufbau neu, ein Sprachwechsel am Handy baut sie einmal neu auf (Menü-Beschriftung).
- **„Hilfe“ ist keine Listenzeile mehr:** die Sitzungsliste enthält nur noch „+ Neue Sitzung“ und die Sitzungen. Halten bleibt wie bisher: Sitzungsliste bzw. Unterbrechen scharfschalten (bestätigen).
- **Erster Start = Demo:** Ohne Token startet die App mit Beispieldaten (nicht mehr mit „Kein Token“-Fehler). Fußzeile: `Demo · Verbindung am Handy einrichten · 2× = Ende`. Sobald am Handy ein Token eingetragen wird, verbindet die App; wird er gelöscht, kehrt sie zur Demo zurück. `?demo=1` erzwingt die Demo weiterhin.
- **Handy-Texte:** „Doppeltippen“ heißt jetzt „2×“ (Deutsch und Englisch); die Halten-Beschreibung nennt das Seitenmenü.
- Tests: Menü auf der Seite (Hilfe, Sitzungen) und in der Sprache, Hilfe über das Menü und Rückkehr, Menü-Hilfe lässt eine scharfe Freigabe verfallen statt sie zu senden, Demo-Fußzeile in beiden Sprachen.

QIS-Stand: v1.2 (Seitenmenü, Demo beim ersten Start, Glossar). 2×/Halten/Freigaben unverändert zu 0.8.0.

## [0.8.0] — 2026-10-14

### Geändert — Bedienstandard QIS v1 (docs/BEDIENSTANDARD.md)

- **Wischen beantwortet keine Freigabe mehr.** Die Freigabe ist eine Liste `Erlauben / Ablehnen`: Wischen bewegt nur den Cursor, Tippen scharfschalten (`Nochmal tippen = Erlauben|Ablehnen · Wischen/2× = abbrechen`), ein zweites einzelnes Tippen innerhalb von 4 s sendet. Wischen, Doppeltippen oder 4 s ohne Eingabe brechen ab (Doppeltippen beendet die App erst, wenn nichts scharf ist). Eine neue Anfrage startet immer auf „Erlauben“, ungescharft. Das Protokoll zum Server ist unverändert (`/permission-response`); „Sitzung“/„immer“-Freigaben gab es in dieser App nicht.
- **Halten stoppt den Agenten nicht mehr allein:** Halten bei laufendem Agenten schaltet das Unterbrechen scharf (`Nochmal tippen = unterbrechen`), erst das zweite Tippen unterbricht.
- Kopfzeile `AGENT · Zustand · Sitzung`, Fußzeile in der Reihenfolge Tippen → Wischen → Halten → 2× mit `2× = Ende`/`2× = zurück` (gemeinsamer `footer()`), Englisch Tap/Swipe/Hold/2×. Test: alle Zeilen in Deutsch und Englisch innerhalb der Zeilenbreite.
- **`invertScroll` wirkt jetzt** (war fest auf „aus“): Schalter „Wischrichtung umkehren“ im neuen Handy-Tab „Brille“.
- Neu: „Hilfe“ als letzter Eintrag der Sitzungsliste, mit den Gesten.
- Handy-Tabs: Agent · Vorlesen · Brille · Verbindung · Mehr.

## [0.7.0] — 2026-10-13

### Neu

- **Sitzungsliste auf der Brille** (Halten): neueste zuerst, mit Alter („jetzt“, „5 min“, „2 h“, „3 T“) und `*` für aktiv. Ganz oben steht „+ Neue Sitzung“, wenn der Dienst eine starten kann (Hermes: `sessions.new`; OpenClaw: leert den Gesprächsverlauf in der App). Die Liste öffnet auf der offenen Sitzung, nie auf „+ Neue Sitzung“. Dienste ohne eigene Liste (OpenClaw) sagen das in der Liste offen.
- **Ganze Antwort am Handy, kurz auf der Brille:** Der Tab „Agent“ zeigt den kompletten Verlauf der offenen Sitzung (Du / Agent / Werkzeug / Fehler), Neuestes unten, live mitlaufend; die Box bleibt unten, außer man scrollt gerade zurück.
- **Blättern in langen Antworten auf der Brille:** Wischen hoch = ältere Seite, runter = neuere, Tippen = zurück zur neuesten. Fußzeile „Seite 3/5 · ↑ älter · Tippen = neueste“; auf der neuesten Seite zeigt „↑ älter“, dass es mehr gibt. Eine neue Frage springt wieder ans Ende.
- **Sitzungen am Handy:** Liste zum Antippen (öffnet die Sitzung), „Neue Sitzung“, Umbenennen und „Aus der Liste nehmen“. Kein Dienst kann über sein Protokoll umbenennen oder löschen – deshalb gilt der Name nur auf diesem Handy und „Aus der Liste nehmen“ blendet nur hier aus; beim Agenten bleibt alles erhalten („Ausgeblendete zeigen“ holt sie zurück). Ein Dienst, der es später kann, bekommt es automatisch beim Agenten.

### Unverändert

- Freigaben: Wischen hoch/runter erlaubt/lehnt ab, solange eine Freigabe-Anfrage angezeigt wird – das Blättern nimmt ihr nie die Gesten weg. Halten = unterbrechen (läuft) bzw. Sitzungsliste, Doppeltippen = zurück bzw. Ende.

## [0.6.3] — 2026-10-13

- Handy-Seite in Tabs statt einer langen Spalte: Agent · Verbindung · Vorlesen · Mehr (Tab-Leiste unten, gewählter Tab bleibt; ohne Token startet die Seite auf „Verbindung“). Status-Chip oben zeigt die aktive Sitzung oder „offline“.

## [0.6.2] — 2026-10-13

### Fixed

- Gestures and the exit are wired before anything goes to the network. Loading the sessions and opening the last one (up to 10 s timeout each) used to run first, so a slow or dead backend left the glasses deaf for up to half a minute, even to the double tap.
- Page writes run one at a time; overlapping first draws can no longer create the start-up page twice. A reconnect or a return to the foreground rebuilds the page.
- Leaving through the system (another app, the system menu) stops drawing and the face animation; coming back rebuilds the page. A system exit or crash stops the stream, the narration and the ticker.

### Changed

- A double tap on the session list goes back to the open session (on the root it still exits); the footer says "2× = zurück".
- Error footer "Tippen = nochmal · 2× = Ende"; the glasses no longer show the developer hint "Läuft Even Terminal mit --allow-cors?" but "Einrichtung in der Handy-App prüfen." (the phone page names the flag).

## [0.6.1] — 2026-10-13

### Fixed

- Page set-up on the glasses: the first page of a session goes out as one `rebuildPageContainer` followed by exactly one `createStartUpPageContainer`; every later page is a rebuild, never a second create. (Taps and exit work on real glasses only with this order.)

## [0.6.0] — 2026-10-13

### Added

- A face in the top-right corner of the header (64 x 30 image): it blinks when the agent is idle, writes in a notebook while the agent works, opens its eyes wide when a permission or question waits for you, shows a cross on an error and sleeps without a connection. The header text now ends 64 px before the right edge.
- The face moves twice a second on the agent page only; pictures are sent to the glasses only when they change, text containers only when their text changed.

## [0.5.4] — 2026-10-13

### Changed

- Glasses text now uses the full display width (56 characters per row instead of 46) for the agent text, permission details and session titles.

## [0.5.3] — 2026-10-13

### Fixed

- Start language: an explicit choice is kept in the Even SDK store (the WebView's localStorage may not survive a relaunch); without one, a German-speaking Even account country (AT/DE/CH/LI/LU) starts the app in German, even when the WebView reports English.

## [0.5.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

## [0.5.0] — 2026-10-07

### Changed

- German and English UI.
  - Glasses, phone page, error messages and the narrator's own announcements
    in both languages; the language follows the phone and can be switched at
    the top of the phone page, which redraws the glasses at once. Agent output
    and tool names are never translated.
  - The speech language stays a separate setting; "Automatic" follows the app
    language when the phone is German or English. Stored choices are kept.
- Store readiness: system exit dialog, privacy policy.
  - A double tap on the root screen now opens the system exit dialog
    (`shutDownPageContainer(1)`). Cancel and the app carries on unchanged;
    timers, streams and sensors stop only after you confirm. A failed call
    is caught and leaves the app running.
  - `docs/PRIVACY.md` covers every permission in `app.json`, with a German
    summary, and is linked from the README.
  - Store art in `store/` (icon, 24 px monochrome icon, background,
    tagline), generated by `tools/store-art.mjs`.

Security and robustness review:

- Permission swipes are only accepted for the request actually on display, after
  a short arming delay, once per request, never while an error screen hides it,
  and never again for a request re-delivered by a reconnecting stream. The
  answer is sent before the redraw.
- A `?token=` in any provider address is moved into the token field; user
  credentials and fragments are dropped from addresses; pairing keeps a literal
  `+` in tokens and refuses non-HTTP pairing URLs. Short tokens are no longer
  shown with a 4-character suffix. The development `?pair=` parameter is removed
  from the page address after use.
- Spoken output also omits JWTs, `Authorization` headers, bearer tokens,
  environment assignments, password fields, SSH and private keys, AWS and Google
  keys, long base64 values, all `scheme://` links and `$ ` command lines, and no
  longer splits a sentence inside an open code fence or a dotted token.
- Hermes reconnects with exponential backoff, ignores events from a replaced
  socket, stops after a rejected token and stays silent after being disposed.
- OpenClaw: an interrupt, a newer prompt or a backend switch no longer surfaces
  as a "Timed out" error; a real timeout is reported as such; answers sent as
  server-sent events are parsed.
- Opening a session or switching backend while another request is in flight no
  longer starts a second stream or writes stale results into the new state.
- Errors, tool names and permission titles are clipped to the 7 × 46 display;
  the CORS hint is only shown for Even Terminal errors; a live event clears a
  "connection interrupted" message; tap-to-retry re-subscribes.
- After a double tap, nothing redraws the glasses or reacts to input.
- Documented why the network whitelist cannot be narrowed.

## [0.4.0] — 2026-10-05

- Added a real backend selector for Even Terminal, Hermes and OpenClaw.
- Integrated the existing `hermes-evenhub-bridge` WebSocket contract for
  sessions, history, streamed answers, tool activity, interruption and new
  session creation.
- Integrated the existing OpenClaw `/v1/chat/completions` gateway with its
  bearer token, conversation context, health check and interrupt support.
- Added a phone prompt composer so Hermes and OpenClaw can be used directly
  instead of merely watched.
- Keeps permission controls capability-driven: only Even Terminal shows
  allow/deny actions because the existing Hermes and OpenClaw gateways do not
  expose an external permission-decision event.
- Added provider protocol tests and network permissions for configured HTTP,
  HTTPS and WebSocket gateways.

## [0.3.0] — 2026-10-05

- Added opt-in spoken output through the phone's current audio route, including
  AirPods and Bluetooth headphones on iOS and Android.
- Added language, installed system voice, and speech-speed controls.
- Buffers streamed tokens into completed sentences before speaking.
- Omits code blocks, inline code, URLs, permission commands, and token-looking values from
  spoken output; permission prompts use a generic alert instead of reading the
  command aloud.
- Added pause, resume, replay, and a one-tap activation flow required by phone
  WebViews.
- Documented the current provider boundary: Claude Code and Codex through Even
  Terminal; Hermes and OpenClaw need an adapter rather than being claimed as
  supported.

## [0.2.0] — 2026-10-05

- Converted the glasses UI, phone UI, errors, tests, and documentation to English.
- Added a private `?demo=1` mode with neutral in-memory data for safe screenshots.
- Replaced the live-session screenshot and removed personal example content.
- Fixed the package output name and updated the minimum Even App version.

## [0.1.0] — 2026-09-29

Initial proof of concept:

- Session list from Even Terminal with swipe selection.
- Session history and live SSE stream on the glasses.
- Permission requests answered with swipe up to allow or swipe down to deny.
- Clear distinction between controllable and watch-only sessions.
- Pairing by pasting the full address printed by the server.

### Implementation notes

- Even Terminal can only control sessions it started itself.
- `even-terminal claude` is a client; the server is `even-terminal start`.
- All endpoints live under `/api`.
- `--allow-cors` is required when the app and terminal run on different ports.
- `EventSource` cannot set an authorization header, so the local SSE endpoint
  accepts the token as a query parameter.

### Not included

- The permission view is covered by tests but has not yet been validated on
  physical glasses with a session started by Even Terminal.
- No voice input.
