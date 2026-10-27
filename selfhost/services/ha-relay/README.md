# ha-relay — Home Assistant relay for the private TV Glance build (tailnet only)

A small service that lets the owner's **private** build of [TV Glance](../../../apps/tv-glance/README.md) reach
Home Assistant **without a token on the phone and without picking devices**. The long-lived Home Assistant token
stays in a file on the server; the phone is let in by its Tailscale login.

```
 Glasses ◄─ Even app (phone) ──wss──► tailscale serve :8483 ──► ha_relay.py (127.0.0.1:8484) ──ws──► Home Assistant
            VITE_HA_RELAY build        adds Tailscale-User-Login     real token from HA_TOKEN_FILE
```

| Local | Tailscale port (suggestion) | App build |
|---|---|---|
| `ha_relay.py` `127.0.0.1:8484` | `8483` | `VITE_HA_RELAY=https://<your-machine>.<your-tailnet>.ts.net:8483` |

The public/store build of TV Glance does not use this: there the user types the address and a token.

## What it does

- **`/api/websocket`** — looks like Home Assistant: `auth_required` → the client sends `auth` with *any* (also empty)
  token → the relay logs in to Home Assistant with the real token and answers `auth_ok` (with Home Assistant's
  `ha_version`). Then JSON messages are relayed both ways, unchanged, except for the rules below. The `Origin`
  header is ignored (the Even app's WebView has no fixed origin), like Home Assistant itself.
- **`GET /config`** — `{"devices":[{"entityId","remoteId","name"}, ...]}` from `RELAY_DEVICES`. The app stores them
  on first start. Sends `Access-Control-Allow-Origin: *` (plain GET, no preflight needed).
- **`GET /health`** — `{"ok": true}`, no login, no data.
- **Access** — `Tailscale-User-Login` must be in `RELAY_TAILSCALE_USERS`, trusted only when the connection comes from
  loopback (i.e. from `tailscale serve`). Otherwise `403`. With the list empty, everything is refused.

### Rules (what gets through)

| Client message | Rule |
|---|---|
| `subscribe_entities`, `unsubscribe_events`, `get_states`, `ping`, `supported_features` | allowed |
| `call_service` | only `media_player` and `remote`; explicit `entity_id`s of that domain; if `RELAY_ENTITIES` is set, only those (list the `remote.*` ones too). No `area_id` / `device_id` / `floor_id` / `label_id` targets |
| anything else (`render_template`, `fire_event`, `get_config`, `subscribe_events`, ...) | refused |
| messages without an integer `id`, or not JSON objects | refused (`invalid_format`) |

A refused message gets `{"id":…,"type":"result","success":false,"error":{"code":"not_allowed","message":"…"}}`
and nothing reaches Home Assistant. Answers are filtered the other way, too: `get_states` results and
`subscribe_entities` events contain `media_player.*` and `remote.*` only; a `subscribe_entities` request is cut down to
those domains and is refused if nothing is left (an empty list would mean "everything" to Home Assistant).

The token is read from `HA_TOKEN_FILE` for every new session (rotate it without a restart), never logged, never sent
to the client. Only logins, connects/disconnects and upstream errors are logged — no message contents.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `HA_URL` | – (required) | Home Assistant base, e.g. `http://192.0.2.10:8123` |
| `HA_TOKEN_FILE` | `~/.ha_token` | file with the long-lived access token (chmod 600) |
| `RELAY_HOST` / `RELAY_PORT` | `127.0.0.1` / `8484` | bind address / port |
| `RELAY_TAILSCALE_USERS` | – | comma list of allowed Tailscale logins |
| `RELAY_ENTITIES` | empty = all `media_player.*`/`remote.*` | comma list of entities `call_service` may target |
| `RELAY_DEVICES` | – | `media_player.x\|remote.x\|Name;media_player.y\|\|Other` for `/config` |

Template: [`ha-relay.env.example`](ha-relay.env.example) (placeholders only).

## Set-up

Needs Python 3.9+ and `aiohttp` 3.x (nothing else).

```bash
mkdir -p ~/ha-relay && cp ha_relay.py ~/ha-relay/
install -m 600 ha-relay.env.example ~/ha-relay/.env     # fill in HA_URL, RELAY_TAILSCALE_USERS, RELAY_ENTITIES, RELAY_DEVICES
install -m 600 /dev/null ~/.ha_token                    # then put the Home Assistant long-lived token in it (editor, not shell history)
mkdir -p ~/.config/systemd/user && cp ha-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ha-relay
loginctl enable-linger "$USER"                          # keep the user service running without a login
tailscale serve status                                  # read first, do not touch other entries
tailscale serve --bg --https=8483 http://127.0.0.1:8484 # never "serve reset"
tailscale serve status
```

Checks:

```bash
curl -s http://127.0.0.1:8484/health                                  # {"ok": true}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8484/config  # 403 (no login header, intended)
curl -s https://<your-machine>.<your-tailnet>.ts.net:8483/config      # from a tailnet device with an allowed login: the devices
ss -tlnp | grep 8484                                                  # 127.0.0.1 only
journalctl --user -u ha-relay -n 20
```

Build the private app: `VITE_HA_RELAY=https://<your-machine>.<your-tailnet>.ts.net:8483 npm run build` in
`apps/tv-glance` (see its README), with the private manifest whose network whitelist allows that address.

## Tests

```bash
python3 -m unittest test_ha_relay        # or: python3 -m pytest test_ha_relay.py
```

A fake Home Assistant (aiohttp test server) on 127.0.0.1 and a made-up token: handshake, relaying, refused types /
domains / entities, login check (`403`), `get_states` and event filtering, `/config`, `/health`.
