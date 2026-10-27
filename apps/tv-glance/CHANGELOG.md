# Changelog

## [0.2.1] — 2026-10-27

- **Private builds: `VITE_HA_RELAY`** — connects through your own `ha-relay` (tailnet service) with no token and
  no device picking: the app sends a placeholder token, fetches `<relay>/config` on start and, only while the
  saved device list is empty, stores those devices (first = active). The settings tab shows
  "Connected automatically via your relay" and the status (incl. relay unreachable). DE + EN.
- Without the variable nothing changes (public build: address + token typed by the user).

## [0.2.0] — 2026-10-27

### Neu: mehrere Geräte, auf der Brille umschaltbar

- **Geräteliste** statt eines einzelnen Fernsehers (Home Assistant): bis zu 6 Geräte, je `media_player.*`,
  optional `remote.*` (Steuerkreuz) und ein Name. Der gespeicherte Einzel-Fernseher aus 0.1.x wird beim
  ersten Start automatisch Gerät 1. Die Android-TV-Bridge bleibt ein Gerät.
- **Handy (Tab „Fernseher“):** Media-Player laden, Geräte per Tippen hinzufügen/entfernen, umbenennen
  (Standard: der Name aus Home Assistant), Steuerkreuz-Entität je Gerät wählen. DE + EN.
- **Brille:** auf der Startseite eine Zeile `Gerät: Name (n/m)` (nur bei ≥ 2 Geräten); Tippen = nächstes Gerät.
  Der Gerätename steht in der Kopfzeile und unter dem Fernseher-Bild; die Wahl bleibt gespeichert.
  Nur Tippen, Wischen und 2× – kein Halten.
- **Live:** eine WebSocket-Verbindung abonniert alle Geräte (`subscribe_entities`); Befehle gehen nur an das
  aktive Gerät.
- **`unavailable`** (z. B. Beamer im Standby) zeigt „nicht verfügbar“ statt eines Fehlers; es wird nichts gesendet.

## [0.1.1] — 2026-10-27

### Geändert: Home Assistant ohne jede Einrichtung in Home Assistant

- **Home Assistant über die WebSocket-API** (`/api/websocket`) statt REST: Anmeldung mit
  `{"type":"auth","access_token":…}`, Zustand live per `subscribe_entities` (komprimierte Änderungen),
  Befehle per `call_service`, Auswahl am Handy per `get_states`. WebSocket-Verbindungen unterliegen
  keinem CORS-Preflight, und Home Assistant prüft dort laut Quellcode (`websocket_api/http.py`,
  `auth.py`) den `Origin`-Kopf nicht – Adresse und Token genügen, kein `cors_allowed_origins` mehr nötig.
- Adressen mit http, https, ws oder wss; ein eingefügtes `/api/websocket` wird erkannt; Nabu-Casa-Adressen
  funktionieren wie jede https-Adresse.
- **REST nur noch als Ausweg**, wenn die WebSocket-Verbindung gar nicht zustande kommt (z. B. Proxy blockiert);
  danach wird nach einer Minute wieder WebSocket versucht. Ein abgelehntes Token fällt nie auf REST zurück.
  Befehle laufen über den Weg, über den zuletzt gelesen wurde (kein doppeltes Senden).
- Handy: der CORS-Hinweis steht nur noch eingeklappt unter „Fehlersuche: nicht erreichbar“.
- **Private Builds:** `VITE_HA_URL` gibt die Home-Assistant-Adresse vor (öffentlicher Build: leer, keine
  Adresse im Bundle). Das Token wird immer am Handy eingetragen, nie eingebaut.
- Live-Änderungen vom Fernseher zeichnen die Brille sofort neu (zusätzlich zum 5-s-Takt).

### Tests

- Fake-WebSocket-Server (Anmeldung, `get_states`, `subscribe_entities`, `call_service`, Verbindungsabbruch),
  Adress-Ableitung (http/https/ws/wss, Nabu Casa), REST-Ausweg und Rückkehr zu WebSocket, Vorgabe-Adresse.

## [0.1.0] — 2026-10-25

### Neu

- **TV Glance:** eine ruhige TV-Fernbedienung für die Even G2 nach QUS v1, ohne Quietglass-Server.
- **Zwei Wege zum Fernseher, am Handy wählbar:**
  - **Home Assistant** über die REST-API mit langlebigem Zugangstoken: Fernseher aus den
    `media_player.*`-Entitäten wählen, Zustand (an/aus, App, Titel, Quelle, Lautstärke, stumm),
    `media_play_pause`, `volume_up/down`, `volume_mute`, `turn_on/off`, `select_source` (aus der
    `source_list`), Apps per `play_media` (Typ `app`), Steuerkreuz per `remote.send_command`, wenn es
    eine passende `remote.*`-Entität gibt (Integration „Android TV Remote“). Die Handy-Seite zeigt die
    eigene Herkunft für `http: cors_allowed_origins`.
  - **Android-TV-Bridge** (`examples/androidtv-bridge.py`, Referenz mit `androidtvremote2`): Kopplung
    mit dem Code vom Fernseher, kleine HTTP-API (`GET /state`, `POST /key`, `/app`, `/power`) mit CORS
    (Preflight 204 ohne Body), Anmeldung per Tailscale-Login (nur von Loopback) oder Bearer-Token,
    Selbsttest mit Fake-Fernseher (`--selftest`), systemd-Beispiel.
- **Brille:** Startseite mit höchstens drei Einträgen (Fernbedienung, Apps & Eingang, Steuerkreuz –
  letzteres nur, wenn der Fernseher es kann). Fernbedienung als Cockpit-Bild (Fernseher mit
  Play/Pause/Aus, Lautstärkebalken, App groß, Titel, Status/Ton/Quelle). Tippen = Play/Pause (aus: TV an),
  Wischen hoch/runter = lauter/leiser (gesammelt, 350 ms nach dem letzten Wischen gesendet, höchstens
  5 Schritte), 2× = zurück bzw. Beenden-Dialog auf der Startseite.
- **Ausschalten fragt nach:** zweites Tippen innerhalb von 4 s; Wischen oder 2× bricht ab.
- **Kein Halten, kein Seitenmenü**, keine Fehlercodes auf der Brille; Beenden-Dialog nach dem
  gemessenen Ablauf (4 = Dialog offen, 5 nach „Nein“ = Seite wie beim ersten Start zurück).
- **Demo-Fernseher** ohne Einrichtung (mit DEMO beschriftet, kein Netzwerk) – für die Store-Prüfung.
- **Handy:** genau drei Tabs (Jetzt / Fernseher / Einstellungen), Erststart-Checkliste, Tokens nur
  schreibbar („gesetzt (n Zeichen)“), Deutsch/Englisch.
- **Store:** keine URL im Bundle (`tools/check-store-urls.mjs tv-glance` = ok), Netzwerk-Freigabe
  `http://*`/`https://*` für die selbst eingetragene Adresse, Hub-Symbol 24×24, durchsichtige
  Store-Bilder per `QG_PREVIEW=1 npx vitest run tests/preview.test.ts`.

### Tests

- Adapter gegen Fakes (Home Assistant, Bridge, Demo), Gesten, Entprellen der Lautstärke,
  Ausschalt-Bestätigung, Beenden-Dialog in Hardware-Reihenfolge, Zeilenbreiten DE/EN, i18n-Schlüssel,
  URL-Prüfung der Quellen, Bridge-Selbsttest.
