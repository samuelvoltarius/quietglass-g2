# byd-bridge — BYD telemetry for BYD Glass (tailnet only)

> Unofficial, with no connection to BYD. The bridge **never talks to the car or the BYD cloud itself**.
> It reads MQTT and passes a few strictly checked commands to a control path that you already run.
> Remote commands can arrive late, not at all, or twice. Check the result in the car or in the BYD app.

```
 Car (DiLink 3, Overdrive app) ── MQTT overdrive/vehicle/telemetry/<field> ──┐
                                                                             ▼
 BYD cloud ◄── pybyd-mqtt (cmd/heat|cool|climate_off …, klima_status) ◄── Mosquitto (127.0.0.1:1883)
                                                                             ▲
              Glasses ◄─ iPhone ◄─ tailscale serve :8471 ◄─ byd-bridge (127.0.0.1:8472)
```

* **Data:** the Overdrive app on the car reports ~140 values, one value per topic (`soc`, `speed`, `power`,
  `tyre_p_fl` ...), about every 5 s while the head unit is awake. The bridge keeps the latest state in memory,
  analyzes it (mode, warnings) and delivers it compactly to the glasses. It does **not** pass on the location or the VIN.
* **Commands:** only `climate_on` (16–28 °C), `climate_off`, `lock`, `unlock` (off by default, see below). They go
  as an MQTT command to the existing **pybyd-mqtt** bridge (cloud path, also works while the car sleeps). That bridge
  already has the lock against command storms, the poll pause against BYD error 6024 and the feedback `klima_status`.
* Only **the bridge** is published with `tailscale serve`. Access is only for logins in `BYD_TAILSCALE_USERS`.

| Local | Tailscale port (suggestion) | App / build |
|---|---|---|
| byd-bridge `127.0.0.1:8472` | `8471` | `VITE_BYD_URL=https://<your-machine>.<your-tailnet>.ts.net:8471` |

## Interface

| Request | Sign-in | |
|---|---|---|
| `GET /health` | no | `{ok, mqtt, age_s, rev}`. No vehicle data |
| `GET /state` | yes | Current state (JSON, see below) |
| `GET /state?since=<rev>&wait=25` | yes | Long poll: answers immediately on a new revision, otherwise after ≤ 25 s with the same state |
| `POST /command` | yes | Body `{"action":"climate_on","value":21}` as **text/plain** (a simple request, no preflight) → `202 {ok, command}`; the result then appears in the state under `command` |
| `OPTIONS *` | – | `204` **with no body** (otherwise iOS drops the answer) |

Sign-in works as with the other glasses services: `tailscale serve` connects from loopback and sets
`Tailscale-User-Login`. The header is trusted **only from loopback** and **only for logins in `BYD_TAILSCALE_USERS`**.
Alternatively, use `Authorization: Bearer <BYD_TOKEN>` (for curl). With neither, everything is blocked (401).

### State (`/state`)

```json
{
  "v": 1, "rev": 42, "at": 1791912309502, "mode": "charging", "online": true, "stale": false, "age_s": 0,
  "drive":   { "speed": 0, "limit_warn": false, "gear": "P", "power_kw": -37, "cons50": 15.8,
               "trip_km": 0, "trip_kwh": 0, "turn_left": false, "turn_right": false, "hazard": false, "high_beam": false },
  "battery": { "soc": 63, "range_km": 187, "soh": 100, "cell_t_min": 26, "cell_t_max": 28, "volt_12v": 13.8 },
  "charge":  { "active": true, "dc": true, "kw": 37, "eta_min": 42, "kwh": 13.7, "done": false },
  "body":    { "locked": false, "lock_src": "car", "door_open": false, "ext_temp": 15, "ac_on": true,
               "setpoint": 27, "klima_mode": "on" },
  "tyres":   { "fl": { "kpa": 252, "leak": false, "low": false }, "fr": {}, "rl": {}, "rr": {} },
  "warnings": [ { "code": "tyre_low", "wheel": "rr", "kpa": 180, "level": "warn" } ],
  "command": { "id": "c1791…", "action": "climate_on", "value": 21, "status": "ok", "text": "✅ …", "at": 1791… },
  "control": { "enabled": true, "lock": false, "unlock": false, "climate_temp": false }
}
```

* `mode`: `driving` (speed > 3 km/h or gear D/R), otherwise `charging` (`is_charging`), otherwise `parked`.
* `stale`: the last Overdrive message is older than `BYD_STALE_S` (the head unit is asleep). The values are then
  the "last known state".
* `power_kw` is **negative** while charging and recuperating. The charging power `charge.kw` comes from `-power`,
  **not** from `charge_power` (that field is off by a factor of 2.5–3.6 on the Dolphin Surf).
* `body.locked`: Overdrive `locked` (1 = locked). If the car sleeps (no message for > 10 min), the lock state
  confirmed by the cloud counts (`<BYD_CLOUD_TOPIC>/state`, `lock_confirmed=ON`). `lock_src` tells you which one.
* Warnings (`code`, `level` = `crit|warn|info`): `tyre_leak` (wheel), `tyre_low` (wheel, < `BYD_TYRE_LOW_KPA`
  or tyre status ≠ 0), `door_open` (`crit` while driving), `v12_low` (< `BYD_12V_LOW`, like the keepawake guard),
  `unlocked` (parked and unlocked for at least `BYD_UNLOCKED_MIN` min), `soc_low`, `charge_done` (30 min after
  charging ended). "Key gone" cannot be read reliably from the Overdrive fields (`key_*`), hence the time rule.
* `command.status`: `sent` → `pending` (BYD is working) → `ok` | `busy` (BYD throttled, wait ~2 min) | `error` |
  `timeout` (90 s without feedback). `note: "mapped_heat|mapped_cool"`: without the extension, 26 °/19 ° was sent.

### Commands and safety

| Command | Path | Condition |
|---|---|---|
| `climate_on` `value` 16–28 | `cmd/climate_temp` (with the extension), otherwise `cmd/heat` (≥ 22 → 26 °C) / `cmd/cool` (19 °C) | – |
| `climate_off` | `cmd/climate_off` | – |
| `lock` | `cmd/lock` (extension, `BYD_LOCK_TOPICS=1`) or `BYD_ACTION_URL` | one path must be set up |
| `unlock` | like `lock` | `BYD_ALLOW_UNLOCK=1` **and** parked according to the latest telemetry (`is_parked=1`, speed 0, gear not D/R/N) |

* Everything else: 400/403. One command at a time (409 `busy`), at most one per 20 s (409 `too_fast`).
* Every command, including rejected ones, ends up as a JSON line in `BYD_LOG` and in the journal
  (`time, id, action, value, status, text, who`). No tokens, no PIN.
* `BYD_CONTROL=0` makes the bridge read-only.

## Extension of pybyd-mqtt (optional: free temperature, locking)

Without the extension, the pybyd-mqtt bridge only knows two fixed setpoints (heating 26 °C, cooling 19 °C) and no
lock. The following lines add them without changing what exists. The flow is the same as for heating/cooling
(own thread, lock, 45 s poll pause, one gentle retry on 1008/6024, feedback through `klima_status`).
**Back up first** (`cp pybyd_mqtt.py pybyd_mqtt.py.bak-<date>`), then run `systemctl --user restart pybyd-mqtt`
and check the log for `MQTT connected, subscribed cmds`.

```python
# next to the other CMD_ constants
CMD_CLIMATE_TEMP = "bydcloud/%s/cmd/climate_temp" % NODE   # Payload: degrees C, 16..28
CMD_LOCK         = "bydcloud/%s/cmd/lock" % NODE
# CMD_UNLOCK     = "bydcloud/%s/cmd/unlock" % NODE         # ONLY with a broker ACL, see below

def _temp(msg):
    try:
        return max(16, min(28, int(round(float(msg.payload.decode().strip())))))
    except Exception:
        return 21

async def _do_lock(lock=True):
    async with BydClient(BydConfig(**CFG)) as c:
        await c.login()
        last = None
        for i in range(2):
            try:
                await c.verify_command_access(VIN, command_pwd=CFG["control_pin"])
                if lock:
                    await c.lock(VIN, command_pwd=CFG["control_pin"])
                else:
                    await c.unlock(VIN, command_pwd=CFG["control_pin"])
                return
            except Exception as e:
                last = e
                if _busy(e) and i < 1:
                    await asyncio.sleep(8); continue
                raise
        raise last
```

In `on_connect`, subscribe to the new topics as well:

```python
    for t in (CMD_HEAT, CMD_COOL, CMD_CLIMATE_OFF, CMD_CLIMATE, CMD_BATTERY, CMD_FINDCAR,
              CMD_CLIMATE_TEMP, CMD_LOCK):
        client.subscribe(t)
```

In `on_msg`, extend the lock to the new topics and set the mode only for climate:

```python
    if t in (CMD_HEAT, CMD_COOL, CMD_CLIMATE_OFF, CMD_CLIMATE_TEMP, CMD_LOCK):
        # … blocked check as before …
        _GATE["running"] = True
        if t != CMD_LOCK:
            if t == CMD_CLIMATE_TEMP:
                _mode = "heat" if _temp(msg) >= 22 else "cool"
            else:
                _mode = {CMD_HEAT: "heat", CMD_COOL: "cool", CMD_CLIMATE_OFF: "off"}[t]
            # … _MODE / KLIMA_MODE as before …
    # … existing elif branches …
    elif t == CMD_CLIMATE_TEMP:
        tt = _temp(msg)
        _spawn(lambda: _do_climate(temp=tt), "🌡️ Klima %d°" % tt, status=True)
    elif t == CMD_LOCK:
        _spawn(lambda: _do_lock(True), "🔒 Zusperren", status=True)
```

Then set `BYD_CLIMATE_TEMP_TOPIC=1` and `BYD_LOCK_TOPICS=1` in the bridge's `.env`.

**Unlocking over MQTT only with a broker ACL:** Mosquitto accepts anonymous connections (also from the LAN/tailnet,
because Overdrive reports from outside). A `cmd/unlock` topic would therefore be open to every device on the
network. Only when the broker has users + an ACL (`cmd/#` only for pybyd-mqtt and the bridge), add `CMD_UNLOCK`
like `CMD_LOCK` (`_do_lock(False)`) and set `BYD_ALLOW_UNLOCK=1`. The same applies to any HTTP service without
sign-in that can do `/action unlock`. Do **not** enter it as `BYD_ACTION_URL` while it listens openly on the LAN.

## Set-up (systemd --user, next to the broker and pybyd-mqtt)

```bash
python3 -c "import paho.mqtt.client"            # paho 1.x or 2.x must be present
mkdir -p ~/byd-bridge
cp byd_bridge.py ~/byd-bridge/
python3 ~/byd-bridge/byd_bridge.py --selftest    # must report "alles gruen" ("all green")
install -m 600 .env.example ~/byd-bridge/.env    # BYD_TAILSCALE_USERS = your login
cp byd-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now byd-bridge
systemctl --user is-active byd-bridge
curl -s http://127.0.0.1:8472/health                                            # {"ok":true,"mqtt":true,…}
curl -s -H 'Tailscale-User-Login: <your-login>' http://127.0.0.1:8472/state | head -c 300
tailscale serve --bg --https=8471 http://127.0.0.1:8472   # never "serve reset"/"off"
tailscale serve status                                    # read back 8471 -> 127.0.0.1:8472
```

Checks without the car: `GET /state?since=<rev>&wait=5` must wait ~5 s and then answer. `curl -i -X OPTIONS …`
must show `204` with `Content-Length: 0`. A `POST /command` with `{"action":"honk"}` must return 400.
Sleep: without Overdrive messages, the last state stays, `stale` becomes `true`, and `age_s` counts up.

## License

MIT

## Signed command channel (since 2026-10-13)

The Mosquitto broker is anonymous. So **locking, unlocking and climate with a temperature** only run through
`bydcloud/<node>/cmd/signed`, with an HMAC-SHA256 signature over `action|value|ts|nonce`. The message is valid for
at most 30 s, and each one-time value is accepted only once.

* Secret: one file, for example `~/byd-copilot/.cmd_secret` (`chmod 600`, 32 random bytes as hex). The bridge finds it
  through `BYD_CMD_SECRET_FILE`. Never put the secret in Git, logs or the app.
* pybyd-mqtt: put [`pybyd_signed.py`](pybyd_signed.py) next to `pybyd_mqtt.py`. Hook it in at three places:
  `import pybyd_signed`, in `on_connect` `client.subscribe(pybyd_signed.TOPIC % NODE)`, and at the very top of `on_msg`
  `if pybyd_signed.handle(msg, NODE, _spawn_cmd): return`. `_spawn_cmd` runs `lock`/`unlock`/`climate_temp`.
* **Safety rule:** cloud commands only when the car is **off** (Overdrive `power_level` 0; 2 = on). On
  2026-10-13, "climate off" through the cloud switched off the running car while the driver was sitting in it.
  Otherwise the bridge rejects with `car_on`. Unlocking additionally only in P at 0 km/h.

**Also in the pybyd-mqtt service itself (2026-10-13):** It subscribes to `overdrive/vehicle/telemetry/power_level`
(Overdrive stores the value permanently on the broker) and rejects `heat`/`cool`/`climate_off`/`climate`/`battery_heat`
and all signed commands while the car is on (value ≠ 0, younger than 15 min). So this also applies to the cockpit
and Home Assistant. Feedback on `klima_status`: "⛔ Auto ist an – bitte im Auto bedienen" (the car is on; please
operate it in the car).
