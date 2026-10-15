#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Brillen-Melder: kurze Telegram-Nachrichten, wenn bei den eigenen Diensten etwas passiert.

Warum: Even-Hub-Apps auf der G2 laufen nur, solange sie offen sind - Handy-Benachrichtigungen
kommen aber immer auf die Brille. Dieser Dienst beobachtet Drucker, Auto, Zucker und Server und
schickt bei Ereignissen eine kurze Nachricht ueber den Telegram-Bot (-> Handy -> Brille).

Waechter (je per URL eingeschaltet, ohne URL aus; Abfrage alle NOTIFY_INTERVAL Sekunden):
    NOTIFY_KLIPPER_URL   Klipper-Bridge (GET /api/printer): Druck fertig / abgebrochen / Fehler / pausiert
    NOTIFY_BYD_URL       BYD-Bridge (GET /state): Laden fertig, Auto laenger offen
    NOTIFY_SUGAR_URL     sugar-bridge / Nightscout (GET /api/v1/entries/sgv.json): niedrig, hoch, keine Werte
    NOTIFY_STATUS_URLS   "Name|https://host/status,Name2|https://..." (Status-Glass-Server): nicht
                         erreichbar > NOTIFY_DOWN_MIN min, wieder da, neue Geraete im Heimnetz
    Optional je Waechter ein Bearer-Token: NOTIFY_KLIPPER_TOKEN, NOTIFY_BYD_TOKEN, NOTIFY_SUGAR_TOKEN,
    NOTIFY_STATUS_TOKEN (im Tailnet per `tailscale serve` meist nicht noetig).

Senden: Telegram Bot API sendMessage. Token und Ziel werden bei jedem Senden aus der Datei
NOTIFY_HERMES_ENV (Standard ~/.hermes/.env) gelesen: TELEGRAM_BOT_TOKEN, TELEGRAM_HOME_CHANNEL
(sonst erste Nummer aus TELEGRAM_ALLOWED_USERS; NOTIFY_CHAT_ID ueberschreibt). Der Token wird nie
ausgegeben, protokolliert oder gespeichert. Der Dienst liest KEINE Nachrichten (kein getUpdates) -
der Bot gehoert auch dem Hermes-Agenten, der ihn abfragt.

Weitere Umgebung
    NOTIFY_INTERVAL          Sekunden zwischen Abfragen (Standard 60)
    NOTIFY_TIMEOUT           Sekunden je Anfrage (Standard 10)
    NOTIFY_QUIET             Ruhezeit, z. B. 23:00-07:00 (leer = keine). Dann nur Zucker und
                             "Server nicht erreichbar"; neue Geraete werden nach der Ruhezeit gemeldet.
    NOTIFY_STATE             Zustandsdatei (Standard ~/.local/state/glass-notify/state.json, Rechte 600)
    NOTIFY_BYD_TARGET        Ladeziel in % (Standard 80); "fertig" ab Ziel oder ab 95 %
    NOTIFY_SUGAR_LOW / _URGENT / _HIGH   Grenzen mg/dL (Standard 70 / 55 / 250)
    NOTIFY_SUGAR_STALE_MIN   Minuten ohne Wert bis zur Meldung (Standard 20)
    NOTIFY_DOWN_MIN          Minuten nicht erreichbar bis zur Meldung (Standard 5)

Aufruf
    python3 glass_notify.py                 laufen (systemd-User-Dienst)
    python3 glass_notify.py --dry-run       Nachrichten nur ausgeben, nichts senden, Zustand nicht speichern
    python3 glass_notify.py --dry-run --once   eine Runde
    python3 glass_notify.py --test-message  eine Nachricht "Brillen-Melder aktiv" senden
    python3 glass_notify.py --selftest      alle Uebergaenge mit Fake-Daten pruefen (ohne Netz)

KEIN medizinischer Alarm. Die Alarme von Pumpe/Sensor-App bleiben an.
Nur Standardbibliothek, Python 3.9+.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

INTERVAL = float(os.environ.get("NOTIFY_INTERVAL", "60"))
TIMEOUT = float(os.environ.get("NOTIFY_TIMEOUT", "10"))
HERMES_ENV = os.path.expanduser(os.environ.get("NOTIFY_HERMES_ENV", "~/.hermes/.env"))
CHAT_OVERRIDE = os.environ.get("NOTIFY_CHAT_ID", "").strip()
STATE_FILE = os.path.expanduser(os.environ.get("NOTIFY_STATE", "~/.local/state/glass-notify/state.json"))
QUIET = os.environ.get("NOTIFY_QUIET", "").strip()

KLIPPER_URL = os.environ.get("NOTIFY_KLIPPER_URL", "").strip()
BYD_URL = os.environ.get("NOTIFY_BYD_URL", "").strip()
SUGAR_URL = os.environ.get("NOTIFY_SUGAR_URL", "").strip()
STATUS_URLS = os.environ.get("NOTIFY_STATUS_URLS", "").strip()
TOKENS = {k: os.environ.get("NOTIFY_%s_TOKEN" % k.upper(), "").strip()
          for k in ("klipper", "byd", "sugar", "status")}

BYD_TARGET = float(os.environ.get("NOTIFY_BYD_TARGET", "80"))
SUGAR_LOW = float(os.environ.get("NOTIFY_SUGAR_LOW", "70"))
SUGAR_URGENT = float(os.environ.get("NOTIFY_SUGAR_URGENT", "55"))
SUGAR_HIGH = float(os.environ.get("NOTIFY_SUGAR_HIGH", "250"))
SUGAR_STALE_S = float(os.environ.get("NOTIFY_SUGAR_STALE_MIN", "20")) * 60
DOWN_S = float(os.environ.get("NOTIFY_DOWN_MIN", "5")) * 60

MAX_LEN = 200
SUGAR_LOW_FAST = 80          # unter diesem Wert und schnell fallend = auch "niedrig"
SUGAR_LOW_CLEAR = 80         # Hysterese: "wieder im Bereich" erst ab hier
SUGAR_HIGH_CLEAR = 230
SUGAR_LOW_REPEAT_S = 20 * 60
SUGAR_HIGH_REPEAT_S = 60 * 60
SENT_KEEP_S = 7 * 24 * 3600
OUTBOX_KEEP_S = 3600
GROUP_MAX = 3                # mehr Ereignisse einer Gruppe -> eine Sammelnachricht

ARROWS = {"DoubleUp": "⇈", "SingleUp": "↑", "FortyFiveUp": "↗", "Flat": "→",
          "FortyFiveDown": "↘", "SingleDown": "↓", "DoubleDown": "⇊"}
FALLING = ("SingleDown", "DoubleDown")


def log(text):
    print(text, flush=True)


# --------------------------------------------------------------------------
# Hilfen
# --------------------------------------------------------------------------

def shorten(text, limit=MAX_LEN):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def duration_text(seconds):
    minutes = max(0, int(round(seconds / 60.0)))
    h, m = divmod(minutes, 60)
    return "%d h %d min" % (h, m) if h else "%d min" % m


def short_file(path):
    name = str(path or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"\.(gcode|bgcode|g)$", "", name, flags=re.I)
    return shorten(name or "?", 60)


def parse_quiet(spec):
    m = re.match(r"^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$", spec or "")
    if not m:
        return None
    a = int(m.group(1)) * 60 + int(m.group(2))
    b = int(m.group(3)) * 60 + int(m.group(4))
    return (a, b) if a != b else None


def in_quiet(spec, now):
    q = parse_quiet(spec)
    if not q:
        return False
    t = time.localtime(now)
    minute = t.tm_hour * 60 + t.tm_min
    a, b = q
    return a <= minute < b if a < b else (minute >= a or minute < b)


def endpoint(url, path):
    """Haengt den Standardpfad an, wenn die URL nur Host (und Port) enthaelt."""
    parts = urllib.parse.urlsplit(url)
    if parts.path in ("", "/"):
        return url.rstrip("/") + path
    return url


def parse_status_urls(spec):
    out = []
    for item in re.split(r"[,;]", spec or ""):
        item = item.strip()
        if not item:
            continue
        name, _, url = item.partition("|")
        if not url:
            url, name = name, urllib.parse.urlsplit(name).hostname or name
        out.append((name.strip(), endpoint(url.strip(), "/status")))
    return out


def fetch_json(url, token="", opener=urllib.request.urlopen, timeout=TIMEOUT):
    headers = {"Accept": "application/json", "User-Agent": "glass-notify"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, headers=headers)
    with opener(req, timeout=timeout) as resp:
        return json.loads(resp.read(1024 * 1024).decode("utf-8"))


# --------------------------------------------------------------------------
# Waechter (rein: Zustand + Daten -> Ereignisse). Ereignis = dict(key, text, urgent, group)
# --------------------------------------------------------------------------

def ev(key, text, urgent=False, group=None, defer=False):
    return {"key": key, "text": shorten(text), "urgent": urgent, "group": group, "defer": defer}


def printer_step(st, data, now):
    """data = Antwort von GET /api/printer, None bei Fehler."""
    if not isinstance(data, dict) or data.get("online") is False:
        return []
    cur = str(data.get("state") or "unknown")
    prev = st.get("state")
    st["state"] = cur
    out = []
    if cur in ("printing", "paused") and prev not in ("printing", "paused"):
        st["started"] = now
        st["file"] = data.get("file") or ""
        st["pauses"] = 0
    if cur in ("printing", "paused"):
        st["file"] = data.get("file") or st.get("file") or ""
        try:
            st["progress"] = int(data.get("progress") or 0)
        except (TypeError, ValueError):
            pass
    if prev not in ("printing", "paused") or cur == prev:
        return out
    started = st.get("started") or now
    file = short_file(st.get("file") or data.get("file"))
    took = duration_text(now - started)
    base = "print:%d" % int(started)
    if cur == "paused":
        st["pauses"] = st.get("pauses", 0) + 1
        out.append(ev("%s:paused:%d" % (base, st["pauses"]),
                      "🖨 Druck pausiert: %s (%d %%)" % (file, st.get("progress", 0))))
    elif cur == "complete" or (cur == "standby" and st.get("progress", 0) >= 99):
        out.append(ev(base + ":complete", "🖨 Druck fertig: %s (%s)" % (file, took)))
    elif cur == "cancelled":
        out.append(ev(base + ":cancelled", "🖨 Druck abgebrochen: %s nach %s" % (file, took)))
    elif cur == "error":
        msg = shorten(data.get("message") or "", 70)
        out.append(ev(base + ":error", "🖨 Druckfehler: %s nach %s%s" % (file, took, (" – " + msg) if msg else "")))
    elif cur == "standby":
        out.append(ev(base + ":ended", "🖨 Druck beendet: %s bei %d %% (%s)" % (file, st.get("progress", 0), took)))
    return out


def car_step(st, data, now, target=BYD_TARGET):
    """data = Antwort von GET /state der BYD-Bridge."""
    if not isinstance(data, dict) or data.get("stale") or not data.get("mode"):
        return []
    mode = data["mode"]
    prev = st.get("mode")
    st["mode"] = mode
    battery = data.get("battery") or {}
    soc, km = battery.get("soc"), battery.get("range_km")
    out = []
    if mode == "charging" and prev != "charging":
        st["charge_start"] = now
    if prev == "charging" and mode != "charging" and mode != "driving":
        tail = ("%s %%" % soc if soc is not None else "?") + (", %s km" % km if km is not None else "")
        key = "car:charge:%d" % int(st.get("charge_start") or now)
        if soc is not None and (soc >= target or soc >= 95):
            out.append(ev(key, "🚗 Laden fertig: " + tail))
        else:
            out.append(ev(key, "🚗 Laden beendet: " + tail))
    unlocked = next((w for w in data.get("warnings") or [] if isinstance(w, dict) and w.get("code") == "unlocked"), None)
    if unlocked:
        if not st.get("unlock_since"):
            st["unlock_since"] = now - 60 * float(unlocked.get("minutes") or 0)
            out.append(ev("car:unlocked:%d" % int(st["unlock_since"]),
                          "🚗 Auto seit %d min nicht abgesperrt" % int(unlocked.get("minutes") or 10)))
    else:
        st.pop("unlock_since", None)
    return out


def sugar_entries(data):
    out = []
    for e in data if isinstance(data, list) else []:
        if not isinstance(e, dict):
            continue
        try:
            sgv, date = float(e.get("sgv")), float(e.get("date")) / 1000.0
        except (TypeError, ValueError):
            continue
        if sgv > 0 and date > 0:
            out.append((date, sgv, str(e.get("direction") or "")))
    out.sort()
    return out


def sugar_step(st, data, now, low=SUGAR_LOW, urgent=SUGAR_URGENT, high=SUGAR_HIGH, stale_s=SUGAR_STALE_S):
    """data = Liste aus /api/v1/entries/sgv.json (None bei Fehler). Alle Ereignisse sind dringend."""
    entries = sugar_entries(data)
    if entries:
        st["last_date"] = max(entries[-1][0], st.get("last_date") or 0)
    last = st.get("last_date")
    out = []
    if not last:
        return out
    age = now - last
    if age > stale_s:
        if not st.get("stale_alerted"):
            st["stale_alerted"] = True
            out.append(ev("sugar:stale:%d" % int(last), "🩸 Seit %d min keine Zuckerwerte" % int(age // 60), True))
        return out
    if not entries or entries[-1][0] < last:
        return out
    date, v, direction = entries[-1]
    arrow = ARROWS.get(direction, "")
    head = "🩸 Zucker %d%s – " % (round(v), (" " + arrow) if arrow else "")
    key = "sugar:%%s:%d" % int(date)
    if st.pop("stale_alerted", None):
        out.append(ev(key % "back", head + "Werte wieder da", True))
    level = st.get("level", "ok")
    falling_low = v < SUGAR_LOW_FAST and direction in FALLING
    is_low = v < low or falling_low
    if level == "low":
        if v >= SUGAR_LOW_CLEAR and not is_low:
            st.update(level="ok", urgent_sent=False)
            out.append(ev(key % "lowok", head + "wieder im Bereich", True))
        elif v < urgent and not st.get("urgent_sent"):
            st.update(urgent_sent=True, last_alert=now)
            out.append(ev(key % "urgent", head + "sehr niedrig!", True))
        elif now - (st.get("last_alert") or 0) >= SUGAR_LOW_REPEAT_S:
            st["last_alert"] = now
            out.append(ev(key % "low", head + ("sehr niedrig!" if v < urgent else "immer noch niedrig"), True))
        if v >= urgent + 5:
            st["urgent_sent"] = False
        return out
    if level == "high":
        if v < SUGAR_HIGH_CLEAR:
            st["level"] = "ok"
            out.append(ev(key % "highok", head + "wieder unter %d" % high, True))
        elif now - (st.get("last_alert") or 0) >= SUGAR_HIGH_REPEAT_S:
            st["last_alert"] = now
            out.append(ev(key % "high", head + "immer noch hoch", True))
        if level == "high" and st["level"] == "high":
            return out
    if is_low:
        st.update(level="low", last_alert=now, urgent_sent=v < urgent)
        word = "sehr niedrig!" if v < urgent else ("niedrig" if v < low else "fällt schnell")
        out.append(ev(key % "low", head + word, True))
    elif v > high:
        st.update(level="high", last_alert=now)
        out.append(ev(key % "high", head + "hoch", True))
    return out


def server_step(st, name, data, now, down_s=DOWN_S):
    """data = Antwort von GET /status (dict), None = nicht erreichbar."""
    out = []
    if data is None:
        since = st.setdefault("down_since", now)
        if now - since >= down_s and not st.get("down_alerted"):
            st["down_alerted"] = True
            out.append(ev("srv:%s:down:%d" % (name, int(since)),
                          "🖥 %s nicht erreichbar seit %d min" % (name, int((now - since) // 60)), True))
        return out
    since = st.pop("down_since", None)
    if st.pop("down_alerted", None):
        out.append(ev("srv:%s:up:%d" % (name, int(since or now)),
                      "🖥 %s wieder erreichbar (%s weg)" % (name, duration_text(now - (since or now)))))
    network = data.get("network") if isinstance(data, dict) else None
    if isinstance(network, dict):
        for d in network.get("devices") or []:
            if not isinstance(d, dict) or not d.get("new") or d.get("known"):
                continue
            ident = d.get("mac") or d.get("ip")
            if not ident:
                continue
            label = d.get("name") or d.get("ip") or d.get("mac")
            if d.get("name") and d.get("ip"):
                label = "%s (%s)" % (d["name"], d["ip"])
            out.append(ev("net:%s:%s" % (name, ident), "🌐 Neues Gerät im Netz: " + shorten(label, 80),
                          group="net", defer=True))
    return out


# --------------------------------------------------------------------------
# Zustand
# --------------------------------------------------------------------------

def load_state(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(path, state):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, mode=0o700, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, separators=(",", ":"))
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)


# --------------------------------------------------------------------------
# Senden
# --------------------------------------------------------------------------

def read_env_file(path, keys=("TELEGRAM_BOT_TOKEN", "TELEGRAM_HOME_CHANNEL", "TELEGRAM_ALLOWED_USERS")):
    out = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[7:].lstrip()
                k, sep, v = line.partition("=")
                k = k.strip()
                if not sep or k not in keys:
                    continue
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                out[k] = v
    except OSError:
        pass
    return out


def telegram_target(env, override=""):
    if override:
        return override
    chat = (env.get("TELEGRAM_HOME_CHANNEL") or "").strip()
    if chat:
        return chat
    for part in re.split(r"[,;\s]+", env.get("TELEGRAM_ALLOWED_USERS") or ""):
        if part.strip():
            return part.strip()
    return ""


class SendError(Exception):
    pass


class TelegramSender:
    """Nur sendMessage. Der Token wird bei jedem Senden frisch gelesen und nie ausgegeben."""

    def __init__(self, env_path=HERMES_ENV, override=CHAT_OVERRIDE, opener=urllib.request.urlopen, timeout=TIMEOUT):
        self.env_path, self.override, self.opener, self.timeout = env_path, override, opener, timeout

    def __call__(self, text):
        env = read_env_file(self.env_path)
        token = env.get("TELEGRAM_BOT_TOKEN", "").strip()
        chat = telegram_target(env, self.override)
        if not token or not chat:
            raise SendError("TELEGRAM_BOT_TOKEN oder Ziel-Chat fehlt in %s" % self.env_path)
        body = json.dumps({"chat_id": chat, "text": text, "disable_web_page_preview": True,
                           "link_preview_options": {"is_disabled": True}}).encode("utf-8")
        req = urllib.request.Request("https://api.telegram.org/bot%s/sendMessage" % token, data=body,
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            with self.opener(req, timeout=self.timeout) as resp:
                answer = json.loads(resp.read(65536).decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = json.loads(e.read(4096).decode("utf-8")).get("description", "")
            except Exception:
                pass
            raise SendError(redact("Telegram HTTP %s %s" % (e.code, detail), token))
        except Exception as e:  # Netz, Zeitueberschreitung
            raise SendError(redact("Telegram nicht erreichbar: %s" % type(e).__name__, token))
        if not answer.get("ok"):
            raise SendError(redact("Telegram: %s" % answer.get("description", "nicht ok"), token))
        return True


def redact(text, token):
    text = str(text)
    if token:
        text = text.replace(token, "***")
    return re.sub(r"bot\d+:[A-Za-z0-9_-]+", "bot***", text)


# --------------------------------------------------------------------------
# Verteiler: Ruhezeit, Doppelte, Sammeln, Nachsenden
# --------------------------------------------------------------------------

class Notifier:
    def __init__(self, state, send, quiet=QUIET, now=time.time, out=log):
        self.state, self.send, self.quiet, self.now, self.out = state, send, quiet, now, out
        self.state.setdefault("sent", {})
        self.state.setdefault("outbox", [])

    def _deliver(self, key_list, text):
        try:
            self.send(text)
        except Exception as e:
            self.out("senden fehlgeschlagen (%s): %s" % (",".join(k.split(":")[0] for k in key_list), e))
            return False
        t = self.now()
        for k in key_list:
            self.state["sent"][k] = t
        self.out("gesendet: " + ",".join(k.split(":")[0] for k in key_list))
        return True

    def dispatch(self, events):
        now = self.now()
        sent = self.state["sent"]
        for k in [k for k, t in sent.items() if now - t > SENT_KEEP_S]:
            del sent[k]
        quiet = in_quiet(self.quiet, now)
        # 1) altes Liegengebliebenes nachsenden
        box, self.state["outbox"] = self.state["outbox"], []
        for item in box:
            if now - item.get("ts", now) > OUTBOX_KEEP_S or all(k in sent for k in item["keys"]):
                continue
            if quiet and not item.get("urgent"):
                continue
            if not self._deliver(item["keys"], item["text"]):
                self.state["outbox"].append(item)
        # 2) neue Ereignisse
        fresh, groups = [], {}
        seen = set()
        for e in events:
            if e["key"] in sent or e["key"] in seen:
                continue
            seen.add(e["key"])
            if quiet and not e.get("urgent"):
                if not e.get("defer"):
                    sent[e["key"]] = now          # verworfen, nicht spaeter nachholen
                self.out("Ruhezeit, unterdrueckt: " + e["key"].split(":")[0])
                continue
            if e.get("group"):
                groups.setdefault(e["group"], []).append(e)
            else:
                fresh.append(e)
        for name, items in groups.items():
            if len(items) <= GROUP_MAX:
                fresh.extend(items)
            else:
                labels = [i["text"].split(": ", 1)[-1] for i in items]
                text = shorten("🌐 %d neue Geräte im Netz: %s" % (len(items), ", ".join(labels)))
                fresh.append({"key": None, "keys": [i["key"] for i in items], "text": text, "urgent": False})
        for e in fresh:
            keys = e.get("keys") or [e["key"]]
            if not self._deliver(keys, e["text"]):
                self.state["outbox"].append({"keys": keys, "text": e["text"], "urgent": e.get("urgent"), "ts": now})
                self.state["outbox"] = self.state["outbox"][-20:]


# --------------------------------------------------------------------------
# Eine Runde
# --------------------------------------------------------------------------

def watchers_from_env():
    w = []
    if KLIPPER_URL:
        w.append(("printer", endpoint(KLIPPER_URL, "/api/printer"), TOKENS["klipper"]))
    if BYD_URL:
        w.append(("car", endpoint(BYD_URL, "/state"), TOKENS["byd"]))
    if SUGAR_URL:
        url = SUGAR_URL if "sgv.json" in SUGAR_URL else SUGAR_URL.rstrip("/") + "/api/v1/entries/sgv.json?count=3"
        w.append(("sugar", url, TOKENS["sugar"]))
    for name, url in parse_status_urls(STATUS_URLS):
        w.append(("server:" + name, url, TOKENS["status"]))
    return w


def poll_once(state, watchers, notifier, fetch=fetch_json, now=time.time):
    events = []
    ws = state.setdefault("w", {})
    for kind, url, token in watchers:
        try:
            data = fetch(url, token)
        except Exception as e:
            data = None
            if not kind.startswith("server:"):
                log("%s: keine Antwort (%s)" % (kind, type(e).__name__))
        st = ws.setdefault(kind, {})
        t = now()
        try:
            if kind == "printer":
                events += printer_step(st, data, t)
            elif kind == "car":
                events += car_step(st, data, t)
            elif kind == "sugar":
                events += sugar_step(st, data, t)
            elif kind.startswith("server:"):
                events += server_step(st, kind.split(":", 1)[1], data, t)
        except Exception as e:  # ein kaputter Waechter haelt die anderen nicht auf
            log("%s: Fehler %s" % (kind, type(e).__name__))
    notifier.dispatch(events)


def run(dry_run=False, once=False):
    watchers = watchers_from_env()
    if not watchers:
        sys.exit("Kein Waechter eingeschaltet (NOTIFY_KLIPPER_URL, NOTIFY_BYD_URL, NOTIFY_SUGAR_URL, NOTIFY_STATUS_URLS).")
    state = load_state(STATE_FILE)
    send = (lambda text: log("[dry-run] " + text)) if dry_run else TelegramSender()
    notifier = Notifier(state, send)
    log("Brillen-Melder: %s, alle %ds%s%s" % (", ".join(w[0] for w in watchers), int(INTERVAL),
                                            ", Ruhezeit " + QUIET if parse_quiet(QUIET) else "",
                                            " (dry-run)" if dry_run else ""))
    while True:
        poll_once(state, watchers, notifier)
        if not dry_run:
            try:
                save_state(STATE_FILE, state)
            except OSError as e:
                log("Zustand nicht gespeichert: %s" % type(e).__name__)
        if once:
            return
        time.sleep(INTERVAL)


def test_message():
    try:
        TelegramSender()("✅ Brillen-Melder aktiv")
    except SendError as e:
        print("FEHLER: %s" % e)
        return False
    print("Testnachricht gesendet.")
    return True


# --------------------------------------------------------------------------
# Selbsttest (ohne Netz)
# --------------------------------------------------------------------------

def selftest():
    import io
    import tempfile
    ok = True
    messages = []

    def check(name, cond):
        nonlocal ok
        print(("OK   " if cond else "FEHL ") + name)
        ok = ok and bool(cond)

    def texts(evs):
        messages.extend(e["text"] for e in evs)
        return [e["text"] for e in evs]

    # Drucker
    st, t0 = {}, 1_000_000.0
    check("Drucker: Start still", texts(printer_step(st, {"online": True, "state": "printing", "file": "dir/Halter_v2.gcode", "progress": 3}, t0)) == [])
    check("Drucker: offline aendert nichts", printer_step(st, {"online": False, "reason": "searching"}, t0 + 60) == [] and st["state"] == "printing")
    out = texts(printer_step(st, {"online": True, "state": "paused", "file": "dir/Halter_v2.gcode", "progress": 40}, t0 + 3600))
    check("Drucker: pausiert", out == ["🖨 Druck pausiert: Halter_v2 (40 %)"])
    printer_step(st, {"online": True, "state": "printing", "file": "dir/Halter_v2.gcode", "progress": 41}, t0 + 3700)
    out = texts(printer_step(st, {"online": True, "state": "complete", "file": "dir/Halter_v2.gcode", "progress": 100}, t0 + 3 * 3600 + 12 * 60))
    check("Drucker: fertig mit Dauer", out == ["🖨 Druck fertig: Halter_v2 (3 h 12 min)"])
    check("Drucker: complete bleibt still", printer_step(st, {"online": True, "state": "complete", "progress": 100}, t0 + 4 * 3600) == [])
    st2 = {}
    printer_step(st2, {"online": True, "state": "printing", "file": "a.gcode"}, t0)
    out = texts(printer_step(st2, {"online": True, "state": "cancelled", "file": "a.gcode"}, t0 + 45 * 60))
    check("Drucker: abgebrochen", out == ["🖨 Druck abgebrochen: a nach 45 min"])
    st3 = {}
    printer_step(st3, {"online": True, "state": "printing", "file": "b.gcode"}, t0)
    out = texts(printer_step(st3, {"online": True, "state": "error", "file": "b.gcode", "message": "Heater extruder not heating at expected rate"}, t0 + 600))
    check("Drucker: Fehler", len(out) == 1 and out[0].startswith("🖨 Druckfehler: b nach 10 min – Heater"))
    check("Drucker: complete ohne Vorgeschichte still", printer_step({}, {"online": True, "state": "complete"}, t0) == [])

    # Auto
    car = {}
    s = lambda mode, soc, km=305, warnings=None, stale=False: {"mode": mode, "stale": stale, "battery": {"soc": soc, "range_km": km}, "warnings": warnings or []}
    check("Auto: Laden beginnt still", car_step(car, s("parked", 40), t0) == [] and car_step(car, s("charging", 41), t0 + 60) == [])
    check("Auto: veraltet ignoriert", car_step(car, s("parked", 96, stale=True), t0 + 120) == [] and car["mode"] == "charging")
    out = texts(car_step(car, s("parked", 96), t0 + 7200))
    check("Auto: Laden fertig", out == ["🚗 Laden fertig: 96 %, 305 km"])
    check("Auto: nur einmal", car_step(car, s("parked", 96), t0 + 7260) == [])
    car_step(car, s("charging", 50), t0 + 8000)
    out = texts(car_step(car, s("parked", 62, 190), t0 + 9000))
    check("Auto: frueh beendet", out == ["🚗 Laden beendet: 62 %, 190 km"])
    car_step(car, s("charging", 50), t0 + 9100)
    check("Auto: Abstecken und Losfahren still", car_step(car, s("driving", 70), t0 + 9200) == [])
    check("Auto: Ziel erreicht = fertig", texts(car_step({"mode": "charging"}, s("parked", 80), t0, target=80)) == ["🚗 Laden fertig: 80 %, 305 km"])
    unl = [{"code": "unlocked", "minutes": 12, "level": "warn"}]
    out = texts(car_step(car, s("parked", 70, warnings=unl), t0 + 10000))
    check("Auto: offen > 10 min", out == ["🚗 Auto seit 12 min nicht abgesperrt"])
    check("Auto: offen nur einmal", car_step(car, s("parked", 70, warnings=unl), t0 + 10060) == [])
    car_step(car, s("parked", 70), t0 + 10120)
    check("Auto: neu offen meldet wieder", len(car_step(car, s("parked", 70, warnings=unl), t0 + 20000)) == 1)

    # Zucker
    def sgv(v, d, at):
        return [{"sgv": v, "direction": d, "date": int(at * 1000), "type": "sgv"}]
    su = {}
    check("Zucker: normal still", sugar_step(su, sgv(120, "Flat", t0), t0 + 30) == [])
    out = texts(sugar_step(su, sgv(68, "SingleDown", t0 + 300), t0 + 330))
    check("Zucker: niedrig", out == ["🩸 Zucker 68 ↓ – niedrig"] and all(e for e in [su["level"] == "low"]))
    check("Zucker: kein Wiederholen vor 20 min", sugar_step(su, sgv(66, "SingleDown", t0 + 600), t0 + 630) == [])
    out = texts(sugar_step(su, sgv(53, "DoubleDown", t0 + 900), t0 + 930))
    check("Zucker: sofort unter 55", out == ["🩸 Zucker 53 ⇊ – sehr niedrig!"])
    check("Zucker: unter 55 nicht doppelt", sugar_step(su, sgv(52, "Flat", t0 + 1200), t0 + 1230) == [])
    out = texts(sugar_step(su, sgv(60, "Flat", t0 + 2100), t0 + 2130))
    check("Zucker: Wiederholung nach 20 min", out == ["🩸 Zucker 60 → – immer noch niedrig"])
    check("Zucker: Hysterese 75 bleibt niedrig", sugar_step(su, sgv(75, "FortyFiveUp", t0 + 2400), t0 + 2430) == [] and su["level"] == "low")
    out = texts(sugar_step(su, sgv(92, "FortyFiveUp", t0 + 2700), t0 + 2730))
    check("Zucker: wieder im Bereich", out == ["🩸 Zucker 92 ↗ – wieder im Bereich"])
    out = texts(sugar_step(su, sgv(78, "DoubleDown", t0 + 3000), t0 + 3030))
    check("Zucker: unter 80 schnell fallend", out == ["🩸 Zucker 78 ⇊ – fällt schnell"])
    check("Zucker: 78 flach nicht niedrig", sugar_step({}, sgv(78, "Flat", t0), t0 + 10) == [])
    hi = {}
    out = texts(sugar_step(hi, sgv(265, "SingleUp", t0), t0 + 10))
    check("Zucker: hoch", out == ["🩸 Zucker 265 ↑ – hoch"])
    check("Zucker: hoch nicht vor 60 min", sugar_step(hi, sgv(270, "Flat", t0 + 1200), t0 + 1210) == [])
    check("Zucker: Hysterese 240 bleibt hoch", sugar_step(hi, sgv(240, "Flat", t0 + 1500), t0 + 1510) == [])
    out = texts(sugar_step(hi, sgv(210, "FortyFiveDown", t0 + 1800), t0 + 1810))
    check("Zucker: wieder unter 250", out == ["🩸 Zucker 210 ↘ – wieder unter 250"])
    out = texts(sugar_step(hi, None, t0 + 1800 + 21 * 60))
    check("Zucker: keine Werte > 20 min", out == ["🩸 Seit 21 min keine Zuckerwerte"] and out and True)
    check("Zucker: veraltet nur einmal", sugar_step(hi, [], t0 + 1800 + 30 * 60) == [])
    out = texts(sugar_step(hi, sgv(130, "Flat", t0 + 4000), t0 + 4010))
    check("Zucker: Werte wieder da", out == ["🩸 Zucker 130 → – Werte wieder da"])
    check("Zucker: ohne je Daten still", sugar_step({}, None, t0) == [])
    check("Zucker: alles dringend", all(e["urgent"] for e in sugar_step({}, sgv(50, "Flat", t0), t0)))

    # Server und Netz
    sv = {}
    check("Server: kurz weg still", server_step(sv, "Spark", None, t0) == [] and server_step(sv, "Spark", None, t0 + 240) == [])
    evs = server_step(sv, "Spark", None, t0 + 300)
    check("Server: nach 5 min gemeldet, dringend", texts(evs) == ["🖥 Spark nicht erreichbar seit 5 min"] and evs[0]["urgent"])
    check("Server: nur einmal", server_step(sv, "Spark", None, t0 + 600) == [])
    out = texts(server_step(sv, "Spark", {"metrics": []}, t0 + 12 * 60))
    check("Server: wieder da", out == ["🖥 Spark wieder erreichbar (12 min weg)"])
    check("Server: Aussetzer ohne Meldung still", server_step({}, "Pi", None, t0) == [] and server_step({"down_since": t0}, "Pi", {}, t0 + 60) == [])
    netdata = {"network": {"new": 1, "devices": [
        {"mac": "aa:bb:cc:00:00:01", "ip": "10.0.0.23", "name": "Galaxy-S24", "new": True, "known": False},
        {"mac": "aa:bb:cc:00:00:02", "ip": "10.0.0.5", "new": False, "known": True}]}}
    out = texts(server_step({}, "Pi", netdata, t0))
    check("Netz: neues Geraet", out == ["🌐 Neues Gerät im Netz: Galaxy-S24 (10.0.0.23)"])

    # Verteiler: Doppelte, Ruhezeit, Sammeln, Nachsenden
    sent_box = []
    clock = [time.mktime((2026, 10, 14, 12, 0, 0, 0, 0, -1))]
    state = {}
    n = Notifier(state, sent_box.append, quiet="23:00-07:00", now=lambda: clock[0], out=lambda *_: None)
    e1 = ev("print:1:complete", "🖨 Druck fertig: x (1 h 0 min)")
    n.dispatch([e1, e1])
    n.dispatch([e1])
    check("Doppelte: nur einmal gesendet", sent_box == ["🖨 Druck fertig: x (1 h 0 min)"])
    state2 = json.loads(json.dumps(state))
    n2 = Notifier(state2, sent_box.append, quiet="23:00-07:00", now=lambda: clock[0], out=lambda *_: None)
    n2.dispatch([e1])
    check("Doppelte: auch nach Neustart (Zustand)", len(sent_box) == 1)
    check("Ruhezeit 23-07: 02:00 drin, 12:00 nicht, 07:00 nicht",
          in_quiet("23:00-07:00", time.mktime((2026, 10, 14, 2, 0, 0, 0, 0, -1)))
          and not in_quiet("23:00-07:00", clock[0])
          and not in_quiet("23:00-07:00", time.mktime((2026, 10, 14, 7, 0, 0, 0, 0, -1))))
    check("Ruhezeit am Tag 13-15", in_quiet("13:00-15:00", time.mktime((2026, 10, 14, 14, 0, 0, 0, 0, -1))))
    check("Ruhezeit leer/kaputt = keine", not in_quiet("", clock[0]) and not in_quiet("abc", clock[0]))
    clock[0] = time.mktime((2026, 10, 15, 2, 0, 0, 0, 0, -1))
    sent_box.clear()
    netev = server_step({}, "Pi", netdata, clock[0])
    n.dispatch([ev("print:2:complete", "🖨 Druck fertig: y (5 min)"),
                ev("sugar:low:1", "🩸 Zucker 65 ↓ – niedrig", True),
                ev("srv:Spark:down:1", "🖥 Spark nicht erreichbar seit 5 min", True)] + netev)
    check("Ruhezeit: nur Zucker und Server-weg", sent_box == ["🩸 Zucker 65 ↓ – niedrig", "🖥 Spark nicht erreichbar seit 5 min"])
    clock[0] = time.mktime((2026, 10, 15, 7, 30, 0, 0, 0, -1))
    sent_box.clear()
    n.dispatch([ev("print:2:complete", "🖨 Druck fertig: y (5 min)")] + netev)
    check("Ruhezeit: Druck verworfen, neues Geraet nachgeholt", sent_box == ["🌐 Neues Gerät im Netz: Galaxy-S24 (10.0.0.23)"])
    sent_box.clear()
    many = [ev("net:Pi:m%d" % i, "🌐 Neues Gerät im Netz: Geraet-%d" % i, group="net", defer=True) for i in range(5)]
    n.dispatch(many)
    check("Sammeln: 5 Geraete = 1 Nachricht", len(sent_box) == 1 and sent_box[0].startswith("🌐 5 neue Geräte im Netz: Geraet-0"))
    n.dispatch(many)
    check("Sammeln: danach still", len(sent_box) == 1)
    fails = [True]

    def flaky(text):
        if fails[0]:
            raise SendError("Telegram nicht erreichbar: URLError")
        sent_box.append(text)
    sent_box.clear()
    n3 = Notifier({}, flaky, now=lambda: clock[0], out=lambda *_: None)
    n3.dispatch([ev("car:charge:1", "🚗 Laden fertig: 96 %, 305 km")])
    fails[0] = False
    n3.dispatch([])
    check("Nachsenden nach Fehler", sent_box == ["🚗 Laden fertig: 96 %, 305 km"])
    n3.dispatch([])
    check("Nachsenden nur einmal", len(sent_box) == 1)

    # Laenge
    long_ev = server_step({}, "Pi", {"network": {"devices": [{"mac": "x", "name": "N" * 300, "new": True}]}}, t0)
    messages.extend(e["text"] for e in long_ev)
    messages.append(printer_step({"state": "printing", "file": "F" * 400, "started": t0}, {"online": True, "state": "error", "message": "M" * 400}, t0 + 60)[0]["text"])
    check("alle Nachrichten <= 200 Zeichen", messages and all(len(m) <= MAX_LEN for m in messages))
    check("alle Nachrichten mit Kennzeichen", all(m[0] in "🖨🚗🩸🖥🌐" for m in messages))
    check("Dauer-Text", duration_text(192 * 60) == "3 h 12 min" and duration_text(59) == "1 min")

    # Senden: Token nie in Ausgabe
    fake_token = "1234567:SELFTEST-fake-token_DoNotUse"
    tmpdir = tempfile.mkdtemp()
    envp = os.path.join(tmpdir, "hermes.env")
    with open(envp, "w", encoding="utf-8") as f:
        f.write("# Kommentar\nexport TELEGRAM_BOT_TOKEN='%s'\nTELEGRAM_ALLOWED_USERS=111, 222\nOTHER=x\n" % fake_token)
    seen_req = []

    class Resp:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self, *a):
            return self.body

    def good_opener(req, timeout):
        seen_req.append(req)
        return Resp(b'{"ok":true,"result":{}}')

    def bad_opener(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized " + req.full_url, {},
                                     io.BytesIO(json.dumps({"ok": False, "description": "Unauthorized " + req.full_url}).encode()))

    def boom_opener(req, timeout):
        raise urllib.error.URLError("failed for " + req.full_url)

    buf = io.StringIO()
    real_out, real_err = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = buf
    errors = []
    try:
        TelegramSender(envp, "", good_opener)("✅ Brillen-Melder aktiv")
        for op in (bad_opener, boom_opener):
            try:
                TelegramSender(envp, "", op)("x")
            except SendError as e:
                errors.append(str(e))
                log("senden fehlgeschlagen: %s" % e)
        nlog = []
        Notifier({}, TelegramSender(envp, "", bad_opener), now=lambda: clock[0], out=nlog.append).dispatch(
            [ev("t:1", "🖥 test", True)])
        print("\n".join(nlog))
        try:
            TelegramSender(os.path.join(tmpdir, "fehlt.env"), "", good_opener)("x")
        except SendError as e:
            print(str(e))
    finally:
        sys.stdout, sys.stderr = real_out, real_err
    out_text = buf.getvalue() + "\n".join(errors)
    req = seen_req[0] if seen_req else None
    body = json.loads(req.data.decode()) if req else {}
    check("Senden: sendMessage per POST", req is not None and req.get_method() == "POST" and req.full_url.endswith("/sendMessage"))
    check("Senden: Ziel = erster aus ALLOWED_USERS", body.get("chat_id") == "111")
    check("Senden: ohne Linkvorschau, ohne parse_mode", body.get("disable_web_page_preview") is True and "parse_mode" not in body)
    check("Senden: HOME_CHANNEL hat Vorrang", telegram_target({"TELEGRAM_HOME_CHANNEL": "-100", "TELEGRAM_ALLOWED_USERS": "1"}) == "-100")
    check("Senden: Fehler gemeldet", len(errors) == 2 and "401" in errors[0])
    check("Token nie in der Ausgabe", fake_token not in out_text and "SELFTEST-fake" not in out_text and len(out_text) > 0)
    src = open(os.path.abspath(__file__), encoding="utf-8").read()
    check("liest keine Nachrichten (kein getUpdates-Aufruf)", ("/get" + "Updates") not in src)

    # Zustand: atomar, Rechte 600
    sp = os.path.join(tmpdir, "sub", "state.json")
    save_state(sp, {"sent": {"a": 1}})
    mode_ok = os.name == "nt" or (os.stat(sp).st_mode & 0o777) == 0o600
    check("Zustand gespeichert und lesbar, Rechte 600", load_state(sp) == {"sent": {"a": 1}} and mode_ok and not os.path.exists(sp + ".tmp"))
    check("Zustand ohne Token", fake_token not in open(sp, encoding="utf-8").read())
    check("Status-URLs", parse_status_urls("Spark|https://spark.example.ts.net:8443, Pi|https://pi.example.ts.net/status")
          == [("Spark", "https://spark.example.ts.net:8443/status"), ("Pi", "https://pi.example.ts.net/status")])
    check("Endpunkt anhaengen", endpoint("https://pi.example.ts.net:8898", "/api/printer") == "https://pi.example.ts.net:8898/api/printer"
          and endpoint("https://pi.example.ts.net/x/state", "/state") == "https://pi.example.ts.net/x/state")

    # Eine Runde mit Fake-Abruf (ohne Netz)
    calls = []

    def fake_fetch(url, token):
        calls.append((url, token))
        if "printer" in url:
            return {"online": True, "state": "printing", "file": "z.gcode"}
        raise OSError("down")
    st_round = {}
    n4 = Notifier(st_round, lambda t: None, now=lambda: t0, out=lambda *_: None)
    poll_once(st_round, [("printer", "https://p.example.ts.net/api/printer", ""), ("server:Spark", "https://s.example.ts.net/status", "tok")],
              n4, fetch=fake_fetch, now=lambda: t0)
    check("Runde: alle Waechter abgefragt, Fehler abgefangen",
          len(calls) == 2 and st_round["w"]["printer"]["state"] == "printing" and st_round["w"]["server:Spark"]["down_since"] == t0)

    print("alles gruen" if ok else "FEHLER")
    return ok


def main():
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    args = sys.argv[1:]
    if "--selftest" in args:
        sys.exit(0 if selftest() else 1)
    if "--test-message" in args:
        sys.exit(0 if test_message() else 1)
    try:
        run(dry_run="--dry-run" in args, once="--once" in args)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
