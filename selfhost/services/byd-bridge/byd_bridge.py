#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
byd-bridge - BYD-Telemetrie fuer BYD Glass (Even G2), plus wenige, streng
gepruefte Fernbefehle.

Liest die Fahrzeugdaten, die die Panoptes-App am Auto (Nachfolger von
Overdrive) ueber MQTT meldet (`surfmate/vehicle/telemetry/<feld>`, ein Wert je
Thema; das alte `overdrive/vehicle/telemetry` geht weiter ueber BYD_TOPIC),
haelt den letzten Stand im Speicher und liefert ihn kompakt und schon
ausgewertet an die Brille:

    GET  /state                      Zustand (JSON), mit Anmeldung
    GET  /state?since=<rev>&wait=25  Long-Poll: antwortet sofort, wenn sich
                                     etwas geaendert hat, sonst nach <= 25 s
    POST /command                    {"action": ..., "value": ...} als
                                     text/plain (einfache Anfrage, kein
                                     Preflight), mit Anmeldung
    GET  /health                     Lebenszeichen, ohne Anmeldung, ohne Daten

Befehle sind standardmaessig AUS: POST /command antwortet 403 `control_disabled`,
ohne den Body auszuwerten und ohne etwas an den Broker zu senden. BYD_CONTROL=1
schaltet genau drei Befehle frei (Entscheidung Alfred 23.10.2026, Panoptes-Abstimmung):
    lock                 Zusperren
    unlock               Aufsperren, zusaetzlich nur mit BYD_ALLOW_UNLOCK=1
    preheat  minutes     Vorheizen 10..30 min (5er-Schritte), zusaetzlich nur mit
                         BYD_PREHEAT=1 (pybyd-mqtt kennt die Aktion, siehe proposed/)
Es gibt KEIN Klima-aus (die Sitzung laeuft von selbst ab) und keine Temperaturwahl.

Immer aktive Schutzregeln (nicht per Umgebung abschaltbar, alle fail-closed):
  1. Jeder Befehl nur mit FRISCHEM power_level == 0 von
     `surfmate/vehicle/telemetry/power_level` (live empfangen, hoechstens 180 s alt;
     gespeicherte retained-Werte zaehlen nie). Sonst `car_on`: "Auto ist an – am
     Display bedienen". Grund: 13.10.2026 hat ein Cloud-Befehl das laufende Auto
     abgeschaltet.
  2. Zwei Schritte: `{"action":..,"step":"arm"}` prueft alles und liefert ein
     Einmal-Zeichen (ARM_TTL_S gueltig); erst `{"action":..,"confirm":<zeichen>}`
     (zweites Tippen auf der Brille) sendet - nach erneuter Pruefung.
  3. Mindestens COMMAND_GAP_S zwischen zwei Befehlen, hoechstens RATE_MAX pro Stunde;
     der Zaehler liegt in BYD_RATE_FILE und ueberlebt Neustarts. Unlesbar = gesperrt.
  4. Jedes Aufsperren meldet die Bridge VOR dem Senden per Telegram
     (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID). Nicht eingerichtet oder Fehler = abgelehnt.
  5. Jeder Befehl und jede Ablehnung als JSON-Zeile in BYD_LOG (ohne Zeichen, PIN, Token).
  6. Ergebnis: erst "sent", dann "confirmed" nur, wenn frische Telemetrie NACH dem
     Befehl den Zielzustand meldet (Schloss: locked/unlocked_lf, Vorheizen: ac_on);
     sonst nach CONFIRM_TIMEOUT_S "not_confirmed". pybyd-mqtt-Fehler = "error".

Steuerweg: NUR der signierte Kanal von pybyd-mqtt (HMAC, 30 s, Einmalwert):
  * lock, preheat -> `<BYD_CLOUD_TOPIC>/cmd/signed`
  * unlock        -> `<BYD_CLOUD_TOPIC>/brille/unlock` (eigene Quelle der Brille; nur
                     dort erlaubt das vorgeschlagene befehl_gate Aufsperren)
Die Bridge spricht NIE selbst mit dem Auto oder der BYD-Cloud; pybyd-mqtt prueft
seinerseits (befehl_gate) noch einmal power_level 0. Rueckmeldung ueber
`<BYD_CLOUD_TOPIC>/klima_status`.

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
import urllib.error
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
# Panoptes (Nachfolger von Overdrive) meldet unter surfmate/...; Overdrive per Umgebung weiter moeglich.
TELE = _env("BYD_TOPIC", "surfmate/vehicle/telemetry").rstrip("/")
CLOUD = _env("BYD_CLOUD_TOPIC", "bydcloud/bydsurf").rstrip("/")
# Fahrzeugbefehle: standardmaessig AUS. BYD_CONTROL=1 schaltet lock/unlock/preheat frei
# (Alfred 23.10.2026); die Schutzregeln unten gelten IMMER und sind nicht abschaltbar.
CONTROL = _env("BYD_CONTROL", "0") == "1"
ALLOW_UNLOCK = _env("BYD_ALLOW_UNLOCK", "0") == "1"
# 1 = pybyd-mqtt kennt die signierte Aktion "preheat" (proposed/ eingespielt).
PREHEAT = _env("BYD_PREHEAT", "0") == "1"
RATE_FILE = os.path.expanduser(_env("BYD_RATE_FILE", "~/byd-bridge/rate.json"))
# Optional: Datei mit TELEGRAM_BOT_TOKEN=/TELEGRAM_CHAT_ID= (sonst aus der Umgebung).
TELEGRAM_ENV_FILE = os.path.expanduser(_env("BYD_TELEGRAM_ENV", ""))
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
# --- Schutzregeln fuer Befehle: feste Werte, bewusst NICHT per Umgebung aenderbar ---
# Nur dieses Thema belegt "Auto aus"; retained-Werte zaehlen nie (Alfred 23.10.2026).
POWER_TOPIC = "surfmate/vehicle/telemetry/power_level"
POWER_FRESH_S = 180
# Mindestabstand zwischen zwei gesendeten Befehlen und Hoechstzahl pro Stunde (persistiert).
COMMAND_GAP_S = 15
RATE_MAX = 6
RATE_WINDOW_S = 3600
# Die Brille bestaetigt mit einem zweiten Tippen binnen 4 s; die Bridge laesst fuer den
# Hin- und Rueckweg ueber Handy und Tailscale etwas Luft.
ARM_TTL_S = 8
# So lange wartet die Bridge auf frische Telemetrie, die den Zielzustand zeigt.
CONFIRM_TIMEOUT_S = 120
PREHEAT_MINUTES = (10, 15, 20, 25, 30)
# Kennung der Brillen-Quelle auf dem eigenen Aufsperr-Thema (siehe proposed/befehl_gate.py).
GLASSES_SOURCE = "byd-glass"
LOOPBACK = ("127.0.0.1", "::1", "::ffff:127.0.0.1")
WHEELS = ("fl", "fr", "rl", "rr")

# Panoptes/Overdrive melden "kein Wert" mit Platzhaltern statt leer.
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


DOORS = ("lf", "rf", "lr", "rr")


def car_locked(t):
    """Overdrive: `locked` (1 = verriegelt). Panoptes hat kein `locked`, sondern
    `unlocked_lf` (1 = Fahrertuer entriegelt). Fehlt beides: None (unbekannt)."""
    locked = flag(t, "locked")
    if locked is not None:
        return locked
    unlocked = flag(t, "unlocked_lf")
    return None if unlocked is None else not unlocked


def any_open(t, keys):
    """True, wenn eines der Felder 1 meldet; False, wenn alle bekannten 0 sind; None ohne Wert."""
    known = [v for v in (flag(t, k) for k in keys) if v is not None]
    if not known:
        return None
    return any(known)


def first_num(t, *keys):
    for k in keys:
        v = num(t, k)
        if v is not None:
            return v
    return None


def lock_state(t, cloud, now):
    """(locked, quelle). Auto: siehe car_locked. Schlaeft das Auto (Stand alt),
    zaehlt die Cloud, wenn sie den Schlosszustand frisch bestaetigt hat."""
    car = car_locked(t)
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
    # Panoptes: je Tuer door_open_lf/rf/lr/rr; Overdrive: ein Feld door_open.
    door_open = any_open(t, ["door_open"] + ["door_open_" + d for d in DOORS])
    trunk_open = flag(t, "trunk_open")
    hood_open = flag(t, "hood_open")
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
        temp = num(t, "tyre_t_" + w)
        tyres[w] = {"kpa": None if kpa is None else int(round(kpa)), "leak": leak, "low": bool(low),
                    "temp": None if temp is None else int(round(temp))}

    warnings = []
    for w in WHEELS:
        if tyres[w]["leak"]:
            warnings.append({"code": "tyre_leak", "wheel": w, "kpa": tyres[w]["kpa"], "level": "crit"})
        elif tyres[w]["low"]:
            warnings.append({"code": "tyre_low", "wheel": w, "kpa": tyres[w]["kpa"], "level": "warn"})
    if door_open:
        warnings.append({"code": "door_open", "level": "crit" if mode == "driving" else "warn"})
    if trunk_open:
        warnings.append({"code": "trunk_open", "level": "crit" if mode == "driving" else "warn"})
    if hood_open:
        warnings.append({"code": "hood_open", "level": "crit" if mode == "driving" else "warn"})
    v12 = num(t, "volt_12v")
    if v12 is not None and 5 < v12 < V12_LOW:
        warnings.append({"code": "v12_low", "volt": r1(v12), "level": "warn"})
    since = memo.get("unlocked_since")
    if locked is False and since is not None and mode == "parked" and not door_open and not trunk_open:
        minutes = int((now - since) // 60)
        if minutes >= UNLOCKED_MIN:
            warnings.append({"code": "unlocked", "minutes": minutes, "level": "warn"})
    if soc is not None and soc < SOC_LOW and mode != "charging":
        warnings.append({"code": "soc_low", "soc": int(soc), "level": "warn"})
    if charge_done:
        warnings.append({"code": "charge_done", "soc": None if soc is None else int(soc), "level": "info"})

    def light(key):
        return bool(flag(t, key))

    odometer = num(t, "odometer")
    if odometer is None:
        odometer = cnum(cloud, "odometer")
    ac_on = flag(t, "ac_on")
    if ac_on is None:
        ac_on = flag(t, "climate_on")
    fan = first_num(t, "ac_fan", "ac_wind")

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
            "odometer_km": None if odometer is None else int(odometer),
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
            "trunk_open": trunk_open,
            "hood_open": hood_open,
            "ext_temp": r1(num(t, "ext_temp")),
            "ac_on": ac_on,
            # Geblaesestufe (Panoptes ac_fan, sonst ac_wind); None ohne Wert.
            "ac_fan": None if fan is None else int(fan),
            # Klima-SOLLWERT (17-33, 25 = neutral), KEINE Innenraumtemperatur: der
            # Dolphin Surf hat keinen Innenraumfuehler. Nie als "innen" anzeigen.
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

ACTIONS = ("lock", "unlock", "preheat")

# Ablehnungstexte fuer die Brille (die App zeigt sie so an). Keine Werte, keine Namen.
REFUSALS = {
    "control_disabled": ("Steuerung ist aus", "Control is off"),
    "car_on": ("Auto ist an – am Display bedienen", "Car is on – use the car's screen"),
    "not_allowed": ("Klima aus nur im Auto", "Climate off only in the car"),
    "unknown_action": ("Unbekannter Befehl", "Unknown command"),
    "bad_value": ("Ungültige Dauer (10–30 min)", "Invalid duration (10–30 min)"),
    "bad_request": ("Ungültige Anfrage", "Invalid request"),
    "not_available": ("Nicht eingerichtet", "Not set up"),
    "unlock_disabled": ("Aufsperren ist abgeschaltet", "Unlock is switched off"),
    "not_parked": ("Auto fährt", "Car is moving"),
    "no_notifier": ("Aufsperren: Telegram fehlt", "Unlock: Telegram not set up"),
    "notify_failed": ("Aufsperren: Telegram-Meldung ging nicht", "Unlock: Telegram message failed"),
    "busy": ("Letzter Befehl läuft noch", "Last command still running"),
    "too_fast": ("Zu schnell – kurz warten", "Too fast – wait a moment"),
    "rate_limit": ("Höchstens 6 Befehle pro Stunde", "At most 6 commands per hour"),
    "rate_store": ("Befehlszähler nicht lesbar – gesperrt", "Command counter unreadable – blocked"),
    "confirm_expired": ("Bestätigung abgelaufen – nochmal", "Confirmation expired – try again"),
    "mqtt_offline": ("Broker nicht erreichbar", "Broker unreachable"),
}


def refusal(code):
    de, en = REFUSALS.get(code, ("Abgelehnt", "Refused"))
    return {"de": de, "en": en}


def parse_command(body):
    """-> (action, value, fehler). value = Minuten bei preheat, sonst None."""
    if not isinstance(body, dict):
        return None, None, "bad_request"
    action = body.get("action")
    if action in ("climate_off", "climate", "stop_climate"):
        # Kein Klima-aus von der Brille: die Sitzung endet von selbst (13.10.2026).
        return action, None, "not_allowed"
    if action not in ACTIONS:
        return None, None, "unknown_action"
    if action != "preheat":
        return action, None, None
    raw = body.get("minutes")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw) or raw != int(raw):
        return action, None, "bad_value"
    minutes = int(raw)
    if minutes not in PREHEAT_MINUTES:
        return action, minutes, "bad_value"
    return action, minutes, None


def power_off_fresh(power, now):
    """True nur bei LIVE empfangenem power_level 0, hoechstens POWER_FRESH_S alt."""
    if not power or power.get("level") != 0 or not power.get("at"):
        return False
    age = now - power["at"]
    return 0 <= age <= POWER_FRESH_S


def check_command(body, ctx, now):
    """Alle Schutzregeln, rein. ctx: power {level, at}, mode, pending, rate (Liste der
    Sendezeiten oder None = unlesbar), notifier (bool), secret (bool).
    -> (ok, action, value, grund)."""
    if not CONTROL:
        action = body.get("action") if isinstance(body, dict) else None
        return False, (action if action in ACTIONS else None), None, "control_disabled"
    action, value, code = parse_command(body)
    if code:
        return False, action, value, code
    ctx = ctx or {}
    if not power_off_fresh(ctx.get("power"), now):
        return False, action, value, "car_on"
    if action == "preheat" and not PREHEAT:
        return False, action, value, "not_available"
    if action == "unlock":
        if not ALLOW_UNLOCK:
            return False, action, value, "unlock_disabled"
        if ctx.get("mode") == "driving":
            return False, action, value, "not_parked"
        if not ctx.get("notifier"):
            return False, action, value, "no_notifier"
    if not ctx.get("secret"):
        return False, action, value, "not_available"
    if ctx.get("pending"):
        return False, action, value, "busy"
    rate = ctx.get("rate")
    if rate is None:
        return False, action, value, "rate_store"
    if rate and now - max(rate) < COMMAND_GAP_S:
        return False, action, value, "too_fast"
    if len([t for t in rate if now - t < RATE_WINDOW_S]) >= RATE_MAX:
        return False, action, value, "rate_limit"
    return True, action, value, None


# --- Zaehler (persistiert, ueberlebt Neustarts) -------------------------------------

def rate_load(path=None):
    """Sendezeiten der letzten Stunde, [] ohne Datei, None wenn unlesbar (= gesperrt)."""
    path = path or RATE_FILE
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        return None
    sent = data.get("sent") if isinstance(data, dict) else None
    if not isinstance(sent, list) or not all(isinstance(t, (int, float)) and not isinstance(t, bool) for t in sent):
        return None
    return [float(t) for t in sent]


def rate_add(now, path=None):
    """Haengt einen Sendezeitpunkt an (atomar, chmod 600). False = nicht gespeichert."""
    path = path or RATE_FILE
    sent = rate_load(path)
    if sent is None:
        return False
    sent = [t for t in sent if now - t < RATE_WINDOW_S] + [now]
    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"sent": sent}, f)
        os.replace(tmp, path)
    except OSError:
        return False
    return True


# --- Telegram (nur sendMessage; Token nie ins Log) -----------------------------------

class NotifyError(Exception):
    pass


def _read_env_file(path):
    out = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                key, sep, val = line.strip().partition("=")
                if sep and not key.startswith("#"):
                    out[key.strip()] = val.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


class TelegramNotifier:
    """Telegram Bot API sendMessage. Zugang aus TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID (Umgebung,
    z. B. systemd EnvironmentFile) oder aus der Datei BYD_TELEGRAM_ENV. Ruft nie getUpdates
    (ein zweiter Leser wuerde dem Bot Nachrichten wegnehmen)."""

    def __init__(self, env_file=None, opener=None, timeout=10):
        self.env_file = TELEGRAM_ENV_FILE if env_file is None else env_file
        self.opener = opener or urllib.request.urlopen
        self.timeout = timeout

    def _creds(self):
        env = _read_env_file(self.env_file) if self.env_file else {}
        token = (env.get("TELEGRAM_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN", "")).strip()
        chat = (env.get("TELEGRAM_CHAT_ID") or os.environ.get("TELEGRAM_CHAT_ID", "")).strip()
        return token, chat

    def configured(self):
        token, chat = self._creds()
        return bool(token and chat)

    def send(self, text):
        token, chat = self._creds()
        if not (token and chat):
            raise NotifyError("not_configured")
        data = urllib.parse.urlencode({"chat_id": chat, "text": text[:300],
                                       "disable_web_page_preview": "true"}).encode("utf-8")
        req = urllib.request.Request("https://api.telegram.org/bot%s/sendMessage" % token, data=data, method="POST")
        try:
            with self.opener(req, timeout=self.timeout) as resp:
                answer = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise NotifyError("http_%s" % exc.code) from None
        except Exception as exc:  # noqa: BLE001 - jede Stoerung ist ein Fehler; Token nie im Text
            raise NotifyError(type(exc).__name__) from None
        if not (isinstance(answer, dict) and answer.get("ok") is True):
            raise NotifyError("not_ok")


NOTIFIER = TelegramNotifier()


def unlock_text(who, now):
    return "🔓 BYD Glass: Aufsperren angefordert (%s, %s)" % (
        time.strftime("%H:%M:%S", time.localtime(now)), who or "?")


# --- Bestaetigung aus frischer Telemetrie --------------------------------------------

def target_reached(action, tele, live_at, sent_at):
    """True, wenn ein NACH dem Befehl live empfangener Wert den Zielzustand meldet."""
    def live(field, want):
        return live_at.get(field, 0) > sent_at and flag(tele, field) is want
    if action == "lock":
        return live("locked", True) or live("unlocked_lf", False)
    if action == "unlock":
        return live("locked", False) or live("unlocked_lf", True)
    if action == "preheat":
        return live("ac_on", True) or live("climate_on", True)
    return False


def status_from_feedback(text):
    """Rueckmeldung von pybyd-mqtt (klima_status) -> accepted|pending|busy|refused|error."""
    s = (text or "").strip()
    if s.startswith("✅"):
        return "accepted"
    if s.startswith("⛔"):
        return "refused"
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
        # Zeitpunkt der letzten LIVE (nicht retained) empfangenen Meldung je Feld.
        self.live_at = {}
        # power_level NUR von POWER_TOPIC und NUR live: {"level": float, "at": epoch}.
        self.power = {}
        self.cloud = {}
        self.memo = {}
        self.rev = 0
        self.state = None
        self.body_key = ""
        self.dirty = True
        self.mqtt_ok = False
        self.command = None
        # Offene Rueckfragen (zweites Tippen): zeichen -> {action, value, until}.
        self.arms = {}

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
                    now = time.time()
                    self.tele_at = now
                    self.live_at[field] = now
                    self._check_target()
            self.dirty = True

    def on_power(self, raw, retained=False, now=None):
        """power_level von POWER_TOPIC. Retained zaehlt nie; ein unlesbarer Live-Wert loescht
        den alten Beleg (lieber sperren als einen alten Wert weiterverwenden)."""
        if retained:
            return False
        with self.lock:
            value = parse_value(raw)
            if isinstance(value, float):
                self.power = {"level": value, "at": time.time() if now is None else now}
            else:
                self.power = {}
            self.dirty = True
        return True

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

    def _finish(self, status, text=None):
        c = self.command
        c["status"] = status
        if text is not None:
            c["text"] = text
        c["done_at"] = int(time.time() * 1000)
        log_event("result", c.get("action"), c.get("value"), status, text or c.get("text") or None, c.get("id"))
        self.dirty = True

    def _feedback(self, text):
        """Rueckmeldung von pybyd-mqtt: Fehler, Sperre und "beschaeftigt" beenden den Befehl als
        "error"; "gesendet" heisst nur "von der Cloud angenommen" - bestaetigt ist erst die
        frische Telemetrie."""
        c = self.command
        if not c or c["status"] != "sent":
            return
        kind = status_from_feedback(text)
        if kind == "accepted":
            c["cloud"] = "accepted"
        elif kind in ("refused", "error", "busy"):
            self._finish("error", text.strip()[:120])

    def _check_target(self):
        c = self.command
        if c and c["status"] == "sent" and target_reached(c["action"], self.tele, self.live_at, c["_sent"]):
            self._finish("confirmed")

    # Ticker
    def refresh(self, force=False):
        with self.lock:
            now = time.time()
            c = self.command
            if c and c["status"] == "sent" and now - c["_sent"] > CONFIRM_TIMEOUT_S:
                self._finish("not_confirmed")
            for token in [k for k, a in self.arms.items() if now > a["until"]]:
                del self.arms[token]
            t = dict(self.tele)
            t["_age"] = None if self.tele_at is None else now - self.tele_at
            st = derive(t, now, self.memo, self.cloud)
            car_off = power_off_fresh(self.power, now)
            power_age = None if not self.power.get("at") else now - self.power["at"]
            st["car_on"] = bool(self.power.get("level") not in (None, 0) and power_age is not None
                                and power_age <= POWER_FRESH_S)
            st["command"] = public_command(self.command)
            st["control"] = {
                "enabled": CONTROL,
                "lock": CONTROL,
                "unlock": CONTROL and ALLOW_UNLOCK,
                "preheat": CONTROL and PREHEAT,
                "preheat_minutes": list(PREHEAT_MINUTES),
                # Nur ein frisches power_level 0 erlaubt Befehle (Anzeige; die Pruefung laeuft je Befehl neu).
                "car_off": car_off,
                "arm_s": ARM_TTL_S,
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

    def context(self, now):
        """Alles, was check_command braucht, in einem Zug gelesen."""
        with self.lock:
            c = self.command
            return {
                "power": dict(self.power),
                "mode": (self.state or {}).get("mode"),
                "pending": bool(c and c["status"] == "sent"),
                "rate": rate_load(),
                "notifier": NOTIFIER.configured(),
                "secret": bool(_secret()),
            }

    def snapshot(self, since=None, wait=0.0):
        deadline = time.time() + max(0.0, min(wait, 25.0))
        with self.lock:
            while since is not None and self.state is not None and self.state["rev"] == since:
                left = deadline - time.time()
                if left <= 0:
                    break
                self.lock.wait(left)
            st = dict(self.state or {})
        return st


STORE = Store()
# Pruefen und Senden eines Befehls laufen nie parallel (zwei Bestaetigungen gleichzeitig).
SEND_LOCK = threading.Lock()


def public_command(c):
    if not c:
        return None
    return {k: v for k, v in c.items() if not k.startswith("_")}


def log_event(step, action, value, result, reason=None, cid=None, who=None):
    """Eine JSON-Zeile je Befehl/Ablehnung/Ergebnis. Nie Zeichen, PIN, Token oder Geheimnis."""
    row = {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "step": step, "kind": action, "value": value,
           "result": result, "reason": reason}
    if cid:
        row["id"] = cid
    if who:
        row["who"] = who
    line = json.dumps(row, ensure_ascii=False)
    sys.stderr.write("CMD %s\n" % line)
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError as exc:
        sys.stderr.write("Befehlslog nicht schreibbar: %s\n" % type(exc).__name__)


MQTT = {"client": None}


def route_message(topic, payload, retained=False, store=None):
    """Ein MQTT-Thema -> Speicher. Telemetrie: `<BYD_TOPIC>/<feld>` (ein Wert je
    Thema); Unterthemen wie `guard/state`, `health/state` oder `.../set` werden nie
    mitgelesen. power_level von POWER_TOPIC zusaetzlich als Beleg "Auto aus".
    Cloud: `<BYD_CLOUD_TOPIC>/state|klima_mode|klima_status`.
    -> "tele" | "power" | "cloud" | None (ignoriert)."""
    store = store or STORE
    routed = None
    if topic == POWER_TOPIC:
        store.on_power(payload, retained)
        routed = "power"
    if topic.startswith(TELE + "/"):
        field = topic[len(TELE) + 1:]
        if not field or "/" in field:
            return routed
        store.on_tele(field, payload, retained)
        return "tele"
    if topic.startswith(CLOUD + "/"):
        sub = topic[len(CLOUD) + 1:]
        if sub not in ("state", "klima_mode", "klima_status"):
            return None
        store.on_cloud(sub, payload)
        return "cloud"
    return routed


def mqtt_start():
    import paho.mqtt.client as mqtt  # noqa: WPS433 (nur zur Laufzeit noetig)

    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="byd-glass-bridge")
    except AttributeError:  # paho 1.x
        client = mqtt.Client(client_id="byd-glass-bridge")

    def on_connect(c, *_args):
        # paho 2.x: subscribe erst nach CONNACK, sonst verpufft es.
        c.subscribe(TELE + "/#")
        if not POWER_TOPIC.startswith(TELE + "/"):
            c.subscribe(POWER_TOPIC)
        for sub in ("state", "klima_mode", "klima_status"):
            c.subscribe(CLOUD + "/" + sub)
        STORE.mqtt_ok = True
        sys.stderr.write("MQTT verbunden %s:%d\n" % (MQTT_HOST, MQTT_PORT))

    def on_disconnect(*_args):
        STORE.mqtt_ok = False

    def on_message(_c, _u, msg):
        route_message(msg.topic, msg.payload, bool(getattr(msg, "retain", False)))

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(2, 60)
    client.connect_async(MQTT_HOST, MQTT_PORT, 60)
    client.loop_start()
    MQTT["client"] = client


def command_route(action, value, secret, now=None):
    """-> (thema, nutzlast). Nur der signierte Kanal; Aufsperren auf dem eigenen Brillen-Thema."""
    if action == "unlock":
        return CLOUD + "/brille/unlock", signed_payload("unlock", GLASSES_SOURCE, secret, now)
    if action == "preheat":
        return CLOUD + "/cmd/signed", signed_payload("preheat", value, secret, now)
    return CLOUD + "/cmd/signed", signed_payload("lock", None, secret, now)


def arm_command(body, who, now=None):
    """Erster Schritt: alle Regeln pruefen, nichts senden. -> (http, antwort)."""
    now = time.time() if now is None else now
    ok, action, value, grund = check_command(body, STORE.context(now), now)
    if not ok:
        log_event("arm", action, value, "refused", grund, who=who)
        return _refused_code(grund), {"ok": False, "error": grund, "message": refusal(grund)}
    token = os.urandom(12).hex()
    with STORE.lock:
        STORE.arms[token] = {"action": action, "value": value, "until": now + ARM_TTL_S}
    log_event("arm", action, value, "armed", who=who)
    return 200, {"ok": True, "armed": token, "ttl_s": ARM_TTL_S, "action": action, "value": value}


def confirm_command(body, who, now=None):
    """Zweiter Schritt (zweites Tippen): Zeichen pruefen, ALLE Regeln erneut, beim Aufsperren
    zuerst Telegram, dann senden. -> (http, antwort)."""
    with SEND_LOCK:
        now = time.time() if now is None else now
        token = body.get("confirm") if isinstance(body, dict) else None
        with STORE.lock:
            arm = STORE.arms.pop(token, None) if isinstance(token, str) else None
        action, value, _code = parse_command(body)
        if not arm or now > arm["until"] or arm["action"] != action or arm["value"] != value:
            log_event("confirm", action, value, "refused", "confirm_expired", who=who)
            return 409, {"ok": False, "error": "confirm_expired", "message": refusal("confirm_expired")}
        ok, action, value, grund = check_command(body, STORE.context(now), now)
        if ok and (MQTT["client"] is None or not STORE.mqtt_ok):
            ok, grund = False, "mqtt_offline"
        if ok and not rate_add(now):
            ok, grund = False, "rate_store"
        if ok and action == "unlock":
            try:
                NOTIFIER.send(unlock_text(who, now))
            except NotifyError as exc:
                sys.stderr.write("Telegram: %s\n" % exc)
                ok, grund = False, "notify_failed"
        if not ok:
            log_event("confirm", action, value, "refused", grund, who=who)
            return _refused_code(grund), {"ok": False, "error": grund, "message": refusal(grund)}
        c = publish_command(action, value, who, now)
        return 202, {"ok": c["status"] != "error", "command": public_command(c),
                     **({} if c["status"] != "error" else {"error": c["text"], "message": refusal(c["text"])})}


def publish_command(action, value, who, now):
    """Gibt den Befehl an pybyd-mqtt (signierter Kanal). -> Befehlsobjekt."""
    cid = "c%d" % int(now * 1000)
    c = {"id": cid, "action": action, "value": value, "status": "sent", "text": "",
         "at": int(now * 1000), "_sent": now}
    topic, payload = command_route(action, value, _secret(), now)
    client = MQTT["client"]
    try:
        info = client.publish(topic, payload, qos=1)
        if getattr(info, "rc", 0) != 0:
            c["status"], c["text"] = "error", "mqtt_offline"
    except Exception:  # noqa: BLE001
        c["status"], c["text"] = "error", "mqtt_offline"
    with STORE.lock:
        STORE.command = c
        STORE.dirty = True
    log_event("send", action, value, c["status"], c["text"] or None, cid, who)
    STORE.refresh()
    return c


def _refused_code(grund):
    if grund in ("busy", "too_fast", "rate_limit", "confirm_expired"):
        return 409
    if grund in ("not_available", "no_notifier"):
        return 501
    if grund in ("unknown_action", "bad_value", "bad_request"):
        return 400
    if grund in ("mqtt_offline", "notify_failed"):
        return 503
    return 403


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
        if not CONTROL:
            # Standard: keine Fahrzeugbefehle. Der Body wird nur verworfen (nicht ausgewertet),
            # nichts geht an den Broker.
            try:
                n = int(self.headers.get("Content-Length") or "0")
            except ValueError:
                n = -1
            if 0 < n <= 2048:
                self.rfile.read(n)
            else:
                self.close_connection = True
            log_event("request", None, None, "refused", "control_disabled")
            return self._antwort(403, {"ok": False, "error": "control_disabled"}, "-", t0)
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
        if isinstance(body, dict) and body.get("step") == "arm":
            code, reply = arm_command(body, wer)
        elif isinstance(body, dict) and "confirm" in body:
            code, reply = confirm_command(body, wer)
        else:
            # Ohne Rueckfrage wird nie gesendet: erst "arm", dann "confirm" (zweites Tippen).
            ok, action, value, grund = check_command(body, STORE.context(time.time()), time.time())
            grund = grund or "confirm_expired"
            log_event("request", action, value, "refused", grund, who=wer)
            code, reply = _refused_code(grund), {"ok": False, "error": grund, "message": refusal(grund)}
        return self._antwort(code, reply, form, t0)


# ---------------------------------------------------------------------------
# Selbsttest
# ---------------------------------------------------------------------------

def _sample(**over):
    base = {
        "speed": "0.0", "gear": "P", "is_parked": "1", "is_charging": "0", "is_dcfc": "0",
        "power": "0.0", "soc": "64.0", "ev_range_km": "190", "consumption_50km": "15.8",
        "unlocked_lf": "0", "door_open_lf": "0", "door_open_rf": "0", "door_open_lr": "0", "door_open_rr": "0", "volt_12v": "12.6", "soh": "97.0",
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
                        charging_capacity_kwh=8.82, unlocked_lf=1), now, {})
    expect("charging mode", st["mode"] == "charging")
    expect("charging kW from power, not charge_power", st["charge"]["kw"] == 37.0)
    expect("dc", st["charge"]["dc"] is True and st["charge"]["eta_min"] == 49)
    expect("unlocked while charging is no warning", all(w["code"] != "unlocked" for w in st["warnings"]))

    memo = {}
    derive(_sample(is_charging=1, power=-5.0), now, memo)
    st = derive(_sample(soc=80), now + 60, memo)
    expect("charge done notice", st["charge"]["done"] and any(w["code"] == "charge_done" for w in st["warnings"]))

    st = derive(_sample(tyre_leak_fl=1, tyre_p_rr=180, volt_12v=11.8, door_open_rr=1, soc=9), now, {})
    codes = [(w["code"], w.get("wheel")) for w in st["warnings"]]
    expect("tyre leak", ("tyre_leak", "fl") in codes)
    expect("tyre low", ("tyre_low", "rr") in codes)
    expect("12V low", ("v12_low", None) in codes)
    expect("door open", ("door_open", None) in codes)

    # Overdrive-Namen (BYD_TOPIC=overdrive/...) gelten weiter.
    st = derive(_sample(locked=0, door_open=1), now, {})
    expect("overdrive locked/door_open", st["body"]["locked"] is False and st["body"]["door_open"] is True)
    st = derive(_sample(ac_on=1, ac_fan=3, odometer=28015.9, tyre_t_fl=20, trunk_open=1), now, {})
    expect("klima an + stufe", st["body"]["ac_on"] is True and st["body"]["ac_fan"] == 3)
    expect("kilometer aus telemetrie", st["battery"]["odometer_km"] == 28015)
    expect("reifentemperatur", st["tyres"]["fl"]["temp"] == 20 and st["tyres"]["fr"]["temp"] is None)
    expect("kofferraum offen", any(w["code"] == "trunk_open" for w in st["warnings"]))
    # Ein anderes BYD-Modell ohne diese Felder: nichts wird zu 0 oder False erfunden.
    st = derive({"soc": 70.0, "_age": 3.0}, now, {})
    expect("fehlende Felder bleiben None", st["body"]["locked"] is None and st["body"]["door_open"] is None
           and st["body"]["ac_fan"] is None and st["battery"]["volt_12v"] is None and st["tyres"]["fl"]["kpa"] is None
           and st["drive"]["speed"] is None and st["warnings"] == [])
    expect("soc low", ("soc_low", None) in codes)

    memo = {}
    derive(_sample(unlocked_lf=1), now, memo)
    st = derive(_sample(unlocked_lf=1), now + 11 * 60, memo)
    expect("unlocked parked > 10 min", any(w["code"] == "unlocked" for w in st["warnings"]))

    t = _sample(unlocked_lf=1)
    t["_age"] = 3600.0
    st = derive(t, now, {}, {"locked": "ON", "lock_confirmed": "ON"})
    expect("asleep: cloud lock wins", st["body"]["locked"] is True and st["body"]["lock_src"] == "cloud")
    expect("asleep: stale", st["stale"] is True)

    global ALLOW_UNLOCK, PREHEAT, CONTROL
    saved = (ALLOW_UNLOCK, PREHEAT, CONTROL)
    CONTROL, PREHEAT, ALLOW_UNLOCK = True, True, True
    off = {"power": {"level": 0.0, "at": now - 10}, "mode": "parked", "pending": False, "rate": [],
           "notifier": True, "secret": True}
    sp = json.loads(signed_payload("unlock", None, b"k", now=1000, nonce="ab"))
    expect("signed payload", sp["sig"] == hmac.new(b"k", b"unlock||1000|ab", hashlib.sha256).hexdigest() and sp["ts"] == 1000)
    expect("lock ok when off (fresh)", check_command({"action": "lock"}, off, now)[0])
    expect("preheat 20 ok", check_command({"action": "preheat", "minutes": 20}, off, now)[:3] == (True, "preheat", 20))
    expect("unlock ok when off", check_command({"action": "unlock"}, off, now)[0])
    expect("car on refused", check_command({"action": "lock"}, dict(off, power={"level": 2.0, "at": now - 5}), now)[3] == "car_on")
    expect("stale power refused", check_command({"action": "lock"}, dict(off, power={"level": 0.0, "at": now - 181}), now)[3] == "car_on")
    expect("no power refused", check_command({"action": "lock"}, dict(off, power={}), now)[3] == "car_on")
    expect("climate off never", check_command({"action": "climate_off"}, off, now)[3] == "not_allowed")
    expect("preheat 9 refused", check_command({"action": "preheat", "minutes": 9}, off, now)[3] == "bad_value")
    expect("preheat 31 refused", check_command({"action": "preheat", "minutes": 31}, off, now)[3] == "bad_value")
    expect("preheat without minutes", check_command({"action": "preheat"}, off, now)[3] == "bad_value")
    expect("unknown action", check_command({"action": "honk"}, off, now)[3] == "unknown_action")
    expect("unlock without notifier", check_command({"action": "unlock"}, dict(off, notifier=False), now)[3] == "no_notifier")
    expect("unlock while driving", check_command({"action": "unlock"}, dict(off, mode="driving"), now)[3] == "not_parked")
    expect("cooldown", check_command({"action": "lock"}, dict(off, rate=[now - 5]), now)[3] == "too_fast")
    expect("rate limit", check_command({"action": "lock"}, dict(off, rate=[now - 3000 + i for i in range(6)]), now)[3] == "rate_limit")
    expect("rate unreadable", check_command({"action": "lock"}, dict(off, rate=None), now)[3] == "rate_store")
    expect("busy", check_command({"action": "lock"}, dict(off, pending=True), now)[3] == "busy")
    expect("no secret", check_command({"action": "lock"}, dict(off, secret=False), now)[3] == "not_available")
    ALLOW_UNLOCK = False
    expect("unlock disabled", check_command({"action": "unlock"}, off, now)[3] == "unlock_disabled")
    PREHEAT = False
    expect("preheat not set up", check_command({"action": "preheat", "minutes": 10}, off, now)[3] == "not_available")
    CONTROL = False
    expect("control off", check_command({"action": "lock"}, off, now)[3] == "control_disabled")
    ALLOW_UNLOCK, PREHEAT, CONTROL = saved

    expect("target lock", target_reached("lock", {"unlocked_lf": 0.0}, {"unlocked_lf": now + 1}, now))
    expect("target lock old value", not target_reached("lock", {"unlocked_lf": 0.0}, {"unlocked_lf": now - 1}, now))
    expect("target preheat", target_reached("preheat", {"ac_on": 1.0}, {"ac_on": now + 1}, now))
    expect("feedback accepted", status_from_feedback("✅ 🔒 Zusperren gesendet") == "accepted")
    expect("feedback refused", status_from_feedback("⛔ Auto ist an – bitte im Auto bedienen.") == "refused")

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
    sys.stderr.write("Steuerung: %s, Aufsperren: %s, Vorheizen: %s, Telegram: %s, Schluessel: %s\n" % (
        "an" if CONTROL else "aus", "erlaubt" if ALLOW_UNLOCK else "gesperrt",
        "an" if PREHEAT else "aus", "ja" if NOTIFIER.configured() else "nein",
        "ja" if _secret() else "nein"))
    mqtt_start()
    STORE.refresh(force=True)
    threading.Thread(target=ticker, daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    sys.stderr.write("byd-bridge auf %s:%d, MQTT %s:%d, Thema %s/#\n" % (HOST, PORT, MQTT_HOST, MQTT_PORT, TELE))
    srv.serve_forever()


if __name__ == "__main__":
    main()
