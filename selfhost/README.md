# Self-hosting: everything on your own machines, reachable only through your Tailscale

Most Quietglass apps need no server. For the others (voice input, translation, your own routing,
agents, printers, status tiles ...) this folder gives you **everything that goes with them**: the server services
with systemd units and config templates, a config file for your addresses, and a script that builds the apps'
**private builds** from it.

## The principle

```
 Glasses ── Bluetooth ── iPhone (Even app, Tailscale) ──► your tailnet ──► Server (Tailscale)
                                                                           └─ 127.0.0.1:<port>  ← service
                                                                              tailscale serve --https=<port>
```

1. **Everything runs on your own machines** (PC, mini server, Raspberry Pi, NAS). Nothing is stored with us or in
   someone else's cloud.
2. **Access only inside your own tailnet.** Every service listens on `127.0.0.1` only. `tailscale serve` makes it
   available as `https://<your-machine>.<your-tailnet>.ts.net:<port>` **to your Tailscale devices only**, with a
   valid certificate. (The Even app loads the app over HTTPS and blocks plain `http://`/`ws://`.) Install
   Tailscale on the iPhone and on every server, with the same account, and you are done. No port forwarding, no
   public address.
3. **Sign-in with your Tailscale login instead of a token.** `tailscale serve` connects from the machine itself
   (loopback) and sets the header `Tailscale-User-Login`. The services trust this header **only from loopback**
   and **only for logins on an allow-list** (an environment variable). It cannot be forged from the LAN. The
   result: nothing to type, no token on the phone. A token stays available as an alternative.

| Service | Allow-list variable |
|---|---|
| quiet-hub (daemon) | `HUB_TAILSCALE_USERS` |
| status-server | `STATUS_TAILSCALE_USERS` |
| shoot-day | `SD_TAILSCALE_USERS` |
| klipper-bridge | `KL_TAILSCALE_USERS` |
| star-bridge | `STAR_TAILSCALE_USERS` |
| sugar-bridge | `SUGAR_TAILSCALE_USERS` (without an allow-list and without `TOKEN`: everything is blocked) |
| chargers | `GLANCE_TAILSCALE_USERS` (without an allow-list and without `GLANCE_TOKEN`: everything is blocked) |
| routes | `ROUTES_TAILSCALE_USERS` (without an allow-list and without `ROUTES_TOKEN`: everything is blocked) |
| glass-traffic | `TRAFFIC_TAILSCALE_USERS` (without an allow-list and without `TRAFFIC_TOKEN`: everything is blocked) |
| ha-relay | `RELAY_TAILSCALE_USERS` (without an allow-list: everything is blocked) |
| whisper (WebSocket), babel-llm-proxy | `TAILSCALE_USERS` (takes effect as soon as `TOKEN` is also set) |
| whisper (HTTP), oebb-proxy, valhalla | no sign-in; reachable only inside the tailnet, access can be restricted with a Tailscale ACL |

### `tailscale serve`: the rules

```bash
tailscale serve --bg --https=<port> http://127.0.0.1:<port>     # publish one service
tailscale serve status                                           # ALWAYS read it back
tailscale serve --https=<port> off                               # remove exactly one
```

**Never run `tailscale serve reset`.** It deletes *all* shares on the machine, including those of other services.
Every service gets its own `--https` number. Check what is already in use with `tailscale serve status` first.

## Overview: app, services, port

The ports are suggestions. You can choose others, as long as they match your `config.json`. "Local" is where the
service listens on the machine. "Tailscale" is the HTTPS number for `tailscale serve`.

| Service (folder in `services/`) | Local | Tailscale | App(s) |
|---|---|---|---|
| [`quiet-hub`](services/quiet-hub) (daemon + relay) | 8787 | **8443** | Quiet Hub |
| [`whisper`](services/whisper) (HTTP) | 8017 | **8457** | NextStop (speech), Shoot Day, Quiet Hub, FieldLog |
| [`whisper`](services/whisper) (Babel WebSocket) | 8120 | **8449** | Babel Glass |
| [`babel-llm-proxy`](services/babel-llm-proxy) | 8121 | **8448** | Babel Glass (translation) |
| [`oebb-proxy`](services/oebb-proxy) | 8079 | **8458** | NextStop (ÖBB real-time data) |
| [`status-server`](services/status-server) (one per machine) | 8199 | **8451** | Status Glass |
| [`shoot-day`](services/shoot-day) | 8896 | **8445** | Shoot Day |
| [`klipper-bridge`](services/klipper-bridge) | 8898 | **8447** | Klipper Glance |
| [`star-bridge`](services/star-bridge) (on the N.I.N.A. machine, Windows) | 8893 | **8460** | Star Glass |
| [`sugar-bridge`](services/sugar-bridge) (next to Nightscout; Nightscout itself stays local only) | 8466 | **8462** | Sugar Glass |
| [`valhalla`](services/valhalla) (Docker) | 8112 | **8455** | OpenGlance Nav (routing + street names), NextStop (walking routes) |
| [`chargers`](services/chargers) (charging stations from official registers) | 8467 | **8464** | OpenGlance Nav (charging stations; without it, the public Overpass is used) |
| [`routes`](services/routes) (saved routes + PC planning page) | 8468 | **8465** | OpenGlance Nav (same routes on phone and PC) |
| [`glass-traffic`](services/glass-traffic) (traffic jams and closures along the route: TomTom, ASFINAG DATEX II) | 8475 | **8474** | OpenGlance Nav (traffic, detours; without it, no traffic) |
| [`ha-relay`](services/ha-relay) (Home Assistant WebSocket relay, token stays on the server) | 8484 | **8483** | TV Glance, private build (`VITE_HA_RELAY`; no token, devices from `/config`) |
| Speech output: Piper TTS server with OpenAI-compatible `POST /v1/audio/speech` and CORS (external) | 8014 | **8459** | NextStop (announcements; without it, the phone voice is used) |
| Agent endpoint (Even Terminal / Hermes bridge / OpenClaw, external) | 8765 | **8446** | Agent Glass |
| LUMEN (separate project, **not** part of this repo) | – | **8454** | Lumen Glass |
| Xaventra (separate project: github.com/samuelvoltarius/xaventra) | – | **8790** | Xaventra HUD |

| App | Needs | Note |
|---|---|---|
| NextStop | optional `oebb-proxy`, `whisper`, `valhalla`, `tts` | Without any of them, it uses Transitous and the public FOSSGIS routing |
| OpenGlance Nav | `valhalla`, optional `chargers`, `whisper`, `tts`, `routes`, `traffic` | Otherwise it uses the public FOSSGIS server and the public Overpass (no private build needed) |
| Babel Glass | `whisper` (WebSocket) + `babel-llm-proxy` (+ an LLM server) | |
| FieldLog | `whisper` (HTTP) | You enter the address in the app. The private build allows only that origin |
| Quiet Hub | `quiet-hub` (+ a relay on each machine with agents) | optional `whisper`, LLM, Home Assistant |
| Agent Glass | an agent endpoint | see `apps/agent-glass` |
| Status Glass | `status-server` (at least 1) | any number of sources |
| Shoot Day | `shoot-day` (+ `whisper` for speech) | |
| Klipper Glance | `klipper-bridge` | |
| Star Glass | `star-bridge` | Runs next to N.I.N.A. (plugin "Advanced API"). Control only works with `STAR_ALLOW_CONTROL=1` |
| Sugar Glass | `sugar-bridge` + your own Nightscout | Read-only. The read token stays on the server. For information only: the pump and the sensor are what counts |
| Lumen Glass | LUMEN | separate project |
| Xaventra HUD | Xaventra daemon | separate project |
| Rain Lens | – | The radar page needs `options.rainRadar` (RainViewer: private use only) |
| FlowList, PostureLens, DecibelGuard, Cadence, ShiftClock, PodCaption, Market Glance, Endurance HUD | – | They need no Tailscale service from this folder (Market Glance / Endurance HUD / PodCaption: the bridges run locally, see their READMEs) |

## Step by step

1. **Install Tailscale** on the iPhone and on every server, with the same account everywhere. In the Tailscale
   admin console, turn on **MagicDNS** and **HTTPS certificates** (one time only).
2. **Clone the repo** (on every server that runs services): `git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2`
   The unit templates expect it there. Otherwise, adjust the paths in the `.service` files.
3. **Install the services.** Each folder in [`services/`](services) has its instructions (`README.md`), the
   config template (`.env.example`), the systemd unit and the `tailscale serve` command. Afterwards, check
   `systemctl --user is-active <service>` and `tailscale serve status`.
4. **Enter your addresses:** `cp config.example.json config.json`. Replace the placeholders with your real
   `https://<your-machine>.<your-tailnet>.ts.net:<port>` addresses, and delete the services you do not use.
   `config.json` is in `.gitignore` and is never committed.
5. **Build the private builds:**
   ```bash
   node selfhost/build-private.mjs --list                         # what is possible
   node selfhost/build-private.mjs --app nextstop --dry-run       # preview only, build nothing
   node selfhost/build-private.mjs --app nextstop                 # one app
   node selfhost/build-private.mjs                                # all apps whose services are listed in config.json
   ```
   Result: `release/<app>/<app>-<version>.ehpk` (not in Git). The script only needs Node 18+ and, for each app,
   `npm ci` (it runs this itself when needed).
6. **Upload it to the Even Hub as a private build** and install it in the Even app under *Me → Apps → Private Builds*
   (details: [`docs/SETUP.md`](../docs/SETUP.md)). The server addresses are already built in as defaults, so you do
   not have to enter anything on the phone.

## Why private builds? (the three traps)

1. **Exact origins in `app.json`.** The whitelist for the network permission must contain the exact origins
   (`https://host:port`). **Wildcards such as `https://*` are blocked on the real glasses.** They work in the
   simulator, but not on the glasses. The public `app.json` does not know your hosts (and should not).
   So `build-private.mjs` creates an **`app.private.json`** (gitignored) for each app, with your exact origins, and
   packs the app with it. An existing `app.private.json` is backed up once as `.bak`.
2. **CORS preflight: `204` with no body.** The app runs in a WebView with a foreign origin. The browser first sends
   `OPTIONS`. The answer must be **status 204 with no body**, with `Access-Control-Allow-Origin` set to the origin
   and `Access-Control-Allow-Headers` including `Authorization, Content-Type`. A body in the 204 makes iOS/WebKit
   drop the answer. The glasses then report "not reachable", even though `curl` works. All services here do this
   correctly. If you build your own, follow the same rule. (Valhalla and some third-party services cannot handle
   OPTIONS. The apps use `GET` with a query string there, which needs no preflight.)
3. **No typing of tokens.** See above: sign-in with the Tailscale login.

Also: the server addresses are built in as `VITE_*` build variables (`VITE_STT_URL`, `VITE_OEBB_URL`,
`VITE_ROUTER_URL`, `VITE_BABEL_STT`, `VITE_BABEL_LLM`, `VITE_BABEL_MODEL`, `VITE_STATUS_SOURCES`, `VITE_RADAR`).
An empty field in the app means "use the build's default".

## If something does not work

| Symptom | Cause / check |
|---|---|
| Glasses: "not reachable", but it works in the simulator | A wildcard in the whitelist. Use a private build. The origin must be exact (port included!) |
| Glasses: "not reachable", but `curl` works | The preflight has a body, or it has no `Access-Control-Allow-Origin` |
| 401 | Your login is missing from the service's allow-list variable (spelling = Tailscale login) |
| The phone cannot reach the server | Is Tailscale on at the iPhone? Check `tailscale serve status` on the server. Is the port in `config.json` correct? |
| `serve` does not show the address | Turn on HTTPS certificates in the Tailscale admin console |
