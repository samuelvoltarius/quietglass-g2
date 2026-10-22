# star-bridge — N.I.N.A. bridge for Star Glass

N.I.N.A. runs on the imaging computer (Windows), while the phone can be anywhere. The bridge runs **on the
computer with N.I.N.A.**, reads the **Advanced API** plugin (`http://127.0.0.1:1888/v2/api`) and gives the phone
a compact status plus a small preview image. "Pause / resume sequence" is **off** until you set
`STAR_ALLOW_CONTROL=1`, and it is still refused without sign-in (`STAR_TAILSCALE_USERS` or `TOKEN`).
The weather station and safety monitor from N.I.N.A. are included in the status automatically. The bridge passes on
the location (for the weather forecast in the app) only with `STAR_SITE=1`, rounded to 2 decimal places (~1 km).
**The code is in the repo and is not copied:**
[`apps/star-glass/examples/star-bridge.mjs`](../../../apps/star-glass/examples/star-bridge.mjs)
(Node ≥ 18, no dependencies). To test without a telescope: `mock-nina.mjs` in the same folder.

**Access only through Tailscale:** the bridge listens on `127.0.0.1` and is published with `tailscale serve`
(only inside your own tailnet). Tailscale sets the header `Tailscale-User-Login`; the bridge trusts it only from loopback.

| Local | Tailscale port (suggestion) | App field / build |
|---|---|---|
| `127.0.0.1:8893` | `8460` | "Bridge address" (Bridge-Adresse) = `https://<your-machine>.<your-tailnet>.ts.net:8460` (`VITE_STAR_URL`) |

## Windows (the usual case: the N.I.N.A. computer)

User autostart without Task Scheduler: a restart loop, started hidden from the Startup folder.

```powershell
git clone https://github.com/samuelvoltarius/quietglass-g2 C:\path\to\quietglass-g2
mkdir $env:LOCALAPPDATA\quiet-hub -Force
copy star-bridge-loop.example.cmd $env:LOCALAPPDATA\quiet-hub\star-bridge-loop.cmd   # adjust path + login
copy "Star Glass Bridge.example.vbs" "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Star Glass Bridge.vbs"
wscript "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Star Glass Bridge.vbs"
tailscale serve status                                          # read first: which ports are in use?
tailscale serve --bg --https=8460 http://127.0.0.1:8893         # never "serve reset"
tailscale serve status
```

Log: `%LOCALAPPDATA%\quiet-hub\star-bridge.log`. Self-test from another device in the tailnet:
`curl https://<your-machine>.<your-tailnet>.ts.net:8460/api/star` → JSON with `"online": true`.
Directly on `127.0.0.1:8893` without the header, you deliberately get `401`.

## Linux (bridge on a different computer in the same network)

This works too: `STAR_NINA=http://<nina-pc>:1888` (the plugin must then listen on the LAN). The service works like
the others: `star-bridge.service` (instructions at the top of the file).

## Moving to a different imaging computer

Install only the bridge there (above), set up `tailscale serve` there, and build a new private build with the
new address (`services.star` in `selfhost/config.json`, then `node selfhost/build-private.mjs star-glass`).
