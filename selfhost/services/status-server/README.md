# status-server — status source for Status Glass

Status Glass shows tiles from any number of **sources** (`GET …/status`). This reference source delivers the CPU,
RAM, load and uptime of the machine it runs on. Run one instance per machine (server, Pi, NAS ...).
**The code is in the repo and is not copied:**
[`apps/status-glass/examples/reference-server.mjs`](../../../apps/status-glass/examples/reference-server.mjs)
(Node ≥ 18, no dependencies). For your own measurements, replace `collect()` in the file. Home Assistant:
[`home-assistant-adapter.mjs`](../../../apps/status-glass/examples/home-assistant-adapter.mjs) (its own unit,
set up the same way; `HA_URL`/`HA_TOKEN` only in the env file).

| Local | Tailscale port (suggestion) | App / build variable |
|---|---|---|
| `127.0.0.1:8199` | `8451` | Source `https://<your-machine>.<your-tailnet>.ts.net:8451/status` · `VITE_STATUS_SOURCES="Name|https://…:8451/status;Name2|…"` |

Sign-in: `STATUS_TAILSCALE_USERS` = your Tailscale login → no token needed on the phone.

## Install (on each machine)

```bash
git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2     # if not there yet
mkdir -p ~/.config/quietglass ~/.config/systemd/user
cp .env.example ~/.config/quietglass/status-server.env && chmod 600 ~/.config/quietglass/status-server.env
$EDITOR ~/.config/quietglass/status-server.env          # NAME, STATUS_TAILSCALE_USERS
cp status-server.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now status-server
loginctl enable-linger "$USER"
curl -s http://127.0.0.1:8199/status | head -c 300
tailscale serve --bg --https=8451 http://127.0.0.1:8199      # never "serve reset"
tailscale serve status
```
