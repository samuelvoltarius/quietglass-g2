# Selbst hosten — alles auf deinen Rechnern, Zugriff nur über dein Tailscale

*[English version below](#english)*

Die meisten Quietglass-Apps brauchen keinen Server. Für die anderen (Spracheingabe, Übersetzung, eigenes Routing,
Agenten, Drucker, Statusanzeigen …) bekommst du hier **alles, was dazugehört**: die Server-Dienste samt
systemd-Units und Konfig-Vorlagen, eine Konfigurationsdatei für deine Adressen und ein Skript, das daraus die
**privaten Builds** der Apps baut.

## Das Prinzip

```
 Brille ── Bluetooth ── iPhone (Even-App, Tailscale) ──► dein Tailnet ──► Server (Tailscale)
                                                                           └─ 127.0.0.1:<Port>  ← Dienst
                                                                              tailscale serve --https=<Port>
```

1. **Alles läuft auf deinen eigenen Rechnern** (PC, Mini-Server, Raspberry Pi, NAS). Nichts liegt bei uns oder in
   einer fremden Cloud.
2. **Zugriff nur im eigenen Tailnet.** Jeder Dienst lauscht nur auf `127.0.0.1`. Mit `tailscale serve` wird er als
   `https://<rechner>.<tailnet>.ts.net:<port>` **nur für deine Tailscale-Geräte** erreichbar — mit gültigem
   Zertifikat (die Even-App lädt die App über HTTPS und blockiert Klartext-`http://`/`ws://`). Tailscale auf dem
   iPhone und auf jedem Server, gleiches Konto, fertig. Kein Port-Forwarding, keine öffentliche Adresse.
3. **Anmeldung über deinen Tailscale-Login statt Token.** `tailscale serve` verbindet vom Rechner selbst
   (Loopback) und setzt den Header `Tailscale-User-Login`. Die Dienste vertrauen dem Header **nur von Loopback** und
   **nur für Logins aus einer Allowlist** (Umgebungsvariable). Aus dem LAN lässt er sich nicht fälschen. Ergebnis:
   Nichts eintippen, kein Token am Handy. Ein Token bleibt als Alternative.

| Dienst | Allowlist-Variable |
|---|---|
| quiet-hub (Daemon) | `HUB_TAILSCALE_USERS` |
| status-server | `STATUS_TAILSCALE_USERS` |
| shoot-day | `SD_TAILSCALE_USERS` |
| klipper-bridge | `KL_TAILSCALE_USERS` |
| star-bridge | `STAR_TAILSCALE_USERS` |
| sugar-bridge | `SUGAR_TAILSCALE_USERS` (ohne Allowlist und ohne `TOKEN`: alles gesperrt) |
| whisper (WebSocket), babel-llm-proxy | `TAILSCALE_USERS` (wirkt, sobald auch `TOKEN` gesetzt ist) |
| whisper (HTTP), oebb-proxy, valhalla | keine Anmeldung — nur im Tailnet erreichbar, Zugriff per Tailscale-ACL einschränkbar |

### `tailscale serve` — die Regeln

```bash
tailscale serve --bg --https=<port> http://127.0.0.1:<port>     # einen Dienst freigeben
tailscale serve status                                           # IMMER zurücklesen
tailscale serve --https=<port> off                               # genau einen wieder entfernen
```

**Niemals `tailscale serve reset`** — das löscht *alle* Freigaben des Rechners, auch die anderer Dienste.
Jeder Dienst bekommt seine eigene `--https`-Nummer; prüfe vorher mit `tailscale serve status`, was belegt ist.

## Übersicht: App → Dienste → Port

Die Ports sind Vorschläge (frei wählbar, sie müssen nur zu deiner `config.json` passen). „Lokal“ = wo der Dienst
auf dem Rechner lauscht, „Tailscale“ = die HTTPS-Nummer für `tailscale serve`.

| Dienst (Ordner in `services/`) | lokal | Tailscale | App(s) |
|---|---|---|---|
| [`quiet-hub`](services/quiet-hub) (Daemon + Relay) | 8787 | **8443** | Quiet Hub |
| [`whisper`](services/whisper) — HTTP | 8017 | **8457** | NextStop (Sprache), Shoot Day, Quiet Hub, FieldLog |
| [`whisper`](services/whisper) — Babel-WebSocket | 8120 | **8449** | Babel Glass |
| [`babel-llm-proxy`](services/babel-llm-proxy) | 8121 | **8448** | Babel Glass (Übersetzung) |
| [`oebb-proxy`](services/oebb-proxy) | 8079 | **8458** | NextStop (ÖBB-Echtzeit) |
| [`status-server`](services/status-server) (je Rechner) | 8199 | **8451** | Status Glass |
| [`shoot-day`](services/shoot-day) | 8896 | **8445** | Shoot Day |
| [`klipper-bridge`](services/klipper-bridge) | 8898 | **8447** | Klipper Glance |
| [`star-bridge`](services/star-bridge) (auf dem N.I.N.A.-Rechner, Windows) | 8893 | **8460** | Star Glass |
| [`sugar-bridge`](services/sugar-bridge) (neben Nightscout; Nightscout selbst nur lokal) | 8466 | **8462** | Sugar Glass |
| [`valhalla`](services/valhalla) (Docker) | 8112 | **8455** | OpenGlance Nav, NextStop (Fußwege) |
| Sprachausgabe: Piper-TTS-Server mit OpenAI-kompatiblem `POST /v1/audio/speech` und CORS (extern) | 8014 | **8459** | NextStop (Ansagen; ohne = Handy-Stimme) |
| Agent-Endpunkt (Even Terminal / Hermes-Bridge / OpenClaw, extern) | 8765 | **8446** | Agent Glass |
| LUMEN (eigenes Projekt, **nicht** Teil dieses Repos) | – | **8454** | Lumen Glass |
| Xaventra (eigenes Projekt: github.com/samuelvoltarius/xaventra) | – | **8790** | Xaventra HUD |

| App | benötigt | Bemerkung |
|---|---|---|
| NextStop | optional `oebb-proxy`, `whisper`, `valhalla`, `tts` | ohne alles läuft es mit Transitous und dem öffentlichen FOSSGIS-Routing |
| OpenGlance Nav | `valhalla` | sonst öffentlicher FOSSGIS-Server (braucht keinen Privat-Build) |
| Babel Glass | `whisper` (WebSocket) + `babel-llm-proxy` (+ ein LLM-Server) | |
| FieldLog | `whisper` (HTTP) | Adresse trägst du in der App ein; der Privat-Build erlaubt nur den Ursprung |
| Quiet Hub | `quiet-hub` (+ Relay je Rechner mit Agenten) | optional `whisper`, LLM, Home Assistant |
| Agent Glass | ein Agenten-Endpunkt | siehe `apps/agent-glass` |
| Status Glass | `status-server` (≥ 1) | beliebig viele Quellen |
| Shoot Day | `shoot-day` (+ `whisper` für Sprache) | |
| Klipper Glance | `klipper-bridge` | |
| Star Glass | `star-bridge` | läuft neben N.I.N.A. (Plugin „Advanced API“); Steuern nur mit `STAR_ALLOW_CONTROL=1` |
| Sugar Glass | `sugar-bridge` + eigenes Nightscout | nur Lesen; Lese-Token bleibt am Server. Nur zur Information – maßgeblich sind Pumpe und Sensor |
| Lumen Glass | LUMEN | separates Projekt |
| Xaventra HUD | Xaventra-Daemon | separates Projekt |
| Rain Lens | – | Radar-Seite nur mit `options.rainRadar` (RainViewer: nur private Nutzung) |
| FlowList, PostureLens, DecibelGuard, Cadence, ShiftClock, PodCaption, Market Glance, Endurance HUD | – | brauchen keinen Tailscale-Dienst aus diesem Ordner (Market Glance / Endurance HUD / PodCaption: Bridges laufen lokal, siehe deren README) |

## Schritt für Schritt

1. **Tailscale** auf dem iPhone und auf jedem Server installieren, überall dasselbe Konto. In der
   Tailscale-Admin-Konsole **MagicDNS** und **HTTPS-Zertifikate** einschalten (einmalig).
2. **Repo klonen** (auf jedem Server, der Dienste betreibt): `git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2`
   — die Unit-Vorlagen erwarten es dort; sonst Pfade in den `.service`-Dateien anpassen.
3. **Dienste installieren** — pro Ordner in [`services/`](services) steht die Anleitung (`README.md`), die
   Konfigvorlage (`.env.example`), die systemd-Unit und der `tailscale serve`-Befehl. Danach
   `systemctl --user is-active <dienst>` und `tailscale serve status` prüfen.
4. **Adressen eintragen:** `cp config.example.json config.json`, die Platzhalter durch deine echten
   `https://<rechner>.<tailnet>.ts.net:<port>` ersetzen, nicht genutzte Dienste löschen. `config.json` ist in
   `.gitignore` und wird nie committet.
5. **Private Builds bauen:**
   ```bash
   node selfhost/build-private.mjs --list                         # was geht
   node selfhost/build-private.mjs --app nextstop --dry-run       # nur anzeigen, nichts bauen
   node selfhost/build-private.mjs --app nextstop                 # eine App
   node selfhost/build-private.mjs                                # alle Apps, deren Dienste in config.json stehen
   ```
   Ergebnis: `release/<app>/<app>-<version>.ehpk` (nicht im Git). Das Skript braucht nur Node 18+ und je App
   `npm ci` (macht es bei Bedarf selbst).
6. **Als privaten Build in den Even Hub laden** und in der Even-App unter *Me → Apps → Private Builds* installieren
   (Details: [`docs/SETUP.md`](../docs/SETUP.md)). Die Server-Adressen sind schon als Vorgabe im Build — am Handy
   muss nichts eingetragen werden.

## Warum Privat-Builds? (die drei Fallen)

1. **Exakte Origins in `app.json`.** Die Whitelist der Netzwerk-Berechtigung muss die genauen Ursprünge
   (`https://host:port`) enthalten. **Wildcards wie `https://*` werden auf der echten Brille blockiert** — im
   Simulator laufen sie, auf der Brille nicht. Das öffentliche `app.json` kennt deine Hosts nicht (und soll sie
   nicht kennen). Darum erzeugt `build-private.mjs` pro App eine **`app.private.json`** (gitignored) mit deinen
   exakten Origins und packt damit. Eine vorhandene `app.private.json` wird einmalig als `.bak` gesichert.
2. **CORS-Preflight: `204` ohne Body.** Die App läuft in einer WebView mit fremdem Ursprung; der Browser schickt
   vorab `OPTIONS`. Die Antwort muss **Status 204 ohne Body** sein, mit `Access-Control-Allow-Origin` = Ursprung
   und `Access-Control-Allow-Headers` inkl. `Authorization, Content-Type`. Ein Body im 204 lässt iOS/WebKit die
   Antwort verwerfen — die Brille meldet „nicht erreichbar“, obwohl `curl` geht. Alle Dienste hier machen das
   richtig. Baust du einen eigenen: dieselbe Regel. (Valhalla und manche Fremddienste können OPTIONS nicht — die
   Apps nutzen dort `GET` mit Query, das braucht keinen Preflight.)
3. **Kein Token-Eintippen.** Siehe oben: Anmeldung über den Tailscale-Login.

Dazu: Server-Adressen sind als `VITE_*`-Build-Variablen eingebaut (`VITE_STT_URL`, `VITE_OEBB_URL`,
`VITE_ROUTER_URL`, `VITE_BABEL_STT`, `VITE_BABEL_LLM`, `VITE_BABEL_MODEL`, `VITE_STATUS_SOURCES`, `VITE_RADAR`);
ein leeres Feld in der App heißt „Vorgabe des Builds“.

## Wenn etwas nicht geht

| Symptom | Ursache / Prüfung |
|---|---|
| Brille: „nicht erreichbar“, im Simulator geht’s | Wildcard in der Whitelist → Privat-Build verwenden; Origin exakt (Port!) |
| Brille: „nicht erreichbar“, `curl` geht | Preflight mit Body oder ohne `Access-Control-Allow-Origin` |
| 401 | Dein Login fehlt in der Allowlist-Variable des Dienstes (Schreibweise = Tailscale-Login) |
| Handy erreicht den Server nicht | Tailscale auf dem iPhone an? `tailscale serve status` auf dem Server; Port in `config.json` richtig? |
| `serve` zeigt die Adresse nicht | HTTPS-Zertifikate in der Tailscale-Admin-Konsole einschalten |

---

## English

Most Quietglass apps need no server. For the rest (voice input, translation, own routing, agents, printer, status
tiles …) this folder holds **everything that goes with them**: the server services with systemd units and config
templates, a config file for your addresses, and a script that builds the apps' **private builds** from it.

### Principle

1. **Everything runs on your own machines** (PC, mini server, Raspberry Pi, NAS) — nothing on someone else's cloud.
2. **Access only inside your own tailnet.** Each service listens on `127.0.0.1` only. `tailscale serve` publishes
   it as `https://<machine>.<tailnet>.ts.net:<port>` **to your Tailscale devices only**, with a valid certificate
   (the Even app loads the app over HTTPS and blocks plain `http://`/`ws://`). Install Tailscale on the iPhone and
   on each server, same account, done. No port forwarding, no public address.
3. **Sign-in through your Tailscale login instead of a token.** `tailscale serve` connects from loopback and sets
   `Tailscale-User-Login`. The services trust that header **only from loopback** and **only for logins on an
   allow-list** (environment variable, see the table above), so it cannot be spoofed from the LAN. Nothing to type
   on the phone; a token stays available as an alternative.

`tailscale serve --bg --https=<port> http://127.0.0.1:<port>` publishes one service; read back with
`tailscale serve status`; remove one with `tailscale serve --https=<port> off`. **Never `tailscale serve reset`**
(it wipes every share on the machine).

### Why private builds

- **Exact origins in `app.json`.** The network whitelist must list exact origins (`https://host:port`); wildcards
  such as `https://*` are blocked on real glasses (they work in the simulator). The public `app.json` must not
  contain your hosts, so `build-private.mjs` writes a git-ignored `app.private.json` per app with your exact
  origins and packs that.
- **CORS preflight: `204` with no body**, `Access-Control-Allow-Origin` = the request origin, allowed headers
  including `Authorization, Content-Type`. A body in the 204 makes iOS/WebKit drop the answer ("unreachable" on the
  glasses while `curl` works). Services that cannot answer OPTIONS (e.g. Valhalla) are called with plain `GET` and
  a query string, which needs no preflight.
- **Server addresses are baked in** as `VITE_*` build variables, so nothing has to be typed on the phone.

### Steps

1. Tailscale on iPhone and servers (same account; MagicDNS + HTTPS certificates enabled in the admin console).
2. `git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2` on each server.
3. Install the services you want — each folder in [`services/`](services) has its README, `.env.example`, systemd
   unit and `tailscale serve` command.
4. `cp config.example.json config.json`, put in your real `https://<machine>.<tailnet>.ts.net:<port>` addresses
   (`config.json` is git-ignored).
5. `node selfhost/build-private.mjs --list`, then `--app <name> --dry-run` to preview, then without `--dry-run`
   (or without `--app` for every configured app). Output: `release/<app>/<app>-<version>.ehpk`.
6. Upload the `.ehpk` as a private build in the Even Hub and install it from *Me → Apps → Private Builds* in the
   Even app (see [`docs/SETUP.md`](../docs/SETUP.md)).

The port table above is a suggestion; use any ports as long as `config.json` matches. LUMEN and Xaventra are
separate projects and not part of this repository.
