# oebb-proxy — ÖBB real-time data for NextStop

The ÖBB timetable service sends no CORS headers. The glasses app would drop the answer ("ÖBB not
reachable", even though `curl` works). This proxy (Node ≥ 18, no dependencies) forwards the requests and
adds CORS. **The code is in the repo and is not copied:**
[`apps/nextstop/examples/oebb-cors-proxy.mjs`](../../../apps/nextstop/examples/oebb-cors-proxy.mjs).

| Local | Tailscale port (suggestion) | App field / build variable |
|---|---|---|
| `127.0.0.1:8079` | `8458` | "Address of the ÖBB add-on" (Adresse des ÖBB-Zusatzes) = `https://<your-machine>.<your-tailnet>.ts.net:8458/oebb` · `VITE_OEBB_URL` |

The proxy has **no sign-in** (it only passes on public timetable data). It is reachable only inside the tailnet.
Note: the ÖBB endpoint is not an official open-data API. Without it, NextStop falls back to Transitous.

## Install

```bash
git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2     # if not there yet
mkdir -p ~/.config/quietglass ~/.config/systemd/user
cp .env.example ~/.config/quietglass/oebb-proxy.env
cp oebb-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now oebb-proxy
loginctl enable-linger "$USER"
systemctl --user is-active oebb-proxy
tailscale serve --bg --https=8458 http://127.0.0.1:8079      # never "serve reset"
tailscale serve status
```

`node` must be on the service's path (`/usr/bin/env node`). If it is only in `~/.local/bin`, add
`Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin` to the unit there.
