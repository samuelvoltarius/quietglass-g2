# sugar-bridge — Nightscout for Sugar Glass (read-only, tailnet only)

> **For information only, not for therapy decisions. The pump and the sensor are what counts.**
> Sugar Glass does not replace alarms. Keep the warnings of your pump/sensor app switched on.

```
 Pump/sensor ─► manufacturer app ─► manufacturer cloud ─► uploader/bridge ─► Nightscout (127.0.0.1)
                                                                              ▲
                     Glasses ◄─ iPhone ◄─ tailscale serve :8462 ◄─ sugar-bridge (127.0.0.1:8466, read token)
```

* **Nightscout** runs locally (Docker, `127.0.0.1` only), with `AUTH_DEFAULT_ROLES=denied`: without a token there are no values.
* **sugar-bridge** ([`apps/sugar-glass/examples/sugar-bridge.mjs`](../../../apps/sugar-glass/examples/sugar-bridge.mjs),
  Node ≥ 18, no dependencies) holds a token with the role **`readable`** and passes through only a few GET paths
  (`entries`, `devicestatus`, `treatments`, `status`, `profile`). Writing is not possible (405), everything else is 404.
* Only **the bridge** is published with `tailscale serve`. Access is only for logins in `SUGAR_TAILSCALE_USERS`.
  The app then needs no token (it is never in the package).

| Local | Tailscale port (suggestion) | App / build |
|---|---|---|
| Nightscout `127.0.0.1:8463` | – (do not publish) | – |
| sugar-bridge `127.0.0.1:8466` | `8462` | `VITE_NS_URL=https://<your-machine>.<your-tailnet>.ts.net:8462` (`services.sugar`) |

## 1. Nightscout (Docker)

Template: [`nightscout/docker-compose.yml`](nightscout/docker-compose.yml). Nightscout 15.0.8 + MongoDB 7, memory
limited (`mem_limit`), mg/dL, `Europe/Vienna`, German, limits 54/70/180/250.

```bash
sudo mkdir -p /opt/nightscout && cd /opt/nightscout
# copy docker-compose.yml, carelink/ and carelink.env.example here
umask 077
printf 'API_SECRET=%s\n' "$(openssl rand -hex 24)" > .env          # never print it
cp carelink.env.example carelink.env && chmod 600 .env carelink.env
mkdir -p carelink-data mongo-data && chown 1000:1000 carelink-data && chmod 700 carelink-data
docker compose up -d
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8463/api/v1/status.json   # 401 = good (locked)
```

**Trap:** Docker often creates new networks in `192.168.0.0/20`. If the machine accepts a subnet route
`192.168.0.0/24` through Tailscale, the packets end up in the tunnel instead of the container (port mapping: "connection
reset"). So the template sets its own network (`192.168.208.0/24`). Check with `ip route show table 52` what is free.

**Create the read token** (role `readable`) without showing it:

```bash
H=$(grep ^API_SECRET= .env | cut -d= -f2- | tr -d '\n' | sha1sum | cut -d' ' -f1)
curl -s -X POST -H "api-secret: $H" -H 'Content-Type: application/json' \
  -d '{"name":"sugarglass","roles":["readable"]}' http://127.0.0.1:8463/api/v2/authorization/subjects
TOK=$(curl -s -H "api-secret: $H" http://127.0.0.1:8463/api/v2/authorization/subjects \
  | python3 -c 'import sys,json;print([s["accessToken"] for s in json.load(sys.stdin) if s["name"]=="sugarglass"][0])')
printf 'NS_READ_TOKEN=%s\n' "$TOK" >> .env
```

## 2. Where the values come from (uploader)

Nightscout gets values from a bridge of your choice (xDrip+, Dexcom Share, LibreLinkUp, AAPS/Loop ...).
For the **Medtronic MiniMed 780G** (Guardian 4 / Simplera Sync) through **CareLink**, a template is included:
the community fork [NovaLux12/carelink-bridge](https://github.com/NovaLux12/carelink-bridge) (commit pinned)
in its own container with a **guard** ([`nightscout/carelink/guard.sh`](nightscout/carelink/guard.sh)):

* If `carelink.env` still contains placeholders, or the login token is missing, the container **pauses** (sleeps).
  It **never** logs in by itself with the password and does not run into a restart loop.
  Background: Medtronic locks accounts after several failed attempts.
* The only login is a **one-time, manual** step:
  `docker compose run --rm -it carelink login` → on a CAPTCHA, an address is printed. Sign in in the browser, and
  copy the redirect address with `code=` (developer tools → network, filter `code=`) back into the terminal.
  After that, the bridge renews the token itself (`carelink-data/logindata.json`, 600).
* Then `docker compose up -d carelink`. Log: `docker logs -f nightscout-carelink`.

Unofficial (it simulates the CareLink app). Medtronic can change the interface at any time. Do not log in again
and again: every login of the official app on the same account can invalidate the token.

## 3. sugar-bridge

```bash
sudo mkdir -p /opt/sugar-bridge
sudo cp ~/quietglass-g2/apps/sugar-glass/examples/sugar-bridge.mjs /opt/sugar-bridge/
sudo install -m 600 .env.example /opt/sugar-bridge/.env   # NS_TOKEN = the readable token, SUGAR_TAILSCALE_USERS = your login
sudo cp sugar-bridge.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now sugar-bridge
tailscale serve status                                   # read first
tailscale serve --bg --https=8462 http://127.0.0.1:8466  # never "serve reset"
tailscale serve status
```

Self-test from another tailnet device (same login): `curl https://<your-machine>.<your-tailnet>.ts.net:8462/api/v1/status.json`
→ 200. Directly on `127.0.0.1:8466` without the header → 401 (intended). Also check: `ss -tlnp | grep 8463` shows only `127.0.0.1`.
