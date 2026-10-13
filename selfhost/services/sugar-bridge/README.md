# sugar-bridge — Nightscout für Sugar Glass (nur Lesen, nur Tailnet)

> **Nur zur Information, keine Therapieentscheidungen – maßgeblich sind Pumpe und Sensor.**
> Sugar Glass ersetzt keine Alarme. Lass die Warnungen deiner Pumpe/Sensor-App an.

```
 Pumpe/Sensor ─► Hersteller-App ─► Hersteller-Cloud ─► Uploader/Brücke ─► Nightscout (127.0.0.1)
                                                                              ▲
                     Brille ◄─ iPhone ◄─ tailscale serve :8462 ◄─ sugar-bridge (127.0.0.1:8466, Lese-Token)
```

* **Nightscout** läuft lokal (Docker, nur `127.0.0.1`), mit `AUTH_DEFAULT_ROLES=denied`: ohne Token keine Werte.
* **sugar-bridge** ([`apps/sugar-glass/examples/sugar-bridge.mjs`](../../../apps/sugar-glass/examples/sugar-bridge.mjs),
  Node ≥ 18, ohne Abhängigkeiten) hält einen Token mit Rolle **`readable`** und reicht nur wenige GET-Pfade durch
  (`entries`, `devicestatus`, `treatments`, `status`, `profile`). Schreiben geht nicht (405), alles andere 404.
* Freigegeben wird **nur die Bridge** per `tailscale serve`; Zugriff nur für Logins aus `SUGAR_TAILSCALE_USERS`.
  Die App braucht dann keinen Token (er liegt nie im Paket).

| lokal | Tailscale-Port (Vorschlag) | App / Build |
|---|---|---|
| Nightscout `127.0.0.1:8463` | – (nicht freigeben) | – |
| sugar-bridge `127.0.0.1:8466` | `8462` | `VITE_NS_URL=https://<server>.<tailnet>.ts.net:8462` (`services.sugar`) |

## 1. Nightscout (Docker)

Vorlage: [`nightscout/docker-compose.yml`](nightscout/docker-compose.yml) — Nightscout 15.0.8 + MongoDB 7, Speicher
begrenzt (`mem_limit`), mg/dL, `Europe/Vienna`, Deutsch, Grenzen 54/70/180/250.

```bash
sudo mkdir -p /opt/nightscout && cd /opt/nightscout
# docker-compose.yml, carelink/ und carelink.env.example hierher kopieren
umask 077
printf 'API_SECRET=%s\n' "$(openssl rand -hex 24)" > .env          # nie ausgeben
cp carelink.env.example carelink.env && chmod 600 .env carelink.env
mkdir -p carelink-data mongo-data && chown 1000:1000 carelink-data && chmod 700 carelink-data
docker compose up -d
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8463/api/v1/status.json   # 401 = gut (gesperrt)
```

**Falle:** Docker legt neue Netze oft in `192.168.0.0/20` an. Nimmt der Rechner per Tailscale eine Subnetzroute
`192.168.0.0/24` an, landen die Pakete im Tunnel statt im Container (Port-Freigabe: „connection reset“). Die Vorlage
setzt deshalb ein eigenes Netz (`192.168.208.0/24`); prüfe mit `ip route show table 52`, was frei ist.

**Lese-Token anlegen** (Rolle `readable`), ohne ihn anzuzeigen:

```bash
H=$(grep ^API_SECRET= .env | cut -d= -f2- | tr -d '\n' | sha1sum | cut -d' ' -f1)
curl -s -X POST -H "api-secret: $H" -H 'Content-Type: application/json' \
  -d '{"name":"sugarglass","roles":["readable"]}' http://127.0.0.1:8463/api/v2/authorization/subjects
TOK=$(curl -s -H "api-secret: $H" http://127.0.0.1:8463/api/v2/authorization/subjects \
  | python3 -c 'import sys,json;print([s["accessToken"] for s in json.load(sys.stdin) if s["name"]=="sugarglass"][0])')
printf 'NS_READ_TOKEN=%s\n' "$TOK" >> .env
```

## 2. Woher die Werte kommen (Uploader)

Nightscout bekommt Werte von einer Brücke deiner Wahl (xDrip+, Dexcom-Share, LibreLinkUp, AAPS/Loop …).
Für **Medtronic MiniMed 780G** (Guardian 4 / Simplera Sync) über **CareLink** liegt eine Vorlage bei:
der Community-Fork [NovaLux12/carelink-bridge](https://github.com/NovaLux12/carelink-bridge) (Commit festgenagelt)
in einem eigenen Container mit **Wächter** ([`nightscout/carelink/guard.sh`](nightscout/carelink/guard.sh)):

* Stehen in `carelink.env` noch Platzhalter, oder fehlt der Login-Token, **pausiert** der Container (schläft) –
  er meldet sich **nie** selbst mit dem Passwort an und läuft nicht in eine Neustart-Schleife.
  Hintergrund: Medtronic sperrt Konten nach mehreren Fehlversuchen.
* Der einzige Login ist ein **einmaliger, manueller** Schritt:
  `docker compose run --rm -it carelink login` → bei CAPTCHA wird eine Adresse ausgegeben; im Browser anmelden,
  die Umleitungs-Adresse mit `code=` (Entwicklerwerkzeuge → Netzwerk, Filter `code=`) zurück ins Terminal kopieren.
  Danach erneuert die Brücke den Token selbst (`carelink-data/logindata.json`, 600).
* Dann `docker compose up -d carelink`; Log: `docker logs -f nightscout-carelink`.

Inoffiziell (simuliert die CareLink-App) – Medtronic kann die Schnittstelle jederzeit ändern. Nicht dauernd neu
einloggen: jeder Login der offiziellen App am selben Konto kann den Token ungültig machen.

## 3. sugar-bridge

```bash
sudo mkdir -p /opt/sugar-bridge
sudo cp ~/quietglass-g2/apps/sugar-glass/examples/sugar-bridge.mjs /opt/sugar-bridge/
sudo install -m 600 .env.example /opt/sugar-bridge/.env   # NS_TOKEN = der readable-Token, SUGAR_TAILSCALE_USERS = dein Login
sudo cp sugar-bridge.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now sugar-bridge
tailscale serve status                                   # erst lesen
tailscale serve --bg --https=8462 http://127.0.0.1:8466  # nie "serve reset"
tailscale serve status
```

Selbsttest von einem anderen Tailnet-Gerät (gleicher Login): `curl https://<server>.<tailnet>.ts.net:8462/api/v1/status.json`
→ 200. Direkt auf `127.0.0.1:8466` ohne Kopf → 401 (gewollt). Prüfe auch: `ss -tlnp | grep 8463` zeigt nur `127.0.0.1`.

## English

Nightscout stays on loopback with `AUTH_DEFAULT_ROLES=denied`. `sugar-bridge.mjs` holds a token with role
`readable`, passes only a few GET paths and is the only thing published (`tailscale serve --https=8462`,
`SUGAR_TAILSCALE_USERS`). The app needs no token. For a MiniMed 780G the compose file includes a pinned CareLink
bridge behind a guard that never logs in by itself (Medtronic locks accounts after failed logins); the one-time
login is `docker compose run --rm -it carelink login`. **For information only — your pump and sensor are what count.**
