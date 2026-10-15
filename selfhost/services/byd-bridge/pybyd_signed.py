# -*- coding: utf-8 -*-
"""
Erweiterung fuer ~/byd-copilot/pybyd_mqtt.py: signierter Befehlskanal fuer BYD Glass.

Der Mosquitto-Broker ist anonym - jeder im LAN koennte auf cmd/* publizieren. Darum
nehmen Verriegeln, Entriegeln und Klima-mit-Temperatur NUR Nachrichten auf
bydcloud/<node>/cmd/signed an, die mit dem Geheimnis aus BYD_CMD_SECRET_FILE
(HMAC-SHA256 ueber "action|value|ts|nonce") unterschrieben, hoechstens 30 s alt und
noch nie gesehen sind. Die Pruefung "Auto aus" macht die byd-bridge vorher
(Overdrive power_level 0); dieser Teil prueft nur Unterschrift, Alter, Wiederholung.

Einbau (siehe README): diese Datei neben pybyd_mqtt.py legen, dort
    import pybyd_signed
in on_connect zusaetzlich  client.subscribe(pybyd_signed.TOPIC % NODE)
in on_msg ganz oben:       if pybyd_signed.handle(msg, NODE, _spawn_cmd): return
"""
import hashlib
import hmac
import json
import os
import time

TOPIC = "bydcloud/%s/cmd/signed"
SECRET_FILE = os.path.expanduser(os.environ.get("BYD_CMD_SECRET_FILE", "~/byd-copilot/.cmd_secret"))
MAX_AGE_S = 30
_SEEN = {}


def _secret():
    try:
        with open(SECRET_FILE, "rb") as f:
            return f.read().strip()
    except OSError:
        return b""


def verify(payload, now=None, secret=None, seen=None):
    """-> (action, value) oder (None, grund)."""
    now = time.time() if now is None else now
    secret = _secret() if secret is None else secret
    seen = _SEEN if seen is None else seen
    if not secret:
        return None, "no_secret"
    try:
        d = json.loads(payload)
        action, value, ts, nonce, sig = d["action"], str(d.get("value", "")), int(d["ts"]), str(d["nonce"]), str(d["sig"])
    except (ValueError, KeyError, TypeError):
        return None, "bad_payload"
    if action not in ("lock", "unlock", "climate_temp"):
        return None, "bad_action"
    if abs(now - ts) > MAX_AGE_S:
        return None, "too_old"
    msg = ("%s|%s|%d|%s" % (action, value, ts, nonce)).encode("utf-8")
    if not hmac.compare_digest(hmac.new(secret, msg, hashlib.sha256).hexdigest(), sig):
        return None, "bad_sig"
    for k in [k for k, t in seen.items() if now - t > 2 * MAX_AGE_S]:
        del seen[k]
    if nonce in seen:
        return None, "replay"
    seen[nonce] = now
    return action, value


def handle(msg, node, run):
    """run(action, value) fuehrt aus. True = Nachricht war fuer diesen Kanal."""
    if msg.topic != TOPIC % node:
        return False
    action, value = verify(msg.payload.decode("utf-8", "replace"))
    if action is None:
        print(time.strftime("%F %T"), "signed cmd abgelehnt:", value, flush=True)
        return True
    run(action, value)
    return True
