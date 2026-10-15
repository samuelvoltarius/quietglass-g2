# byd-bridge — BYD-Telemetrie für BYD Glass (nur Tailnet)

> Inoffiziell, ohne Verbindung zu BYD. Die Bridge spricht **nie selbst** mit dem Auto oder der BYD-Cloud:
> sie liest MQTT und reicht wenige, streng geprüfte Befehle an einen Steuerweg weiter, den du schon betreibst.
> Fernbefehle können verspätet, gar nicht oder doppelt ankommen. Prüfe das Ergebnis im Auto bzw. in der BYD-App.

```
 Auto (DiLink 3, Overdrive-App) ── MQTT overdrive/vehicle/telemetry/<feld> ──┐
                                                                             ▼
 BYD-Cloud ◄── pybyd-mqtt (cmd/heat|cool|climate_off …, klima_status) ◄── Mosquitto (127.0.0.1:1883)
                                                                             ▲
              Brille ◄─ iPhone ◄─ tailscale serve :8471 ◄─ byd-bridge (127.0.0.1:8472)
```

* **Daten:** die Overdrive-App am Auto meldet ~140 Werte, je Thema ein Wert (`soc`, `speed`, `power`,
  `tyre_p_fl` …), etwa alle 5 s, solange die Head-Unit wach ist. Die Bridge hält den letzten Stand im Speicher,
  wertet ihn aus (Modus, Warnungen) und liefert ihn kompakt an die Brille. **Standort und VIN** gibt sie nicht weiter.
* **Befehle:** nur `climate_on` (16–28 °C), `climate_off`, `lock`, `unlock` (aus, siehe unten). Sie gehen als
  MQTT-Befehl an die vorhandene **pybyd-mqtt**-Brücke (Cloud-Weg, geht auch im Schlaf) — die hat schon die
  Sperre gegen Befehlsstürme, die Poll-Pause gegen BYD-Fehler 6024 und die Rückmeldung `klima_status`.
* Freigegeben wird **nur die Bridge** per `tailscale serve`; Zugriff nur für Logins aus `BYD_TAILSCALE_USERS`.

| lokal | Tailscale-Port (Vorschlag) | App / Build |
|---|---|---|
| byd-bridge `127.0.0.1:8472` | `8471` | `VITE_BYD_URL=https://<server>.<tailnet>.ts.net:8471` |

## Schnittstelle

| Anfrage | Anmeldung | |
|---|---|---|
| `GET /health` | nein | `{ok, mqtt, age_s, rev}` — keine Fahrzeugdaten |
| `GET /state` | ja | aktueller Zustand (JSON, siehe unten) |
| `GET /state?since=<rev>&wait=25` | ja | Long-Poll: antwortet sofort bei neuer Revision, sonst nach ≤ 25 s mit dem gleichen Stand |
| `POST /command` | ja | Rumpf `{"action":"climate_on","value":21}` als **text/plain** (einfache Anfrage, kein Preflight) → `202 {ok, command}`; das Ergebnis kommt danach im Zustand unter `command` |
| `OPTIONS *` | – | `204` **ohne Body** (sonst verwirft iOS die Antwort) |

Anmeldung wie bei den anderen Brillen-Diensten: `tailscale serve` verbindet von Loopback und setzt
`Tailscale-User-Login`; dem Kopf wird **nur von Loopback** und **nur für Logins aus `BYD_TAILSCALE_USERS`** geglaubt.
Alternativ `Authorization: Bearer <BYD_TOKEN>` (für curl). Ohne beides ist alles gesperrt (401).

### Zustand (`/state`)

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

* `mode`: `driving` (Tempo > 3 km/h oder Gang D/R), sonst `charging` (`is_charging`), sonst `parked`.
* `stale`: letzte Overdrive-Meldung älter als `BYD_STALE_S` (Head-Unit schläft) — Werte sind dann „letzter Stand“.
* `power_kw` ist beim Laden und Rekuperieren **negativ**. Die Ladeleistung `charge.kw` kommt aus `-power`,
  **nicht** aus `charge_power` (das Feld ist am Dolphin Surf um Faktor 2,5–3,6 daneben).
* `body.locked`: Overdrive `locked` (1 = zu). Schläft das Auto (> 10 min keine Meldung), zählt der von der Cloud
  bestätigte Schlosszustand (`<BYD_CLOUD_TOPIC>/state`, `lock_confirmed=ON`) — `lock_src` sagt, woher.
* Warnungen (`code`, `level` = `crit|warn|info`): `tyre_leak` (Rad), `tyre_low` (Rad, < `BYD_TYRE_LOW_KPA`
  oder Reifen-Status ≠ 0), `door_open` (beim Fahren `crit`), `v12_low` (< `BYD_12V_LOW`, wie der keepawake-guard),
  `unlocked` (geparkt und seit ≥ `BYD_UNLOCKED_MIN` min offen), `soc_low`, `charge_done` (30 min nach Ladeende).
  „Schlüssel weg“ lässt sich aus den Overdrive-Feldern (`key_*`) nicht sicher ablesen, daher die Zeitregel.
* `command.status`: `sent` → `pending` (BYD arbeitet) → `ok` | `busy` (BYD gedrosselt, ~2 min warten) | `error` |
  `timeout` (90 s ohne Rückmeldung). `note: "mapped_heat|mapped_cool"`: ohne Erweiterung wurde 26 °/19 ° gesendet.

### Befehle und Sicherheit

| Befehl | Weg | Bedingung |
|---|---|---|
| `climate_on` `value` 16–28 | `cmd/climate_temp` (mit Erweiterung) sonst `cmd/heat` (≥ 22 → 26 °C) / `cmd/cool` (19 °C) | – |
| `climate_off` | `cmd/climate_off` | – |
| `lock` | `cmd/lock` (Erweiterung, `BYD_LOCK_TOPICS=1`) oder `BYD_ACTION_URL` | ein Weg muss eingerichtet sein |
| `unlock` | wie `lock` | `BYD_ALLOW_UNLOCK=1` **und** laut letzter Telemetrie geparkt (`is_parked=1`, Tempo 0, Gang nicht D/R/N) |

* Alles andere: 400/403. Ein Befehl gleichzeitig (409 `busy`), höchstens einer je 20 s (409 `too_fast`).
* Jeder Befehl — auch abgelehnte — landet als JSON-Zeile in `BYD_LOG` und im Journal
  (`time, id, action, value, status, text, who`). Keine Tokens, keine PIN.
* `BYD_CONTROL=0` macht die Bridge rein lesend.

## Erweiterung von pybyd-mqtt (optional: freie Temperatur, Zusperren)

Ohne Erweiterung kennt die pybyd-mqtt-Brücke nur zwei feste Sollwerte (Heizen 26 °C, Kühlen 19 °C) und kein
Schloss. Die folgenden Zeilen ergänzen sie, ohne das Bestehende zu ändern — gleicher Ablauf wie Heizen/Kühlen
(eigener Thread, Sperre, 45-s-Poll-Pause, ein sanfter Retry bei 1008/6024, Rückmeldung über `klima_status`).
**Vorher sichern** (`cp pybyd_mqtt.py pybyd_mqtt.py.bak-<datum>`), danach `systemctl --user restart pybyd-mqtt`
und im Log `MQTT connected, subscribed cmds` prüfen.

```python
# bei den anderen CMD_-Konstanten
CMD_CLIMATE_TEMP = "bydcloud/%s/cmd/climate_temp" % NODE   # Payload: Grad C, 16..28
CMD_LOCK         = "bydcloud/%s/cmd/lock" % NODE
# CMD_UNLOCK     = "bydcloud/%s/cmd/unlock" % NODE         # NUR mit Broker-ACL, siehe unten

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

In `on_connect` die neuen Themen mit abonnieren:

```python
    for t in (CMD_HEAT, CMD_COOL, CMD_CLIMATE_OFF, CMD_CLIMATE, CMD_BATTERY, CMD_FINDCAR,
              CMD_CLIMATE_TEMP, CMD_LOCK):
        client.subscribe(t)
```

In `on_msg` die Sperre auf die neuen Themen ausdehnen und den Modus nur für Klima setzen:

```python
    if t in (CMD_HEAT, CMD_COOL, CMD_CLIMATE_OFF, CMD_CLIMATE_TEMP, CMD_LOCK):
        # … blocked-Prüfung wie bisher …
        _GATE["running"] = True
        if t != CMD_LOCK:
            if t == CMD_CLIMATE_TEMP:
                _mode = "heat" if _temp(msg) >= 22 else "cool"
            else:
                _mode = {CMD_HEAT: "heat", CMD_COOL: "cool", CMD_CLIMATE_OFF: "off"}[t]
            # … _MODE / KLIMA_MODE wie bisher …
    # … bestehende elif-Zweige …
    elif t == CMD_CLIMATE_TEMP:
        tt = _temp(msg)
        _spawn(lambda: _do_climate(temp=tt), "🌡️ Klima %d°" % tt, status=True)
    elif t == CMD_LOCK:
        _spawn(lambda: _do_lock(True), "🔒 Zusperren", status=True)
```

Dann in der `.env` der Bridge `BYD_CLIMATE_TEMP_TOPIC=1` und `BYD_LOCK_TOPICS=1`.

**Entriegeln über MQTT nur mit Broker-ACL:** Mosquitto nimmt anonyme Verbindungen an (auch aus LAN/Tailnet,
weil Overdrive von außen meldet). Ein `cmd/unlock`-Thema wäre damit für jedes Gerät im Netz offen. Erst wenn der
Broker Benutzer + ACL hat (`cmd/#` nur für pybyd-mqtt und die Bridge), `CMD_UNLOCK` analog zu `CMD_LOCK` ergänzen
(`_do_lock(False)`) und `BYD_ALLOW_UNLOCK=1` setzen. Das gilt sinngemäß für jeden HTTP-Dienst ohne Anmeldung, der
`/action unlock` kann — ihn **nicht** als `BYD_ACTION_URL` eintragen, solange er im LAN offen lauscht.

## Einrichten (systemd --user, neben Broker und pybyd-mqtt)

```bash
python3 -c "import paho.mqtt.client"            # paho 1.x oder 2.x muss da sein
mkdir -p ~/byd-bridge
cp byd_bridge.py ~/byd-bridge/
python3 ~/byd-bridge/byd_bridge.py --selftest    # muss "alles gruen" melden
install -m 600 .env.example ~/byd-bridge/.env    # BYD_TAILSCALE_USERS = dein Login
cp byd-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now byd-bridge
systemctl --user is-active byd-bridge
curl -s http://127.0.0.1:8472/health                                            # {"ok":true,"mqtt":true,…}
curl -s -H 'Tailscale-User-Login: <dein login>' http://127.0.0.1:8472/state | head -c 300
tailscale serve --bg --https=8471 http://127.0.0.1:8472   # nie "serve reset"/"off"
tailscale serve status                                    # 8471 -> 127.0.0.1:8472 zurücklesen
```

Prüfen ohne Auto: `GET /state?since=<rev>&wait=5` muss ~5 s warten und dann antworten; `curl -i -X OPTIONS …`
muss `204` mit `Content-Length: 0` zeigen; ein `POST /command` mit `{"action":"honk"}` muss 400 liefern.
Schlaf: Ohne Overdrive-Meldungen bleibt der letzte Stand stehen, `stale` wird `true`, `age_s` zählt hoch.

## Lizenz

MIT

## Signierter Befehlskanal (seit 13.10.2026)

Der Mosquitto-Broker ist anonym. Deshalb laufen **Zusperren, Aufsperren und Klima mit Temperatur** nur über
`bydcloud/<node>/cmd/signed`, mit einer HMAC-SHA256-Unterschrift über `action|value|ts|nonce`. Die Nachricht ist
höchstens 30 s gültig, und jeder Einmalwert wird nur einmal angenommen.

* Geheimnis: eine Datei, z. B. `~/byd-copilot/.cmd_secret` (`chmod 600`, 32 Zufallsbytes hex). Die Brücke findet sie
  über `BYD_CMD_SECRET_FILE`. Das Geheimnis nie in Git, Logs oder die App.
* pybyd-mqtt: [`pybyd_signed.py`](pybyd_signed.py) neben `pybyd_mqtt.py` legen. Dort an drei Stellen einhängen:
  `import pybyd_signed`, in `on_connect` `client.subscribe(pybyd_signed.TOPIC % NODE)`, ganz oben in `on_msg`
  `if pybyd_signed.handle(msg, NODE, _spawn_cmd): return`. `_spawn_cmd` führt `lock`/`unlock`/`climate_temp` aus.
* **Sicherheitsregel:** Cloud-Befehle nur, wenn das Auto **aus** ist (Overdrive `power_level` 0; 2 = an). Am
  13.10.2026 hat „Klima aus“ per Cloud das laufende Auto abgeschaltet, während der Fahrer drinsaß. Die Brücke lehnt
  sonst mit `car_on` ab. Aufsperren zusätzlich nur in P bei 0 km/h.

**Auch im pybyd-mqtt-Dienst selbst (13.10.2026):** Er abonniert `overdrive/vehicle/telemetry/power_level` (Overdrive
speichert den Wert dauerhaft auf dem Broker) und lehnt `heat`/`cool`/`climate_off`/`climate`/`battery_heat` sowie
alle signierten Befehle ab, solange das Auto an ist (Wert ≠ 0, jünger als 15 min). Das gilt damit auch für Cockpit
und Home Assistant. Rückmeldung auf `klima_status`: „⛔ Auto ist an – bitte im Auto bedienen“.
