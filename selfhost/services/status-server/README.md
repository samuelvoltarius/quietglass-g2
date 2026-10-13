# status-server — Statusquelle für Status Glass

Status Glass zeigt Kacheln aus beliebig vielen **Quellen** (`GET …/status`). Diese Referenzquelle liefert CPU,
RAM, Last und Laufzeit des Rechners, auf dem sie läuft – eine Instanz pro Rechner (Server, Pi, NAS …).
**Der Code liegt im Repo und wird nicht kopiert:**
[`apps/status-glass/examples/reference-server.mjs`](../../../apps/status-glass/examples/reference-server.mjs)
(Node ≥ 18, keine Abhängigkeiten). Eigene Messwerte: `collect()` in der Datei ersetzen. Home Assistant:
[`home-assistant-adapter.mjs`](../../../apps/status-glass/examples/home-assistant-adapter.mjs) (eigene Unit
analog, `HA_URL`/`HA_TOKEN` nur in der Env-Datei).

| lokal | Tailscale-Port (Vorschlag) | App / Build-Variable |
|---|---|---|
| `127.0.0.1:8199` | `8451` | Quelle `https://<server>.<tailnet>.ts.net:8451/status` · `VITE_STATUS_SOURCES="Name|https://…:8451/status;Name2|…"` |

Anmeldung: `STATUS_TAILSCALE_USERS` = dein Tailscale-Login → kein Token am Handy nötig.

## Installieren (je Rechner)

```bash
git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2     # falls noch nicht da
mkdir -p ~/.config/quietglass ~/.config/systemd/user
cp .env.example ~/.config/quietglass/status-server.env && chmod 600 ~/.config/quietglass/status-server.env
$EDITOR ~/.config/quietglass/status-server.env          # NAME, STATUS_TAILSCALE_USERS
cp status-server.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now status-server
loginctl enable-linger "$USER"
curl -s http://127.0.0.1:8199/status | head -c 300
tailscale serve --bg --https=8451 http://127.0.0.1:8199      # nie "serve reset"
tailscale serve status
```

## English

One instance per machine. Code: `apps/status-glass/examples/reference-server.mjs` (not copied). Env file with
`NAME` and your Tailscale login in `STATUS_TAILSCALE_USERS`, install the user unit, publish with
`tailscale serve --bg --https=8451 http://127.0.0.1:8199`, add `https://<host>.<tailnet>.ts.net:8451/status` as a
source (or bake several into a private build via `VITE_STATUS_SOURCES`).
