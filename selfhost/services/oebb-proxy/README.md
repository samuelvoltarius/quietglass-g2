# oebb-proxy — ÖBB-Echtzeit für NextStop

Der ÖBB-Fahrplandienst sendet keine CORS-Header; die Brillen-App würde die Antwort verwerfen („ÖBB nicht
erreichbar“, obwohl `curl` geht). Dieser Proxy (Node ≥ 18, keine Abhängigkeiten) reicht die Anfragen weiter und
ergänzt CORS. **Der Code liegt im Repo und wird nicht kopiert:**
[`apps/nextstop/examples/oebb-cors-proxy.mjs`](../../../apps/nextstop/examples/oebb-cors-proxy.mjs).

| lokal | Tailscale-Port (Vorschlag) | App-Feld / Build-Variable |
|---|---|---|
| `127.0.0.1:8079` | `8458` | „Adresse des ÖBB-Zusatzes“ = `https://<server>.<tailnet>.ts.net:8458/oebb` · `VITE_OEBB_URL` |

Der Proxy hat **keine Anmeldung** (er gibt nur öffentliche Fahrplandaten weiter) – er ist nur im Tailnet erreichbar.
Hinweis: Der ÖBB-Endpunkt ist kein offizielles Open-Data-API; ohne ihn fällt NextStop auf Transitous zurück.

## Installieren

```bash
git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2     # falls noch nicht da
mkdir -p ~/.config/quietglass ~/.config/systemd/user
cp .env.example ~/.config/quietglass/oebb-proxy.env
cp oebb-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now oebb-proxy
loginctl enable-linger "$USER"
systemctl --user is-active oebb-proxy
tailscale serve --bg --https=8458 http://127.0.0.1:8079      # nie "serve reset"
tailscale serve status
```

`node` muss im Pfad des Dienstes liegen (`/usr/bin/env node`); liegt es nur in `~/.local/bin`, dort in der Unit
`Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin` ergänzen.

## English

CORS proxy so NextStop can read ÖBB live data (the upstream sends no CORS headers). Code stays in
`apps/nextstop/examples/oebb-cors-proxy.mjs`; install the user unit, publish `127.0.0.1:8079` as
`tailscale serve --bg --https=8458 http://127.0.0.1:8079`, and give the app
`https://<server>.<tailnet>.ts.net:8458/oebb` (build variable `VITE_OEBB_URL`). No login (public data), tailnet only.
