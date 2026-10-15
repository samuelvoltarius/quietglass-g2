#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
byd-bridge - BYD-Telemetrie fuer BYD Glass (Even G2), plus wenige, streng
gepruefte Fernbefehle.

Liest die Fahrzeugdaten, die die Overdrive-App am Auto ueber MQTT meldet
(`overdrive/vehicle/telemetry/<feld>`, ein Wert je Thema), haelt den letzten
Stand im Speicher und liefert ihn kompakt und schon ausgewertet an die Brille:

    GET  /state                      Zustand (JSON), mit Anmeldung
    GET  /state?since=<rev>&wait=25  Long-Poll: antwortet sofort, wenn sich
                                     etwas geaendert hat, sonst nach <= 25 s
    POST /command                    {"action": ..., "value": ...} als
                                     text/plain (einfache Anfrage, kein
                                     Preflight), mit Anmeldung
    GET  /health                     Lebenszeichen, ohne Anmeldung, ohne Daten

Befehle (Allowlist, alles andere wird abgelehnt):
    climate_on  value = 16..28 (Grad C)
    climate_off
    lock
    unlock      nur wenn BYD_ALLOW_UNLOCK=1 UND das Auto laut letzter
                Telemetrie steht (is_parked=1, Tempo 0, kein Fahrgang)

Die Bridge spricht NIE selbst mit dem Auto oder der BYD-Cloud. Befehle gehen
an den vorhandenen Steuerweg:
  * pybyd-mqtt (Cloud-Bruecke): Themen `<BYD_CLOUD_TOPIC>/cmd/heat|cool|
    climate_off` (und, wenn die Erweiterung aus der README eingespielt ist,
    `cmd/climate_temp`, `cmd/lock`, `cmd/unlock`). Rueckmeldung kommt ueber
    `<BYD_CLOUD_TOPIC>/klima_status`.
  * optional fuer Verriegeln/Entriegeln: ein lokaler HTTP-Dienst mit
    `POST /action {"name": ..., "arg": ...}` (BYD_ACTION_URL).

Anmeldung wie bei den anderen Brillen-Diensten: `tailscale serve` verbindet von
Loopback und setzt `Tailscale-User-Login`; vertraut wird dem Kopf NUR von
Loopback und NUR fuer Logins aus BYD_TAILSCALE_USERS. Alternativ
`Authorization: Bearer <BYD_TOKEN>` (z. B. fuer curl). Ohne beides ist alles
gesperrt. CORS: OPTIONS antwortet mit 204 OHNE Body.

Abhaengigkeiten: Python 3.8+, paho-mqtt (1.x oder 2.x).
Selbsttest ohne Broker:  python3 byd_bridge.py --selftest
"""

import hashlib
import hmac
import json
import math
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# Einstellungen (Umgebung)
# ---------------------------------------------------------------------------

def _env(name, default=""):
    return os.environ.get(name, default).strip()


def _envf(name, default):
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return float(default)


HOST = _env("BYD_HOST", "127.0.0.1")
PORT = int(_envf("BYD_PORT", 8472))
NUTZER = {x.strip().lower() for x in _env("BYD_TAILSCALE_USERS").split(",") if x.strip()}
TOKEN = _env("BYD_TOKEN")
MQTT_HOST = _env("BYD_MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(_envf("BYD_MQTT_PORT", 1883))
TELE = _env("BYD_TOPIC", "overdrive/vehicle/telemetry").rstrip("/")
CLOUD = _env("BYD_CLOUD_TOPIC", "bydcloud/bydsurf").rstrip("/")
CONTROL = _env("BYD_CONTROL", "1") == "1"
ALLOW_UNLOCK = _env("BYD_ALLOW_UNLOCK", "0") == "1"
TEMP_TOPIC = _env("BYD_CLIMATE_TEMP_TOPIC", "0") == "1"
LOCK_TOPICS = _env("BYD_LOCK_TOPICS", "0") == "1"
ACTION_URL = _env("BYD_ACTION_URL").rstrip("/")
# Signierter Befehlskanal zu pybyd-mqtt (cmd/signed): der Broker ist anonym, darum
# tragen Sperren und Klima-mit-Temperatur eine HMAC-Unterschrift mit Zeitstempel und
# Einmalwert. Geheimnis nur in einer Datei (chmod 600), nie in Git oder Log.
SECRET_FILE = os.path.expanduser(_env("BYD_CMD_SECRET_FILE", ""))


def _secret():
    try:
        with open(SECRET_FILE, "rb") as f:
            return f.read().strip()
    except OSError:
        return b""


def signed_payload(action, value, secret, now=None, nonce=None):
    """JSON fuer cmd/signed: sig = HMAC-SHA256(secret, "action|value|ts|nonce")."""
    ts = int(now if now is not None else time.time())
    nonce = nonce or os.urandom(8).hex()
    val = "" if value is None else str(value)
    msg = ("%s|%s|%d|%s" % (action, val, ts, nonce)).encode("utf-8")
    sig = hmac.new(secret, msg, hashlib.sha256).hexdigest()
    return json.dumps({"action": action, "value": val, "ts": ts, "nonce": nonce, "sig": sig})
LOG_FILE = os.path.expanduser(_env("BYD_LOG", "~/byd-bridge/commands.jsonl"))
TYRE_LOW_KPA = _envf("BYD_TYRE_LOW_KPA", 210)
V12_LOW = _envf("BYD_12V_LOW", 12.2)
SOC_LOW = _envf("BYD_SOC_LOW", 15)
STALE_S = _envf("BYD_STALE_S", 120)
UNLOCKED_MIN = _envf("BYD_UNLOCKED_MIN", 10)
COMMAND_TIMEOUT_S = 90
COMMAND_GAP_S = 20
LOOPBACK = ("127.0.0.1", "::1", "::ffff:127.0.0.1")
WHEELS = ("fl", "fr", "rl", "rr")

# Overdrive meldet "kein Wert" mit Platzhaltern statt leer.
SENTINELS = {65535.0, 1048575.0, -10011.0, 104857.5}

# ---------------------------------------------------------------------------
# Werte lesen
# ---------------------------------------------------------------------------

def parse_value(raw):
    """Ein MQTT-Wert als Zahl, Text oder None (Platzhalter, NULL, leer)."""
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            return None
    s = str(raw).strip()
    if s == "" or s.upper() in ("NULL", "NONE", "NAN", "UNKNOWN", "UNAVAILABLE"):
        return None
    try:
        v = float(s)
    except ValueError:
        return s
    if v in SENTINELS or v != v:
        return None
    return v


def num(t, key):
    v = t.get(key)
    return v if isinstance(v, float) else None


def flag(t, key):
    """1 -> True, 0 -> False, sonst None."""
    v = num(t, key)
    if v is None:
        return None
    return v >= 1


def r1(v):
    return None if v is None else round(v, 1)


# ---------------------------------------------------------------------------
# Auswertung (rein, testbar)
# ---------------------------------------------------------------------------

def mode_of(t):
    """driving | charging | parked."""
    speed = num(t, "speed") or 0.0
    gear = str(t.get("gear") or "").upper()
    if speed > 3 or gear in ("D", "R") or (flag(t, "is_parked") is False and gear not in ("P", "")):
        return "driving"
    if flag(t, "is_charging"):
        return "charging"
    return "parked"


def lock_state(t, cloud, now):
    """(locked, quelle). Overdrive meldet locked=1 verriegelt / 0 offen.
    Schlaeft das Auto (Overdrive-Stand alt), zaehlt die Cloud, wenn sie den
    Schlosszustand frisch bestaetigt hat."""
    car = flag(t, "locked")
    age = t.get("_age", 1e9)
    if car is not None and age is not None and age < 600:
        return car, "car"
    if cloud.get("lock_confirmed") == "ON" and cloud.get("locked") in ("ON", "OFF"):
        return cloud.get("locked") == "ON", "cloud"
    return car, ("car" if car is not None else None)


def cnum(cloud, key):
    """Zahl aus dem Cloud-Zustand (pybyd-mqtt) oder None."""
    v = cloud.get(key)
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def derive(t, now, memo=None, cloud=None):
    """Telemetrie (Feld -> Wert, plus `_age` Sekunden seit der letzten Meldung,
    `_online` aus availability) -> kompakter Zustand fuer die Brille.
    `memo` merkt sich Uebergaenge (seit wann offen, Ladeende) zwischen Aufrufen."""
    memo = memo if memo is not None else {}
    cloud = cloud or {}
    mode = mode_of(t)
    age = t.get("_age")
    stale = age is None or age > STALE_S

    power = num(t, "power")
    charging = mode == "charging"
    charge_kw = None
    if charging:
        # `charge_power` ist am Dolphin Surf unbrauchbar (Faktor 2,5-3,6 daneben);
        # die Motorleistung ist beim Laden negativ und stimmt.
        if power is not None and power < 0:
            charge_kw = -power
        else:
            charge_kw = num(t, "charge_power")
    eta = None
    if num(t, "charging_eta_minutes") is not None:
        eta = int((num(t, "charging_eta_hours") or 0) * 60 + num(t, "charging_eta_minutes"))
    soc = num(t, "soc")
    range_km = num(t, "ev_range_km")
    battery_src = "car"
    cloud_age = None if cloud.get("_at") is None else max(0, now - cloud["_at"])
    if stale or soc is None:
        csoc, crange = cnum(cloud, "soc"), cnum(cloud, "range_km")
        if csoc is not None:
            soc, battery_src = csoc, "cloud"
            range_km = crange if crange is not None else range_km
    position = None
    clat, clon = cnum(cloud, "latitude"), cnum(cloud, "longitude")
    if clat is not None and clon is not None:
        position = {"lat": round(clat, 5), "lon": round(clon, 5), "src": "cloud",
                    "age_min": None if cloud_age is None else int(cloud_age // 60)}

    # Ladeende: war am Laden, jetzt nicht mehr.
    if charging:
        memo["was_charging"] = True
        memo.pop("charge_done_at", None)
    elif memo.get("was_charging"):
        memo["was_charging"] = False
        memo["charge_done_at"] = now
    done_at = memo.get("charge_done_at")
    charge_done = bool(done_at and now - done_at < 1800 and mode != "driving")

    locked, lock_src = lock_state(t, cloud, now)
    door_open = flag(t, "door_open")
    if locked is False and mode != "driving":
        memo.setdefault("unlocked_since", now)
    else:
        memo.pop("unlocked_since", None)

    tyres = {}
    for w in WHEELS:
        kpa = num(t, "tyre_p_" + w)
        leak = bool(flag(t, "tyre_leak_" + w))
        state = num(t, "tyre_p_state_" + w)
        low = (kpa is not None and kpa < TYRE_LOW_KPA) or (state is not None and state > 0)
        tyres[w] = {"kpa": None if kpa is None else int(round(kpa)), "leak": leak, "low": bool(low)}

    warnings = []
    for w in WHEELS:
        if tyres[w]["leak"]:
            warnings.append({"code": "tyre_leak", "wheel": w, "kpa": tyres[w]["kpa"], "level": "crit"})
        elif tyres[w]["low"]:
            warnings.append({"code": "tyre_low", "wheel": w, "kpa": tyres[w]["kpa"], "level": "warn"})
    if door_open:
        warnings.append({"code": "door_open", "level": "crit" if mode == "driving" else "warn"})
    v12 = num(t, "volt_12v")
    if v12 is not None and 5 < v12 < V12_LOW:
        warnings.append({"code": "v12_low", "volt": r1(v12), "level": "warn"})
    since = memo.get("unlocked_since")
    if locked is False and since is not None and mode == "parked" and not door_open:
        minutes = int((now - since) // 60)
        if minutes >= UNLOCKED_MIN:
            warnings.append({"code": "unlocked", "minutes": minutes, "level": "warn"})
    if soc is not None and soc < SOC_LOW and mode != "charging":
        warnings.append({"code": "soc_low", "soc": int(soc), "level": "warn"})
    if charge_done:
        warnings.append({"code": "charge_done", "soc": None if soc is None else int(soc), "level": "info"})

    def light(key):
        return bool(flag(t, key))

    return {
        "v": 1,
        "mode": mode,
        "online": t.get("_online") == "online",
        "stale": stale,
        "age_s": None if age is None else int(age),
        "drive": {
            "speed": r1(num(t, "speed")),
            "limit_warn": bool(flag(t, "speed_limit_warning")) and mode == "driving",
            "gear": (str(t.get("gear")) if t.get("gear") is not None else None),
            "power_kw": r1(power),
            "cons50": r1(num(t, "consumption_50km")),
            "trip_km": r1(num(t, "trip_km")),
            "trip_kwh": r1(num(t, "trip_kwh")),
            "turn_left": light("light_left_turn"),
            "turn_right": light("light_right_turn"),
            "hazard": light("light_hazard"),
            "high_beam": light("light_high_beam"),
        },
        "battery": {
            "soc": None if soc is None else int(round(soc)),
            "range_km": None if range_km is None else int(range_km),
            "src": battery_src,
            "cloud_age_min": None if cloud_age is None else int(cloud_age // 60),
            "odometer_km": None if cnum(cloud, "odometer") is None else int(cnum(cloud, "odometer")),
            "soh": r1(num(t, "soh")),
            "cell_t_min": r1(num(t, "cell_t_min")),
            "cell_t_max": r1(num(t, "cell_t_max")),
            "volt_12v": r1(v12),
        },
        "charge": {
            "active": charging,
            "dc": bool(flag(t, "is_dcfc")) if charging else False,
            "kw": r1(charge_kw),
            "eta_min": eta if charging else None,
            "kwh": r1(num(t, "charging_capacity_kwh")) if charging else None,
            "done": charge_done,
        },
        "body": {
            "locked": locked,
            "lock_src": lock_src,
            "door_open": door_open,
            "ext_temp": r1(num(t, "ext_temp")),
            "ac_on": flag(t, "ac_on"),
            "setpoint": r1(num(t, "climate_setpoint")),
            "klima_mode": cloud.get("klima_mode"),
        },
        "position": position,
        "tyres": tyres,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Befehle (rein pruefbar)
# ---------------------------------------------------------------------------

ACTIONS = ("climate_on", "climate_off", "lock", "unlock")


def check_command(body, state, now, last_sent=0.0, pending=False):
    """-> (ok, action, value, grund). Prueft Form, Allowlist und Sicherheit."""
    if not isinstance(body, dict):
        return False, None, None, "bad_request"
    action = body.get("action")
    if action not in ACTIONS:
        return False, None, None, "unknown_action"
    if not CONTROL:
        return False, action, None, "control_disabled"
    # 13.10.2026: "Klima aus" ueber die BYD-Cloud hat das EINGESCHALTETE Auto mit
    # Alfred darin abgeschaltet (die Cloud beendet die ganze Fernsitzung). Cloud-
    # Befehle deshalb NUR, wenn das Auto aus ist: power_level 0 = aus, 2 = an
    # (gemessen 13.10. am Dolphin Surf). Unbekannt oder alt = ablehnen.
    if (state or {}).get("_car_off") is not True:
        return False, action, None, "car_on"
    value = None
    if action == "climate_on":
        raw = body.get("value", 21)
        try:
            value = int(round(float(raw)))
        except (TypeError, ValueError):
            return False, action, None, "bad_value"
        if not 16 <= value <= 28:
            return False, action, value, "bad_value"
    if action in ("lock", "unlock") and not (LOCK_TOPICS or ACTION_URL):
        return False, action, None, "not_available"
    if action == "unlock":
        if not ALLOW_UNLOCK:
            return False, action, None, "unlock_disabled"
        drive = (state or {}).get("drive") or {}
        speed = drive.get("speed")
        gear = str(drive.get("gear") or "").upper()
        parked = (state or {}).get("_is_parked")
        if state is None or state.get("mode") != "parked" or parked is not True \
                or speed is None or speed != 0 or gear in ("D", "R", "N"):
            return False, action, None, "not_parked"
    if pending:
        return False, action, value, "busy"
    if now - last_sent < COMMAND_GAP_S:
        return False, action, value, "too_fast"
    return True, action, value, None


def status_from_feedback(text):
    """Rueckmeldung von pybyd-mqtt (klima_status) -> pending|ok|busy|error."""
    s = (text or "").strip()
    if s.startswith("✅"):
        return "ok"
    if s.startswith("⚠"):
        return "error"
    if "besch" in s.lower() or s.startswith("⏳ Warte"):
        return "busy"
    return "pending"


# ---------------------------------------------------------------------------
# Laufzeit: Speicher, MQTT, Long-Poll
# ---------------------------------------------------------------------------

class Store:
    def __init__(self):
        self.lock = threading.Condition()
        self.tele = {}
        self.tele_at = None
        self.cloud = {}
        self.memo = {}
        self.rev = 0
        self.state = None
        self.body_key = ""
        self.dirty = True
        self.mqtt_ok = False
        self.command = None
        self.last_sent = 0.0

    # MQTT-Thread
    def on_tele(self, field, raw, retained=False):
        with self.lock:
            if field == "availability":
                self.tele["_online"] = parse_value(raw)
            elif field not in ("location", "lat", "lon", "vin", "elevation", "heading"):
                # Standort und VIN braucht die Brille nicht: bleiben draussen.
                self.tele[field] = parse_value(raw)
                # Ein beim (Neu-)Verbinden ausgelieferter gespeicherter Wert ist alt,
                # nicht frisch: sonst galten nach jedem Bridge-Neustart die letzten
                # Overdrive-Werte (z. B. 100 %) zwei Minuten lang als aktuell (15.10.).
                if not retained:
                    self.tele_at = time.time()
            self.dirty = True

    def on_cloud(self, sub, raw):
        with self.lock:
            text = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
            if sub == "state":
                try:
                    d = json.loads(text)
                    for k in ("locked", "lock_confirmed"):
                        self.cloud[k] = d.get(k)
                    # Ersatz, wenn das Auto selbst (Overdrive) nichts Frisches meldet:
                    # Akku, Reichweite, Kilometerstand und Standort aus der BYD-Cloud
                    # (pybyd-mqtt, dieselben Werte, die Home Assistant zeigt).
                    for k in ("soc", "range_km", "odometer", "latitude", "longitude"):
                        if d.get(k) is not None:
                            self.cloud[k] = d.get(k)
                    self.cloud["_at"] = time.time()
                except ValueError:
                    pass
            elif sub == "klima_mode":
                self.cloud["klima_mode"] = text.strip() or None
            elif sub == "klima_status":
                self._feedback(text)
            self.dirty = True

    def _feedback(self, text):
        c = self.command
        if not c or c["status"] not in ("sent", "pending") or c.get("via") != "mqtt":
            return
        if time.time() < c["_sent"]:
            return
        c["status"] = status_from_feedback(text)
        c["text"] = text.strip()[:120]
        if c["status"] != "pending":
            log_command(c)

    # Ticker
    def refresh(self, force=False):
        with self.lock:
            now = time.time()
            c = self.command
            if c and c["status"] in ("sent", "pending") and now - c["_sent"] > COMMAND_TIMEOUT_S:
                c["status"] = "timeout"
                log_command(c)
                self.dirty = True
            t = dict(self.tele)
            t["_age"] = None if self.tele_at is None else now - self.tele_at
            st = derive(t, now, self.memo, self.cloud)
            st["_is_parked"] = flag(t, "is_parked")
            level = num(t, "power_level")
            # 0 = aus gilt auch, wenn das schlafende Auto nichts mehr sendet (Vorheizen von zu Hause);
            # "an" nur, solange frisch (laufendes Auto sendet laufend). Unbekannt = ablehnen.
            age = t["_age"]
            if level == 0:
                st["_car_off"] = True
            elif level is not None and age is not None and age <= 900:
                st["_car_off"] = False
            else:
                st["_car_off"] = None
            st["car_on"] = st["_car_off"] is False
            st["command"] = public_command(self.command)
            st["control"] = {
                "enabled": CONTROL,
                "unlock": CONTROL and ALLOW_UNLOCK and (LOCK_TOPICS or bool(ACTION_URL)),
                "lock": CONTROL and (LOCK_TOPICS or bool(ACTION_URL)),
                "climate_temp": TEMP_TOPIC,
            }
            key = json.dumps({k: v for k, v in st.items() if k != "age_s"}, sort_keys=True)
            # age_s zaehlt mit, loest aber nur jede Minute eine neue Revision aus.
            minute = None if st["age_s"] is None else st["age_s"] // 60
            key += "|%s" % minute
            if key != self.body_key or force:
                self.body_key = key
                self.rev += 1
                self.lock.notify_all()
            st["rev"] = self.rev
            st["at"] = int(now * 1000)
            self.state = st
            self.dirty = False

    def snapshot(self, since=None, wait=0.0):
        deadline = time.time() + max(0.0, min(wait, 25.0))
        with self.lock:
            while since is not None and self.state is not None and self.state["rev"] == since:
                left = deadline - time.time()
                if left <= 0:
                    break
                self.lock.wait(left)
            st = dict(self.state or {})
        st.pop("_is_parked", None)
        st.pop("_car_off", None)
        return st


STORE = Store()


def public_command(c):
    if not c:
        return None
    return {k: v for k, v in c.items() if not k.startswith("_") and k != "via"}


def log_command(c, extra=None):
    row = {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), **public_command(c)}
    if extra:
        row.update(extra)
    line = json.dumps(row, ensure_ascii=False)
    sys.stderr.write("CMD %s\n" % line)
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError as exc:
        sys.stderr.write("Befehlslog nicht schreibbar: %s\n" % exc)


MQTT = {"client": None}


def mqtt_start():
    import paho.mqtt.client as mqtt  # noqa: WPS433 (nur zur Laufzeit noetig)

    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="byd-glass-bridge")
    except AttributeError:  # paho 1.x
        client = mqtt.Client(client_id="byd-glass-bridge")

    def on_connect(c, *_args):
        # paho 2.x: subscribe erst nach CONNACK, sonst verpufft es.
        c.subscribe(TELE + "/#")
        for sub in ("state", "klima_mode", "klima_status"):
            c.subscribe(CLOUD + "/" + sub)
        STORE.mqtt_ok = True
        sys.stderr.write("MQTT verbunden %s:%d\n" % (MQTT_HOST, MQTT_PORT))

    def on_disconnect(*_args):
        STORE.mqtt_ok = False

    def on_message(_c, _u, msg):
        topic = msg.topic
        if topic.startswith(TELE + "/"):
            field = topic[len(TELE) + 1:]
            if "/" in field:  # .../set u. a. - nie mitlesen
                return
            STORE.on_tele(field, msg.payload, bool(getattr(msg, "retain", False)))
        elif topic.startswith(CLOUD + "/"):
            STORE.on_cloud(topic[len(CLOUD) + 1:], msg.payload)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(2, 60)
    client.connect_async(MQTT_HOST, MQTT_PORT, 60)
    client.loop_start()
    MQTT["client"] = client


def send_command(action, value, who):
    """Gibt den Befehl an den vorhandenen Steuerweg weiter. -> Befehlsobjekt."""
    now = time.time()
    cid = "c%d" % int(now * 1000)
    c = {"id": cid, "action": action, "value": value, "status": "sent", "text": "",
         "at": int(now * 1000), "_sent": now, "via": "mqtt", "_who": who}
    note = None
    if action in ("lock", "unlock") and not LOCK_TOPICS:
        c["via"] = "http"
    if c["via"] == "mqtt":
        secret = _secret()
        if action in ("lock", "unlock") or (action == "climate_on" and TEMP_TOPIC):
            if not secret:
                topic, payload = None, None
            else:
                topic = CLOUD + "/cmd/signed"
                payload = signed_payload("climate_temp" if action == "climate_on" else action, value, secret)
        elif action == "climate_on":
            if TEMP_TOPIC:
                topic, payload = CLOUD + "/cmd/climate_temp", str(value)
            else:
                # Ohne Erweiterung kennt pybyd-mqtt nur zwei feste Sollwerte.
                heat = value >= 22
                topic, payload = CLOUD + ("/cmd/heat" if heat else "/cmd/cool"), "PRESS"
                note = "mapped_heat" if heat else "mapped_cool"
        elif action == "climate_off":
            topic, payload = CLOUD + "/cmd/climate_off", "PRESS"
        else:
            topic, payload = CLOUD + "/cmd/" + action, "PRESS"
        client = MQTT["client"]
        if topic is None:
            c["status"] = "error"
            c["text"] = "no_secret"
        elif client is None or not STORE.mqtt_ok:
            c["status"] = "error"
            c["text"] = "mqtt_offline"
        else:
            info = client.publish(topic, payload, qos=1)
            if getattr(info, "rc", 0) != 0:
                c["status"] = "error"
                c["text"] = "mqtt_publish_failed"
        if note:
            c["note"] = note
    else:
        threading.Thread(target=_http_action, args=(c,), daemon=True).start()
    with STORE.lock:
        STORE.command = c
        STORE.last_sent = now
        STORE.dirty = True
    log_command(c, {"who": who})
    STORE.refresh()
    return c


def _http_action(c):
    """Verriegeln/Entriegeln ueber einen lokalen Dienst mit POST /action."""
    body = json.dumps({"name": c["action"], "arg": None}).encode("utf-8")
    req = urllib.request.Request(ACTION_URL + "/action", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=75) as resp:
            text = str(json.loads(resp.read().decode("utf-8")).get("result", ""))
        ok = text and not text.lower().startswith(("aktion nicht", "unbekannte"))
        status, text = ("ok" if ok else "error"), text[:120]
    except Exception as exc:  # noqa: BLE001 - jede Stoerung ist ein Fehler fuer die Brille
        status, text = "error", type(exc).__name__
    with STORE.lock:
        if STORE.command is c:
            c["status"], c["text"] = status, text
            STORE.dirty = True
    log_command(c)
    STORE.refresh()


def ticker():
    while True:
        try:
            STORE.refresh()
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write("refresh: %r\n" % exc)
        time.sleep(0.5)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def anmeldung(adresse, kopf):
    """-> (erlaubt, form, wer) ; form nur fuer das Log, nie der Wert selbst."""
    auth = kopf.get("Authorization") or ""
    if TOKEN and auth.startswith("Bearer "):
        wert = auth[7:].strip()
        ok = hmac.compare_digest(wert.encode(), TOKEN.encode())
        return ok, "token len%d fp=%s" % (len(wert), hashlib.sha256(wert.encode()).hexdigest()[:8]), "token"
    login = (kopf.get("Tailscale-User-Login") or "").strip().lower()
    if login:
        if adresse not in LOOPBACK:
            return False, "tailscale-not-loopback", None
        return (login in NUTZER), "tailscale", login
    return False, "none", None


class Handler(BaseHTTPRequestHandler):
    server_version = "BYDGlassBridge/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        origin = self.headers.get("Origin")
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Vary", "Origin")

    def _antwort(self, code, daten, form="-", t0=None):
        body = json.dumps(daten, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        ms = (time.time() - t0) * 1000 if t0 else 0
        pfad = urllib.parse.urlparse(self.path).path
        if pfad != "/state" or code != 200:
            sys.stderr.write("%s %s %d %.0fms auth=%s\n" % (self.command, pfad, code, ms, form))

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        t0 = time.time()
        u = urllib.parse.urlparse(self.path)
        if u.path in ("/health", "/health/"):
            age = None if STORE.tele_at is None else int(time.time() - STORE.tele_at)
            return self._antwort(200, {"ok": True, "mqtt": STORE.mqtt_ok, "age_s": age, "rev": STORE.rev}, "-", t0)
        if u.path not in ("/state", "/state/"):
            return self._antwort(404, {"error": "not_found"}, "-", t0)
        erlaubt, form, _wer = anmeldung(self.client_address[0], self.headers)
        if not erlaubt:
            return self._antwort(401, {"error": "unauthorized"}, form, t0)
        q = urllib.parse.parse_qs(u.query)
        try:
            since = int(q["since"][0]) if "since" in q else None
            wait = float(q.get("wait", ["0"])[0])
        except ValueError:
            return self._antwort(400, {"error": "bad_query"}, form, t0)
        return self._antwort(200, STORE.snapshot(since, wait), form, t0)

    def do_POST(self):
        t0 = time.time()
        u = urllib.parse.urlparse(self.path)
        if u.path not in ("/command", "/command/"):
            return self._antwort(404, {"error": "not_found"}, "-", t0)
        erlaubt, form, wer = anmeldung(self.client_address[0], self.headers)
        if not erlaubt:
            return self._antwort(401, {"error": "unauthorized"}, form, t0)
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length <= 0 or length > 2048:
            return self._antwort(400, {"error": "bad_request"}, form, t0)
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._antwort(400, {"error": "bad_request"}, form, t0)
        STORE.refresh()
        with STORE.lock:
            state = dict(STORE.state or {})
            c = STORE.command
            pending = bool(c and c["status"] in ("sent", "pending"))
            last = STORE.last_sent
        ok, action, value, grund = check_command(body, state, time.time(), last, pending)
        if not ok:
            log_command({"id": "-", "action": action, "value": value, "status": "rejected", "text": grund, "at": int(time.time() * 1000)},
                        {"who": wer})
            code = 409 if grund in ("busy", "too_fast") else (501 if grund == "not_available" else 403 if grund in ("control_disabled", "unlock_disabled", "not_parked", "car_on") else 400)
            return self._antwort(code, {"ok": False, "error": grund}, form, t0)
        c = send_command(action, value, wer)
        return self._antwort(202, {"ok": c["status"] != "error", "command": public_command(c)}, form, t0)


# ---------------------------------------------------------------------------
# Selbsttest
# ---------------------------------------------------------------------------

def _sample(**over):
    base = {
        "speed": "0.0", "gear": "P", "is_parked": "1", "is_charging": "0", "is_dcfc": "0",
        "power": "0.0", "soc": "64.0", "ev_range_km": "190", "consumption_50km": "15.8",
        "locked": "1", "door_open": "0", "volt_12v": "12.6", "soh": "97.0",
        "cell_t_min": "18.0", "cell_t_max": "20.0", "ext_temp": "12.0", "ac_on": "0",
        "climate_setpoint": "21", "speed_limit_warning": "0",
        "light_left_turn": "-10011", "light_right_turn": "-10011", "light_high_beam": "0",
        "charging_eta_hours": "0", "charging_eta_minutes": "0", "charging_capacity_kwh": "0",
        "charge_power": "0.0",
    }
    for w in WHEELS:
        base["tyre_p_" + w] = "250"
        base["tyre_leak_" + w] = "0"
        base["tyre_p_state_" + w] = "0"
    base.update({k: str(v) for k, v in over.items()})
    t = {k: parse_value(v) for k, v in base.items()}
    t["_age"] = 3.0
    t["_online"] = "online"
    return t


def selftest():
    fails = []

    def expect(name, cond):
        if not cond:
            fails.append(name)
        print(("ok    " if cond else "FAIL  ") + name)

    now = 1_000_000.0
    expect("parse NULL", parse_value(b"NULL") is None)
    expect("parse sentinel", parse_value("-10011") is None and parse_value("65535") is None)
    expect("parse gear", parse_value("P") == "P")

    st = derive(_sample(), now, {})
    expect("parked mode", st["mode"] == "parked")
    expect("parked no warnings", st["warnings"] == [])
    expect("parked locked", st["body"]["locked"] is True)
    expect("no turn signal on sentinel", st["drive"]["turn_left"] is False)

    st = derive(_sample(speed=87.5, gear="D", is_parked=0, power=23.4, light_left_turn=1, speed_limit_warning=1), now, {})
    expect("driving mode", st["mode"] == "driving")
    expect("driving speed", st["drive"]["speed"] == 87.5)
    expect("left blinker", st["drive"]["turn_left"] is True)
    expect("limit flag", st["drive"]["limit_warn"] is True)

    st = derive(_sample(is_charging=1, is_dcfc=1, power=-37.0, charge_power=1.3, charging_eta_minutes=49,
                        charging_capacity_kwh=8.82, locked=0), now, {})
    expect("charging mode", st["mode"] == "charging")
    expect("charging kW from power, not charge_power", st["charge"]["kw"] == 37.0)
    expect("dc", st["charge"]["dc"] is True and st["charge"]["eta_min"] == 49)
    expect("unlocked while charging is no warning", all(w["code"] != "unlocked" for w in st["warnings"]))

    memo = {}
    derive(_sample(is_charging=1, power=-5.0), now, memo)
    st = derive(_sample(soc=80), now + 60, memo)
    expect("charge done notice", st["charge"]["done"] and any(w["code"] == "charge_done" for w in st["warnings"]))

    st = derive(_sample(tyre_leak_fl=1, tyre_p_rr=180, volt_12v=11.8, door_open=1, soc=9), now, {})
    codes = [(w["code"], w.get("wheel")) for w in st["warnings"]]
    expect("tyre leak", ("tyre_leak", "fl") in codes)
    expect("tyre low", ("tyre_low", "rr") in codes)
    expect("12V low", ("v12_low", None) in codes)
    expect("door open", ("door_open", None) in codes)
    expect("soc low", ("soc_low", None) in codes)

    memo = {}
    derive(_sample(locked=0), now, memo)
    st = derive(_sample(locked=0), now + 11 * 60, memo)
    expect("unlocked parked > 10 min", any(w["code"] == "unlocked" for w in st["warnings"]))

    t = _sample(locked=0)
    t["_age"] = 3600.0
    st = derive(t, now, {}, {"locked": "ON", "lock_confirmed": "ON"})
    expect("asleep: cloud lock wins", st["body"]["locked"] is True and st["body"]["lock_src"] == "cloud")
    expect("asleep: stale", st["stale"] is True)

    global ALLOW_UNLOCK, LOCK_TOPICS, CONTROL
    saved = (ALLOW_UNLOCK, LOCK_TOPICS, CONTROL)
    CONTROL, LOCK_TOPICS = True, True
    parked = derive(_sample(), now, {})
    parked["_is_parked"] = True
    parked["_car_off"] = True
    driving = derive(_sample(speed=30, gear="D", is_parked=0), now, {})
    driving["_is_parked"] = False
    driving["_car_off"] = True  # tests the unlock rule on its own
    sp = json.loads(signed_payload("unlock", None, b"k", now=1000, nonce="ab"))
    expect("signed payload", sp["sig"] == hmac.new(b"k", b"unlock||1000|ab", hashlib.sha256).hexdigest() and sp["ts"] == 1000)
    car_on = dict(parked, _car_off=False)
    unknown = dict(parked, _car_off=None)
    expect("climate refused while car is on", check_command({"action": "climate_off"}, car_on, now)[3] == "car_on")
    expect("lock refused while car is on", check_command({"action": "lock"}, car_on, now)[3] == "car_on")
    expect("refused when power state unknown", check_command({"action": "climate_on", "value": 21}, unknown, now)[3] == "car_on")
    expect("climate ok", check_command({"action": "climate_on", "value": 21}, parked, now)[0])
    expect("climate too hot", check_command({"action": "climate_on", "value": 29}, parked, now)[3] == "bad_value")
    expect("climate bad value", check_command({"action": "climate_on", "value": "x"}, parked, now)[3] == "bad_value")
    expect("unknown action", check_command({"action": "honk"}, parked, now)[3] == "unknown_action")
    ALLOW_UNLOCK = False
    expect("unlock disabled", check_command({"action": "unlock"}, parked, now)[3] == "unlock_disabled")
    ALLOW_UNLOCK = True
    expect("unlock parked ok", check_command({"action": "unlock"}, parked, now)[0])
    expect("unlock refused while driving", check_command({"action": "unlock"}, driving, now)[3] == "not_parked")
    expect("unlock refused without state", check_command({"action": "unlock"}, None, now)[3] == "car_on")
    expect("lock while driving allowed", check_command({"action": "lock"}, driving, now)[0])
    expect("rate limit", check_command({"action": "climate_off"}, parked, now, now - 5)[3] == "too_fast")
    expect("busy", check_command({"action": "climate_off"}, parked, now, 0, True)[3] == "busy")
    CONTROL = False
    expect("control off", check_command({"action": "climate_off"}, parked, now)[3] == "control_disabled")
    ALLOW_UNLOCK, LOCK_TOPICS, CONTROL = saved

    expect("feedback ok", status_from_feedback("✅ ⏹️ Klima aus gesendet") == "ok")

    # Cloud-Ersatz (pybyd-mqtt), wenn Overdrive schweigt: Akku/Reichweite/Kilometer/Standort.
    cloud = {"soc": 60.0, "range_km": 210, "odometer": 27736.0, "latitude": 47.123456, "longitude": 13.811111, "_at": now - 600}
    st = derive({"_age": None}, now, {}, cloud)
    expect("cloud soc wenn Auto schweigt", st["battery"]["soc"] == 60 and st["battery"]["src"] == "cloud")
    expect("cloud reichweite", st["battery"]["range_km"] == 210)
    expect("cloud kilometer", st["battery"]["odometer_km"] == 27736)
    expect("standort aus cloud", st["position"] == {"lat": 47.12346, "lon": 13.81111, "src": "cloud", "age_min": 10})
    st = derive(_sample(soc=80), now, {}, cloud)
    expect("frisches Auto schlaegt cloud", st["battery"]["soc"] == 80 and st["battery"]["src"] == "car")
    st = derive({"_age": None}, now, {}, {})
    expect("ohne cloud kein standort", st["position"] is None and st["battery"]["soc"] is None)

    store = Store()
    store.on_tele("soc", b"100", retained=True)
    expect("gespeicherter Altwert ist nicht frisch", store.tele_at is None or store.tele_at == 0)
    store.on_tele("soc", b"61")
    expect("echte Meldung ist frisch", bool(store.tele_at))
    st = derive({"soc": 100.0, "locked": 1, "is_parked": 1, "_age": None}, now, {}, {"soc": 60.0, "_at": now})
    expect("nur Altwerte: kein Absturz, Cloud-Akku", st["battery"]["soc"] == 60 and st["battery"]["src"] == "cloud")
    expect("feedback busy", status_from_feedback("⏳ BYD beschäftigt – ~2 Min warten") == "busy")
    expect("feedback error", status_from_feedback("⚠️ timeout") == "error")
    expect("feedback running", status_from_feedback("⏳ \U0001f525 Heizen …") == "pending")

    print("\n%d Fehler" % len(fails) if fails else "\nalles gruen")
    return 1 if fails else 0


def main():
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    if not NUTZER and not TOKEN:
        sys.stderr.write("WARNUNG: weder BYD_TAILSCALE_USERS noch BYD_TOKEN gesetzt - alles gesperrt\n")
    sys.stderr.write("Steuerung: %s, Entriegeln: %s, Klima-Sollwert: %s, Schloss: %s\n" % (
        "an" if CONTROL else "aus", "erlaubt" if ALLOW_UNLOCK else "gesperrt",
        "frei (cmd/climate_temp)" if TEMP_TOPIC else "26/19 (heat/cool)",
        "mqtt" if LOCK_TOPICS else ("http" if ACTION_URL else "keiner")))
    mqtt_start()
    STORE.refresh(force=True)
    threading.Thread(target=ticker, daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    sys.stderr.write("byd-bridge auf %s:%d, MQTT %s:%d, Thema %s/#\n" % (HOST, PORT, MQTT_HOST, MQTT_PORT, TELE))
    srv.serve_forever()


if __name__ == "__main__":
    main()
