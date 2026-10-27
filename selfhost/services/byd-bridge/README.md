# byd-bridge — BYD telemetry for BYD Glass (tailnet only)

> Unofficial, with no connection to BYD. The bridge **never talks to the car or the BYD cloud itself**.
> It reads MQTT and serves a compact, evaluated state to the glasses. **Vehicle commands are off by default**;
> with `BYD_CONTROL=1` it passes on lock, unlock and preheat behind always-on guards
> (see [Commands](#commands-off-by-default-lock-unlock-preheat-with-byd_control1)).

```
 Car (Panoptes app) ── MQTT surfmate/vehicle/telemetry/<field> ──┐
                                                                 ▼
                                                 Mosquitto (127.0.0.1:1883)
                                                                 │  read (+ signed cmd/signed, brille/unlock only with BYD_CONTROL=1)
              Glasses ◄─ iPhone ◄─ tailscale serve :8471 ◄─ byd-bridge (127.0.0.1:8472)
```

* **Data:** the **Panoptes** app in the car (successor of Overdrive, meant for many BYD models) publishes one value per
  topic under `surfmate/vehicle/telemetry/<field>` (`soc`, `speed`, `power`, `tyre_p_fl` …) while the head unit is
  awake. The bridge keeps the latest state in memory, evaluates it (mode, warnings) and delivers it compactly to the
  glasses. It does **not** pass on the location or the VIN. Sub-topics such as `guard/state` or `health/state` are
  ignored. The old Overdrive scheme still works with `BYD_TOPIC=overdrive/vehicle/telemetry`.
* **Missing values:** Panoptes runs on many BYD models; a field a model does not report (or reports as a placeholder
  such as `65535`, `1048575`, `-10011`, `NULL`) stays `null` in `/state`. It never becomes `0` and never raises a
  warning; the app leaves it out.
* **No cabin temperature:** the Dolphin Surf has no cabin temperature sensor. `climate_setpoint` (17–33, 25 = neutral)
  is the climate **setpoint**, passed on as `body.setpoint` and clearly not a reading. BYD Glass does not show it.
* Only **the bridge** is published with `tailscale serve`. Access is only for logins in `BYD_TAILSCALE_USERS`.

| Local | Tailscale port (suggestion) | App / build |
|---|---|---|
| byd-bridge `127.0.0.1:8472` | `8471` | `VITE_BYD_URL=https://<your-machine>.<your-tailnet>.ts.net:8471` |

## Field mapping (Panoptes)

Sampled read-only from a Dolphin Surf on 2026-10-23. "Overdrive" is the old field name where it differs.

| `/state` | Panoptes field(s) | Overdrive | Note |
|---|---|---|---|
| `mode` | `speed`, `gear`, `is_parked`, `is_charging` | same | driving / charging / parked |
| `drive.speed`, `drive.gear` | `speed`, `gear` | same | |
| `drive.limit_warn` | `speed_limit_warning` | same | only while driving |
| `drive.power_kw` | `power` | same | negative while charging / recuperating |
| `drive.cons50`, `trip_km`, `trip_kwh` | `consumption_50km`, `trip_km`, `trip_kwh` | same | |
| `drive.turn_left/right`, `hazard`, `high_beam` | `light_left_turn`, `light_right_turn`, `light_hazard`, `light_high_beam` | same | `-10011` = no value |
| `battery.soc`, `range_km` | `soc`, `ev_range_km` | same | BYD cloud as fallback while the car is silent |
| `battery.soh`, `cell_t_min/max`, `volt_12v` | `soh`, `cell_t_min`, `cell_t_max`, `volt_12v` | same | `batt_12v_level` is `65535` (unused) |
| `battery.odometer_km` | `odometer` | – (cloud only) | **new**; cloud fallback |
| `charge.kw` | `-power` (fallback `charge_power`) | same | `charge_power` is off by 2.5–3.6× on the Surf |
| `charge.dc`, `eta_min`, `kwh` | `is_dcfc`, `charging_eta_hours/minutes`, `charging_capacity_kwh` | same | |
| `body.locked` | `unlocked_lf` (1 = unlocked → `false`) | `locked` | `locked` wins when present; cloud lock when asleep |
| `body.door_open` | any of `door_open_lf/rf/lr/rr` | `door_open` | |
| `body.trunk_open`, `hood_open` | `trunk_open`, `hood_open` | – | **new**, with warnings |
| `body.ac_on` | `ac_on` (fallback `climate_on`) | `ac_on` | |
| `body.ac_fan` | `ac_fan` (fallback `ac_wind`) | – | **new**, fan level |
| `body.setpoint` | `climate_setpoint` | same | setpoint, **not** a temperature reading |
| `body.ext_temp` | `ext_temp` | same | outside sensor |
| `tyres.<w>.kpa`, `leak`, `low` | `tyre_p_<w>`, `tyre_leak_<w>`, `tyre_p_state_<w>` | same | |
| `tyres.<w>.temp` | `tyre_t_<w>` | – | **new**, °C |
| `online` | `availability` | same | |
| `control.car_off` (command safety) | `power_level` (0 off, 2 on) | same | only from `surfmate/vehicle/telemetry/power_level`, live, ≤ 180 s |

No longer in Panoptes: `locked`, `door_open` (replaced as above). There is no `inside_temp` field, and none is
derived. Not used yet, but present and possibly useful later: `plugged`, `charging_state`, `charger_state`,
`charging_gun`, `charging_type`, `charging_capacity_source`, `hv_pack_v`, `cell_v_min/max/delta`, `cell_t_avg`,
`soh_oem`, `window_open_*`, `ignition`, `op_mode`, `climate_setpoint_passenger`, `pm25_inside/outside`,
`consumption_avg`, `consumption_last_trip`, `total_elec_con`, `light_low_beam`, `light_drl`, `light_*_fog`,
`tyre_system_state`, `tyre_temp_state`, `tyre_signal_*`. Never read: `location`, `lat`, `lon`, `heading`,
`elevation`, `vin`.

## Interface

| Request | Sign-in | |
|---|---|---|
| `GET /health` | no | `{ok, mqtt, age_s, rev}`. No vehicle data |
| `GET /state` | yes | Current state (JSON, see below) |
| `GET /state?since=<rev>&wait=25` | yes | Long poll: answers immediately on a new revision, otherwise after ≤ 25 s with the same state |
| `POST /command` | yes (with `BYD_CONTROL=1`) | **Default: `403 {"ok":false,"error":"control_disabled"}`** for every request, before sign-in and without evaluating the body. Nothing is published to the broker. With `BYD_CONTROL=1`: arm + confirm, see below |
| `OPTIONS *` | – | `204` **with no body** (otherwise iOS drops the answer) |

Sign-in works as with the other glasses services: `tailscale serve` connects from loopback and sets
`Tailscale-User-Login`. The header is trusted **only from loopback** and **only for logins in `BYD_TAILSCALE_USERS`**.
Alternatively, use `Authorization: Bearer <BYD_TOKEN>` (for curl). With neither, everything is blocked (401).

### State (`/state`)

```json
{
  "v": 1, "rev": 42, "at": 1791912309502, "mode": "charging", "online": true, "stale": false, "age_s": 0,
  "drive":   { "speed": 0, "limit_warn": false, "gear": "P", "power_kw": -38, "cons50": 16.7,
               "trip_km": 0, "trip_kwh": 0, "turn_left": false, "turn_right": false, "hazard": false, "high_beam": false },
  "battery": { "soc": 52, "range_km": 161, "soh": 100, "cell_t_min": 21, "cell_t_max": 23, "volt_12v": 13.8,
               "odometer_km": 28015, "src": "car", "cloud_age_min": null },
  "charge":  { "active": true, "dc": true, "kw": 38, "eta_min": 49, "kwh": 9.1, "done": false },
  "body":    { "locked": false, "lock_src": "car", "door_open": false, "trunk_open": false, "hood_open": false,
               "ext_temp": 17, "ac_on": true, "ac_fan": 2, "setpoint": 25, "klima_mode": null },
  "tyres":   { "fl": { "kpa": 252, "leak": false, "low": false, "temp": 20 }, "fr": {}, "rl": {}, "rr": {} },
  "warnings": [ { "code": "tyre_low", "wheel": "rr", "kpa": 180, "level": "warn" } ],
  "command": null, "car_on": false,
  "control": { "enabled": false, "lock": false, "unlock": false, "preheat": false,
               "preheat_minutes": [10, 15, 20, 25, 30], "car_off": false, "arm_s": 8 }
}
```

* `mode`: `driving` (speed > 3 km/h or gear D/R), otherwise `charging` (`is_charging`), otherwise `parked`.
* `stale`: the last Panoptes message is older than `BYD_STALE_S` (the head unit is asleep). The values are then
  the "last known state".
* `power_kw` is **negative** while charging and recuperating. The charging power `charge.kw` comes from `-power`,
  **not** from `charge_power` (that field is off by a factor of 2.5–3.6 on the Dolphin Surf).
* `body.locked`: see the mapping. If the car sleeps (no message for > 10 min), the lock state confirmed by the cloud
  counts (`<BYD_CLOUD_TOPIC>/state`, `lock_confirmed=ON`). `lock_src` tells you which one.
* Warnings (`code`, `level` = `crit|warn|info`): `tyre_leak` (wheel), `tyre_low` (wheel, < `BYD_TYRE_LOW_KPA`
  or tyre status ≠ 0), `door_open`, `trunk_open`, `hood_open` (`crit` while driving), `v12_low` (< `BYD_12V_LOW`),
  `unlocked` (parked and unlocked for at least `BYD_UNLOCKED_MIN` min), `soc_low`, `charge_done` (30 min after
  charging ended). A field that is missing raises no warning.

### Commands (off by default; lock, unlock, preheat with `BYD_CONTROL=1`)

**Decision (Alfred, 2026-10-23, Panoptes coordination rules):** the glasses may send exactly three commands -
**lock**, **unlock** and **preheat for 10–30 min**. There is **no climate off** from the glasses (the session ends
by itself) and no temperature choice. All guards live **in this bridge**, are **always on** and cannot be switched
off by an environment variable. Everything fails closed.

* `BYD_CONTROL` defaults to `0`: `POST /command` then always answers `403 control_disabled` (before sign-in,
  without evaluating the body), logs the refusal and publishes nothing. `/state` reports `control.enabled: false`
  and BYD Glass hides its control page. Any value other than `1` keeps it off.
* `BYD_CONTROL=1` enables **lock**. **Unlock** additionally needs `BYD_ALLOW_UNLOCK=1`, **preheat**
  `BYD_PREHEAT=1`. Both of these also need the [proposed pybyd-mqtt / befehl_gate change](proposed/README.md)
  deployed (jointly with the Panoptes session); until then leave them at `0`.

**Two steps** (the glasses arm on the first tap and confirm with a second tap within 4 s):

```text
POST /command  {"action":"lock","step":"arm"}                → 200 {"ok":true,"armed":"<one-time>","ttl_s":8}
POST /command  {"action":"lock","confirm":"<one-time>"}      → 202 {"ok":true,"command":{"id":…,"status":"sent"}}
               {"action":"preheat","minutes":20,"step":"arm"} / {"action":"preheat","minutes":20,"confirm":…}
```

The arm step runs every check and sends nothing. The confirm step checks the one-time value (bound to action and
duration, single use, valid `ARM_TTL_S` = 8 s: the glasses' 4 s plus the way over phone and Tailscale) and then
runs **every check again**. A request without `step`/`confirm` is never sent.

| Guard (always on) | Refusal `error` | Text shown on the glasses |
|---|---|---|
| **Fresh `power_level` 0** from `surfmate/vehicle/telemetry/power_level`, received live (retained values never count), at most 180 s old. Missing, stale, retained or ≠ 0 → refused. Reason: on 2026-10-13 a cloud command switched a running car off | `car_on` (403) | „Auto ist an – am Display bedienen" / "Car is on – use the car's screen" |
| No climate off (`climate_off`, `climate`) | `not_allowed` (403) | „Klima aus nur im Auto" |
| Preheat only 10, 15, 20, 25 or 30 min | `bad_value` (400) | |
| Unlock: `BYD_ALLOW_UNLOCK=1`, not driving, Telegram configured | `unlock_disabled`, `not_parked`, `no_notifier` | |
| Every unlock sends a **Telegram message before** the command; if it fails, the unlock is refused | `notify_failed` (503) | |
| One command at a time (until confirmed / not confirmed) | `busy` (409) | |
| ≥ 15 s between two sent commands, ≤ 6 per hour - **persisted** in `BYD_RATE_FILE`, survives restarts; unreadable file = blocked | `too_fast`, `rate_limit` (409), `rate_store` | |
| Signed channel needs `BYD_CMD_SECRET_FILE`; preheat needs `BYD_PREHEAT=1` | `not_available` (501) | |

Refusals answer `{"ok":false,"error":<code>,"message":{"de":…,"en":…}}`; BYD Glass shows `message`.

**Command path** (the least risky one there is; the bridge never talks to the car or the cloud itself):

| Command | Topic | Payload | Live pybyd-mqtt today |
|---|---|---|---|
| lock | `<BYD_CLOUD_TOPIC>/cmd/signed` | HMAC-SHA256 `lock\|\|ts\|nonce` | works (`befehl_gate.check("lock")`, fresh power 0) |
| preheat | `<BYD_CLOUD_TOPIC>/cmd/signed` | `preheat\|<minutes>\|ts\|nonce` | needs the proposal |
| unlock | `<BYD_CLOUD_TOPIC>/brille/unlock` | `unlock\|byd-glass\|ts\|nonce` (own source of the glasses) | needs the proposal (`NEVER = {"unlock"}` for every other source) |

No unsigned topic (`cmd/lock`, `cmd/heat`, `cmd/climate_off`) and no `BYD_ACTION_URL` any more: the broker is
anonymous, anybody on the network could publish there. `BYD_LOCK_TOPICS`, `BYD_CLIMATE_TEMP_TOPIC` and
`BYD_ACTION_URL` are gone (ignored).

**Result** in `/state` → `command` (`id, action, value, status, text, at, done_at, cloud`):

* `sent` - published. pybyd-mqtt's „✅ … gesendet" only sets `cloud: "accepted"`; it is **not** a success.
* `confirmed` - a telemetry value received **live after the command** shows the target: lock `locked = 1` or
  `unlocked_lf = 0`, unlock the opposite, preheat `ac_on = 1` (or `climate_on = 1`). Retained values never count.
* `not_confirmed` - no such value within `CONFIRM_TIMEOUT_S` = 120 s.
* `error` - pybyd-mqtt reported `⛔` (its gate refused), `⚠` (error) or „beschäftigt" (busy), or the publish failed.
  Never turns into `confirmed` afterwards.

**Log:** every arm, refusal, send and result is one JSON line in `BYD_LOG` and the journal
(`time, step, kind, value, result, reason, id, who`). Never the one-time value, the secret, the signature, a PIN or
a token.

`/state` → `control`: `{"enabled", "lock", "unlock", "preheat", "preheat_minutes", "car_off", "arm_s"}`
(`car_off` = a fresh `power_level` 0 right now; only for display - every command checks again).

## Set-up (systemd --user, next to the broker)

```bash
python3 -c "import paho.mqtt.client"            # paho 1.x or 2.x must be present
mkdir -p ~/byd-bridge
cp byd_bridge.py test_byd_bridge.py ~/byd-bridge/
python3 ~/byd-bridge/byd_bridge.py --selftest    # must report "alles gruen" ("all green")
python3 ~/byd-bridge/test_byd_bridge.py          # topic mapping + every command guard (fakes only)
install -m 600 .env.example ~/byd-bridge/.env    # BYD_TAILSCALE_USERS = your login; BYD_CONTROL see "Commands"
cp byd-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now byd-bridge
systemctl --user is-active byd-bridge
journalctl --user -u byd-bridge -n 5                                            # "Steuerung: aus", "Thema surfmate/vehicle/telemetry/#"
curl -s http://127.0.0.1:8472/health                                            # {"ok":true,"mqtt":true,…}
curl -s -H 'Tailscale-User-Login: <your-login>' http://127.0.0.1:8472/state | head -c 300
tailscale serve --bg --https=8471 http://127.0.0.1:8472   # never "serve reset"/"off"
tailscale serve status                                    # read back 8471 -> 127.0.0.1:8472
```

Minimal `.env` on a new host (the rest are defaults):

```bash
BYD_TAILSCALE_USERS=<your tailscale login>
BYD_MQTT_HOST=<broker address, 127.0.0.1 if the broker runs on the same host>
BYD_MQTT_PORT=1883
BYD_TOPIC=surfmate/vehicle/telemetry
BYD_CLOUD_TOPIC=bydcloud/bydsurf      # only if pybyd-mqtt publishes there (cloud fallback); harmless otherwise
BYD_CONTROL=0                         # commands off (1 = lock/unlock/preheat with the guards, see above)
```

Checks without the car: `GET /state?since=<rev>&wait=5` must wait ~5 s and then answer. `curl -i -X OPTIONS …`
must show `204` with `Content-Length: 0`. With `BYD_CONTROL=0`, **any** `POST /command` must return
`403 control_disabled`. With `BYD_CONTROL=1` and the car on, `{"action":"lock","step":"arm"}` must return
`403 car_on` (read the reason back in `commands.jsonl`).
Sleep: without Panoptes messages, the last state stays, `stale` becomes `true`, and `age_s` counts up.

## License

MIT

## Signed command channel (since 2026-10-13)

The Mosquitto broker is anonymous. So every command goes through pybyd-mqtt's signed channel, with an HMAC-SHA256
signature over `action|value|ts|nonce`. A message is valid for at most 30 s, and each one-time value is accepted
only once.

* Secret: one file, for example `~/byd-copilot/.cmd_secret` (`chmod 600`, 32 random bytes as hex). The bridge finds it
  through `BYD_CMD_SECRET_FILE`. Never put the secret in Git, logs or the app.
* pybyd-mqtt: [`pybyd_signed.py`](pybyd_signed.py) is the version that runs today (lock, climate_temp; unlock refused
  by `befehl_gate`). The proposed version with `preheat` and the glasses' own unlock topic is in
  [`proposed/`](proposed/README.md) - deploy only together with the Panoptes session.
* **pybyd-mqtt checks again** (`befehl_gate.py`): fresh live `power_level` 0 from `surfmate/` or `panoptes/`
  (≤ 180 s, retained never counts) for every cloud command, also from Home Assistant and the cockpit. Feedback on
  `klima_status`: „⛔ Auto ist an – bitte im Auto bedienen" - the bridge turns every `⛔`/`⚠` into `error`.
