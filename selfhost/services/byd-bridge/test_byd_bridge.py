#!/usr/bin/env python3
"""Tests for byd-bridge without a broker or a car (fakes only).

    python3 test_byd_bridge.py        (or: python3 -m unittest test_byd_bridge)

Covers the Panoptes topic mapping (`surfmate/vehicle/telemetry/<field>`), that
vehicle commands are refused by default, and - with BYD_CONTROL=1 - every
always-on guard (fresh power_level 0, two steps, cooldown, rate limit, unlock
notification, no climate off, confirmed / not confirmed). The MQTT client, the
Telegram notifier and the clock are fakes; nothing leaves the process.
"""

import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = "test-token-not-secret"

# A real sample of the Panoptes topics (read-only, 23.10.2026, Dolphin Surf while DC charging).
# Position fields (location, lat, lon, heading, elevation) are left out on purpose.
PANOPTES_SAMPLE = """
ac_cycle = 1
ac_fan = 2
ac_on = 1
ac_wind = 2
availability = online
batt_12v_level = 65535
cell_t_max = 23.0
cell_t_min = 21.0
charge_power = 0.0
charging_capacity_kwh = 9.072
charging_eta_hours = 0
charging_eta_minutes = 49
charging_state = 1
climate_on = 1
climate_setpoint = 25
climate_setpoint_passenger = 24
consumption_50km = 16.7
door_open_lf = 0
door_open_lr = 0
door_open_rf = 0
door_open_rr = 0
engine_code = NULL
ev_mileage_km = 1048575
ev_range_km = 161
ext_temp = 17.0
gear = P
guard/state = {"armed":false}
health/state = {"ok":true}
hood_open = 0
is_charging = 1
is_dcfc = 1
is_parked = 1
light_hazard = 0
light_high_beam = 0
light_left_turn = -10011
light_right_turn = -10011
odometer = 28015.9
plugged = 1
power = -38.0
power_level = 2
soc = 52.0
soh = 100.0
speed = 0.0
speed_limit_warning = 1
trip_km = 0.0
trip_kwh = 0.0
trunk_open = 0
tyre_leak_fl = 0
tyre_leak_fr = 0
tyre_leak_rl = 0
tyre_leak_rr = 0
tyre_p_fl = 252
tyre_p_fr = 252
tyre_p_rl = 252
tyre_p_rr = 250
tyre_p_state_fl = 0
tyre_p_state_fr = 0
tyre_p_state_rl = 0
tyre_p_state_rr = 0
tyre_t_fl = 20
tyre_t_fr = 22
tyre_t_rl = 17
tyre_t_rr = 18
unlocked_lf = 1
volt_12v = 13.8
"""


def sample_pairs():
    for line in PANOPTES_SAMPLE.strip().splitlines():
        field, _, value = line.partition(" = ")
        yield field.strip(), value.strip()


def load_bridge(**env):
    """Imports byd_bridge.py fresh with exactly these BYD_* settings."""
    for key in list(os.environ):
        if key.startswith("BYD_") or key.startswith("TELEGRAM_"):
            del os.environ[key]
    os.environ["BYD_LOG"] = os.path.join(tempfile.mkdtemp(), "commands.jsonl")
    os.environ["BYD_TOKEN"] = TOKEN
    os.environ.update(env)
    spec = importlib.util.spec_from_file_location("byd_bridge_under_test", os.path.join(HERE, "byd_bridge.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeMqtt:
    """Records publish calls; the bridge must never publish while control is off."""

    def __init__(self):
        self.published = []

    def publish(self, topic, payload, qos=0):
        self.published.append((topic, payload, qos))

        class Info:
            rc = 0
        return Info()


class TopicMappingTest(unittest.TestCase):
    def setUp(self):
        self.b = load_bridge()

    def feed(self, prefix="surfmate/vehicle/telemetry"):
        store = self.b.Store()
        routed = {}
        for field, value in sample_pairs():
            routed[field] = self.b.route_message(prefix + "/" + field, value.encode(), False, store)
        store.refresh(force=True)
        return store, routed

    def test_default_topic_is_panoptes(self):
        self.assertEqual(self.b.TELE, "surfmate/vehicle/telemetry")

    def test_every_field_routed_subtopics_ignored(self):
        store, routed = self.feed()
        self.assertIsNone(routed["guard/state"])
        self.assertIsNone(routed["health/state"])
        self.assertEqual(routed["soc"], "tele")
        self.assertNotIn("guard/state", store.tele)
        self.assertEqual(store.tele["_online"], "online")

    def test_position_never_stored(self):
        store = self.b.Store()
        for field in ("location", "lat", "lon", "heading", "elevation", "vin"):
            self.b.route_message("surfmate/vehicle/telemetry/" + field, b"47.1", False, store)
        for field in ("location", "lat", "lon", "heading", "elevation", "vin"):
            self.assertNotIn(field, store.tele)

    def test_old_overdrive_topic_ignored_by_default(self):
        store = self.b.Store()
        self.assertIsNone(self.b.route_message("overdrive/vehicle/telemetry/soc", b"99", False, store))
        self.assertNotIn("soc", store.tele)

    def test_overdrive_by_env(self):
        b = load_bridge(BYD_TOPIC="overdrive/vehicle/telemetry/")
        store = b.Store()
        self.assertEqual(b.route_message("overdrive/vehicle/telemetry/soc", b"61", False, store), "tele")
        self.assertIsNone(b.route_message("surfmate/vehicle/telemetry/soc", b"61", False, store))
        self.assertEqual(store.tele["soc"], 61.0)

    def test_panoptes_sample_state(self):
        store, _ = self.feed()
        st = store.snapshot()
        self.assertEqual(st["mode"], "charging")
        self.assertEqual(st["battery"]["soc"], 52)
        self.assertEqual(st["battery"]["range_km"], 161)
        self.assertEqual(st["battery"]["soh"], 100.0)
        self.assertEqual(st["battery"]["volt_12v"], 13.8)
        self.assertEqual(st["battery"]["odometer_km"], 28015)
        self.assertEqual((st["battery"]["cell_t_min"], st["battery"]["cell_t_max"]), (21.0, 23.0))
        self.assertEqual(st["charge"]["kw"], 38.0)  # from -power, not charge_power
        self.assertTrue(st["charge"]["dc"])
        self.assertEqual(st["charge"]["eta_min"], 49)
        self.assertEqual(st["charge"]["kwh"], 9.1)
        self.assertEqual(st["drive"]["gear"], "P")
        self.assertEqual(st["drive"]["cons50"], 16.7)
        self.assertFalse(st["drive"]["turn_left"])  # -10011 is "no value"
        body = st["body"]
        self.assertIs(body["locked"], False)  # unlocked_lf = 1
        self.assertIs(body["door_open"], False)
        self.assertIs(body["trunk_open"], False)
        self.assertIs(body["ac_on"], True)
        self.assertEqual(body["ac_fan"], 2)
        self.assertEqual(body["setpoint"], 25.0)
        self.assertEqual(body["ext_temp"], 17.0)
        self.assertEqual(st["tyres"]["rr"], {"kpa": 250, "leak": False, "low": False, "temp": 18})
        # The Dolphin Surf has no cabin sensor: nothing may look like an inside temperature.
        text = json.dumps(st)
        for word in ("inside", "inner", "cabin", "innen"):
            self.assertNotIn(word, text)
        self.assertIsNone(st["position"])

    def test_missing_fields_stay_unknown(self):
        """Another BYD model reporting almost nothing: unknown, never 0 or a warning."""
        store = self.b.Store()
        self.b.route_message("surfmate/vehicle/telemetry/soc", b"70", False, store)
        store.refresh(force=True)
        st = store.snapshot()
        self.assertEqual(st["battery"]["soc"], 70)
        for path in (("drive", "speed"), ("drive", "power_kw"), ("battery", "volt_12v"), ("battery", "odometer_km"),
                     ("body", "locked"), ("body", "door_open"), ("body", "ac_on"), ("body", "ac_fan"),
                     ("body", "ext_temp"), ("tyres", "fl")):
            value = st[path[0]][path[1]]
            if path[0] == "tyres":
                self.assertIsNone(value["kpa"])
                self.assertIsNone(value["temp"])
            else:
                self.assertIsNone(value, path)
        self.assertEqual(st["warnings"], [])

    def test_unlocked_lf_zero_is_locked(self):
        store = self.b.Store()
        self.b.route_message("surfmate/vehicle/telemetry/unlocked_lf", b"0", False, store)
        store.refresh(force=True)
        self.assertIs(store.snapshot()["body"]["locked"], True)


class CommandsRefusedTest(unittest.TestCase):
    def setUp(self):
        self.b = load_bridge()
        self.fake = FakeMqtt()
        self.b.MQTT["client"] = self.fake
        self.b.STORE.mqtt_ok = True
        # A parked car that is off: the most permissive state there is.
        for field, value in (("power_level", b"0"), ("is_parked", b"1"), ("speed", b"0"), ("gear", b"P")):
            self.b.route_message("surfmate/vehicle/telemetry/" + field, value)
        self.b.STORE.refresh(force=True)
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), self.b.Handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.srv.server_address[1]

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def post(self, body, token=TOKEN):
        data = json.dumps(body).encode()
        req = urllib.request.Request(self.base + "/command", data=data, method="POST",
                                     headers={"Content-Type": "text/plain", **({"Authorization": "Bearer " + token} if token else {})})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as err:
            with err:
                return err.code, json.loads(err.read())

    def test_control_off_by_default(self):
        self.assertFalse(self.b.CONTROL)
        st = self.b.STORE.snapshot()
        self.assertFalse(st["control"]["enabled"])
        self.assertFalse(st["control"]["lock"])
        self.assertFalse(st["control"]["unlock"])

    def test_every_command_refused_over_http(self):
        for body in ({"action": "climate_on", "value": 21}, {"action": "climate_off"}, {"action": "lock"},
                     {"action": "unlock"}, {"action": "honk"}):
            status, reply = self.post(body)
            self.assertEqual(status, 403, body)
            self.assertEqual(reply, {"ok": False, "error": "control_disabled"})
        status, reply = self.post({"action": "lock"}, token=None)
        self.assertEqual(status, 403)
        self.assertEqual(self.fake.published, [])
        self.assertIsNone(self.b.STORE.command)

    def test_check_command_refuses_everything(self):
        parked = dict(self.b.STORE.state, _car_off=True, _is_parked=True)
        for action in self.b.ACTIONS:
            self.assertEqual(self.b.check_command({"action": action, "value": 21}, parked, 1e9)[3], "control_disabled")

    def test_state_still_readable(self):
        req = urllib.request.Request(self.base + "/state", headers={"Authorization": "Bearer " + TOKEN})
        with urllib.request.urlopen(req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            self.assertIn("mode", json.loads(resp.read()))

    def test_enabled_only_by_explicit_env(self):
        b = load_bridge(BYD_CONTROL="1")
        self.assertTrue(b.CONTROL)
        b = load_bridge(BYD_CONTROL="yes")
        self.assertFalse(b.CONTROL)


class FakeNotifier:
    """Stands in for Telegram. `events` is shared with FakeMqtt to check the order."""

    def __init__(self, events, configured=True, fail=False):
        self.events = events
        self.ok = configured
        self.fail = fail
        self.sent = []

    def configured(self):
        return self.ok

    def send(self, text):
        if self.fail:
            raise self.error("http_502")
        self.sent.append(text)
        self.events.append(("telegram", text))


class OrderedMqtt(FakeMqtt):
    def __init__(self, events):
        super().__init__()
        self.events = events

    def publish(self, topic, payload, qos=0):
        self.events.append(("mqtt", topic))
        return super().publish(topic, payload, qos)


POWER = "surfmate/vehicle/telemetry/power_level"
SECRET = b"0123456789abcdef-test-secret-not-real"


class ControlEnabledTest(unittest.TestCase):
    """BYD_CONTROL=1: every guard, over HTTP, with fakes only."""

    def setUp(self):
        tmp = tempfile.mkdtemp()
        self.secret_file = os.path.join(tmp, "cmd_secret")
        with open(self.secret_file, "wb") as f:
            f.write(SECRET)
        self.rate_file = os.path.join(tmp, "rate.json")
        self.b = self.load()
        self.start_server()

    def load(self, **extra):
        env = dict(BYD_CONTROL="1", BYD_ALLOW_UNLOCK="1", BYD_PREHEAT="1",
                   BYD_CMD_SECRET_FILE=self.secret_file, BYD_RATE_FILE=self.rate_file)
        env.update(extra)
        b = load_bridge(**env)
        self.events = []
        self.fake = OrderedMqtt(self.events)
        b.MQTT["client"] = self.fake
        b.STORE.mqtt_ok = True
        self.notifier = FakeNotifier(self.events)
        self.notifier.error = b.NotifyError
        b.NOTIFIER = self.notifier
        return b

    def start_server(self):
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), self.b.Handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.srv.server_address[1]

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def restart(self):
        """A bridge restart: new module, new memory, same rate file."""
        self.tearDown()
        self.b = self.load()
        self.start_server()

    def tele(self, field, value, retained=False):
        self.b.route_message("surfmate/vehicle/telemetry/" + field, str(value).encode(), retained)

    def car_off(self):
        self.tele("power_level", 0)
        self.b.STORE.refresh(force=True)

    def post(self, body):
        req = urllib.request.Request(self.base + "/command", data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "text/plain", "Authorization": "Bearer " + TOKEN})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as err:
            with err:
                return err.code, json.loads(err.read())

    def run_command(self, body):
        """Arm, then confirm (the second tap). -> (status, reply) of the step that decided."""
        status, reply = self.post(dict(body, step="arm"))
        if status != 200:
            return status, reply
        return self.post(dict(body, confirm=reply["armed"]))

    def last_log(self):
        with open(os.environ["BYD_LOG"], encoding="utf-8") as f:
            return [json.loads(line) for line in f]

    def test_car_on_refused_with_text(self):
        self.tele("power_level", 2)
        for body in ({"action": "lock"}, {"action": "unlock"}, {"action": "preheat", "minutes": 10}):
            status, reply = self.run_command(body)
            self.assertEqual(status, 403, body)
            self.assertEqual(reply["error"], "car_on")
            self.assertEqual(reply["message"]["de"], "Auto ist an – am Display bedienen")
            self.assertEqual(reply["message"]["en"], "Car is on – use the car's screen")
        self.assertEqual(self.fake.published, [])

    def test_no_power_value_refused(self):
        status, reply = self.run_command({"action": "lock"})
        self.assertEqual((status, reply["error"]), (403, "car_on"))
        self.assertEqual(self.fake.published, [])

    def test_retained_power_never_counts(self):
        self.tele("power_level", 0, retained=True)
        status, reply = self.run_command({"action": "lock"})
        self.assertEqual(reply["error"], "car_on")
        self.assertEqual(self.fake.published, [])

    def test_stale_power_refused(self):
        self.car_off()
        self.b.STORE.power["at"] -= 181
        status, reply = self.run_command({"action": "lock"})
        self.assertEqual(reply["error"], "car_on")
        self.assertEqual(self.fake.published, [])

    def test_power_on_other_topic_does_not_count(self):
        self.b.route_message("overdrive/vehicle/telemetry/power_level", b"0", False)
        self.b.route_message("panoptes/vehicle/telemetry/power_level", b"0", False)
        self.assertEqual(self.run_command({"action": "lock"})[1]["error"], "car_on")

    def test_fresh_off_lock_is_sent_signed(self):
        self.car_off()
        self.assertTrue(self.b.STORE.snapshot()["control"]["car_off"])
        status, reply = self.run_command({"action": "lock"})
        self.assertEqual(status, 202, reply)
        self.assertEqual(reply["command"]["status"], "sent")
        self.assertEqual(len(self.fake.published), 1)
        topic, payload, qos = self.fake.published[0]
        self.assertEqual((topic, qos), ("bydcloud/bydsurf/cmd/signed", 1))
        # pybyd-mqtt's own check accepts it (same secret, fresh, signature ok).
        spec = importlib.util.spec_from_file_location("pybyd_signed_t", os.path.join(HERE, "pybyd_signed.py"))
        signed = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(signed)
        self.assertEqual(signed.verify(payload, secret=SECRET, seen={}), ("lock", ""))

    def test_never_sent_without_second_tap(self):
        self.car_off()
        status, reply = self.post({"action": "lock"})
        self.assertEqual(status, 409)
        status, reply = self.post({"action": "lock", "confirm": "made-up"})
        self.assertEqual((status, reply["error"]), (409, "confirm_expired"))
        self.assertEqual(self.fake.published, [])

    def test_token_bound_to_action_and_single_use(self):
        self.car_off()
        armed = self.post({"action": "lock", "step": "arm"})[1]["armed"]
        status, reply = self.post({"action": "unlock", "confirm": armed})
        self.assertEqual(reply["error"], "confirm_expired")
        status, reply = self.post({"action": "lock", "confirm": armed})
        self.assertEqual(reply["error"], "confirm_expired")  # popped by the wrong try: single use
        self.assertEqual(self.fake.published, [])

    def test_expired_token_refused(self):
        self.car_off()
        armed = self.post({"action": "lock", "step": "arm"})[1]["armed"]
        self.b.STORE.arms[armed]["until"] -= self.b.ARM_TTL_S + 1
        self.assertEqual(self.post({"action": "lock", "confirm": armed})[1]["error"], "confirm_expired")
        self.assertEqual(self.fake.published, [])

    def test_car_switched_on_between_taps(self):
        self.car_off()
        armed = self.post({"action": "lock", "step": "arm"})[1]["armed"]
        self.tele("power_level", 2)
        status, reply = self.post({"action": "lock", "confirm": armed})
        self.assertEqual(reply["error"], "car_on")
        self.assertEqual(self.fake.published, [])

    def test_climate_off_not_possible(self):
        self.car_off()
        for body in ({"action": "climate_off"}, {"action": "climate"}, {"action": "climate_on", "value": 21}):
            status, reply = self.run_command(body)
            self.assertIn(reply["error"], ("not_allowed", "unknown_action"), body)
        self.assertEqual(self.run_command({"action": "climate_off"})[1]["error"], "not_allowed")
        self.assertEqual(self.fake.published, [])

    def test_preheat_duration(self):
        self.car_off()
        for minutes in (5, 9, 31, 45, "20", None, 12.5):
            self.assertEqual(self.run_command({"action": "preheat", "minutes": minutes})[1]["error"], "bad_value", minutes)
        status, reply = self.run_command({"action": "preheat", "minutes": 30})
        self.assertEqual(status, 202, reply)
        topic, payload, _ = self.fake.published[0]
        self.assertEqual(topic, "bydcloud/bydsurf/cmd/signed")
        self.assertEqual((json.loads(payload)["action"], json.loads(payload)["value"]), ("preheat", "30"))

    def test_preheat_needs_pybyd_extension(self):
        self.tearDown()
        self.b = self.load(BYD_PREHEAT="0")
        self.start_server()
        self.car_off()
        self.assertFalse(self.b.STORE.snapshot()["control"]["preheat"])
        self.assertEqual(self.run_command({"action": "preheat", "minutes": 10})[1]["error"], "not_available")

    def test_cooldown(self):
        self.car_off()
        self.assertEqual(self.run_command({"action": "lock"})[0], 202)
        self.tele("unlocked_lf", 0)  # confirmed, so not "busy"
        self.assertEqual(self.b.STORE.command["status"], "confirmed")
        status, reply = self.run_command({"action": "lock"})
        self.assertEqual((status, reply["error"]), (409, "too_fast"))
        self.assertEqual(len(self.fake.published), 1)

    def test_busy_while_waiting_for_confirmation(self):
        self.car_off()
        self.assertEqual(self.run_command({"action": "lock"})[0], 202)
        with open(self.rate_file, "w") as f:
            json.dump({"sent": [time.time() - 60]}, f)  # past the cooldown
        self.assertEqual(self.run_command({"action": "lock"})[1]["error"], "busy")

    def test_rate_limit_persists_across_restart(self):
        now = time.time()
        with open(self.rate_file, "w") as f:
            json.dump({"sent": [now - 3000 + 60 * i for i in range(6)]}, f)
        self.restart()
        self.car_off()
        status, reply = self.run_command({"action": "lock"})
        self.assertEqual((status, reply["error"]), (409, "rate_limit"))
        self.assertEqual(self.fake.published, [])

    def test_rate_counts_and_window(self):
        self.car_off()
        self.assertEqual(self.run_command({"action": "lock"})[0], 202)
        with open(self.rate_file) as f:
            self.assertEqual(len(json.load(f)["sent"]), 1)
        with open(self.rate_file, "w") as f:
            json.dump({"sent": [time.time() - 3700] * 6}, f)  # older than an hour: do not count
        self.b.STORE.command = None
        self.assertEqual(self.run_command({"action": "lock"})[0], 202)

    def test_unreadable_rate_file_blocks(self):
        with open(self.rate_file, "w") as f:
            f.write("{broken")
        self.car_off()
        self.assertEqual(self.run_command({"action": "lock"})[1]["error"], "rate_store")
        self.assertEqual(self.fake.published, [])

    def test_unlock_without_notifier_refused(self):
        self.car_off()
        self.notifier.ok = False
        status, reply = self.run_command({"action": "unlock"})
        self.assertEqual(reply["error"], "no_notifier")
        self.assertEqual(self.fake.published, [])

    def test_unlock_notifier_failure_refused(self):
        self.car_off()
        self.notifier.fail = True
        status, reply = self.run_command({"action": "unlock"})
        self.assertEqual((status, reply["error"]), (503, "notify_failed"))
        self.assertEqual(self.fake.published, [])

    def test_unlock_notifies_first_then_own_topic(self):
        self.car_off()
        status, reply = self.run_command({"action": "unlock"})
        self.assertEqual(status, 202, reply)
        self.assertEqual([e[0] for e in self.events], ["telegram", "mqtt"])
        self.assertIn("Aufsperren", self.notifier.sent[0])
        topic, payload, _ = self.fake.published[0]
        self.assertEqual(topic, "bydcloud/bydsurf/brille/unlock")
        self.assertEqual((json.loads(payload)["action"], json.loads(payload)["value"]), ("unlock", "byd-glass"))

    def test_unlock_needs_env(self):
        self.tearDown()
        self.b = self.load(BYD_ALLOW_UNLOCK="0")
        self.start_server()
        self.car_off()
        self.assertEqual(self.run_command({"action": "unlock"})[1]["error"], "unlock_disabled")
        self.assertEqual(self.notifier.sent, [])

    def test_lock_confirmed_by_fresh_telemetry(self):
        self.car_off()
        self.tele("unlocked_lf", 1)
        self.run_command({"action": "lock"})
        self.tele("unlocked_lf", 0, retained=True)  # a stored value is no proof
        self.assertEqual(self.b.STORE.command["status"], "sent")
        self.tele("unlocked_lf", 1)  # still open
        self.assertEqual(self.b.STORE.command["status"], "sent")
        self.tele("unlocked_lf", 0)
        self.b.STORE.refresh()
        self.assertEqual(self.b.STORE.snapshot()["command"]["status"], "confirmed")

    def test_preheat_confirmed_by_ac_on(self):
        self.car_off()
        self.run_command({"action": "preheat", "minutes": 10})
        self.tele("ac_on", 1)
        self.assertEqual(self.b.STORE.command["status"], "confirmed")

    def test_not_confirmed_after_timeout(self):
        self.car_off()
        self.run_command({"action": "lock"})
        self.b.STORE.command["_sent"] -= self.b.CONFIRM_TIMEOUT_S + 1
        self.b.STORE.refresh()
        self.assertEqual(self.b.STORE.snapshot()["command"]["status"], "not_confirmed")
        self.tele("unlocked_lf", 0)  # too late: stays not confirmed
        self.assertEqual(self.b.STORE.command["status"], "not_confirmed")

    def test_cloud_refusal_is_error_never_success(self):
        self.car_off()
        self.run_command({"action": "unlock"})
        self.b.route_message("bydcloud/bydsurf/klima_status", "✅ 🔓 Aufsperren gesendet".encode(), False)
        self.assertEqual(self.b.STORE.command["status"], "sent")  # accepted by the cloud is not confirmed
        self.b.route_message("bydcloud/bydsurf/klima_status", "⛔ Aufsperren aus der Ferne ist abgeschaltet.".encode(), False)
        self.assertEqual(self.b.STORE.command["status"], "error")
        self.tele("unlocked_lf", 1)
        self.assertEqual(self.b.STORE.command["status"], "error")

    def test_log_has_every_step_and_no_secret(self):
        self.car_off()
        armed = self.post({"action": "lock", "step": "arm"})[1]["armed"]
        self.post({"action": "lock", "confirm": armed})
        self.tele("unlocked_lf", 0)
        self.tele("power_level", 2)
        self.run_command({"action": "lock"})
        rows = self.last_log()
        self.assertEqual([(r["step"], r["result"]) for r in rows],
                         [("arm", "armed"), ("send", "sent"), ("result", "confirmed"), ("arm", "refused")])
        self.assertEqual(rows[-1]["reason"], "car_on")
        for r in rows:
            self.assertIn("time", r)
            self.assertIn("kind", r)
        with open(os.environ["BYD_LOG"], encoding="utf-8") as f:
            text = f.read()
        self.assertNotIn(armed, text)
        self.assertNotIn(SECRET.decode(), text)
        self.assertNotIn(TOKEN, text)
        self.assertNotIn("sig", text)


class TelegramNotifierTest(unittest.TestCase):
    def setUp(self):
        self.b = load_bridge()

    def test_not_configured_without_env(self):
        n = self.b.TelegramNotifier(env_file="")
        self.assertFalse(n.configured())
        with self.assertRaises(self.b.NotifyError):
            n.send("x")

    def test_sends_and_never_leaks_token(self):
        os.environ["TELEGRAM_BOT_TOKEN"] = "123:SECRET-TOKEN"
        os.environ["TELEGRAM_CHAT_ID"] = "42"
        calls = []

        class Resp:
            def __init__(self, body):
                self.body = body

            def read(self):
                return self.body

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def ok(req, timeout):
            calls.append(req.full_url)
            return Resp(b'{"ok":true}')

        n = self.b.TelegramNotifier(env_file="", opener=ok)
        n.send("hi")
        self.assertTrue(calls[0].endswith("/sendMessage"))

        def broken(req, timeout):
            raise OSError("connect to https://api.telegram.org/bot123:SECRET-TOKEN failed")

        n = self.b.TelegramNotifier(env_file="", opener=broken)
        with self.assertRaises(self.b.NotifyError) as ctx:
            n.send("hi")
        self.assertNotIn("SECRET", str(ctx.exception))
        n = self.b.TelegramNotifier(env_file="", opener=lambda req, timeout: Resp(b'{"ok":false}'))
        with self.assertRaises(self.b.NotifyError):
            n.send("hi")

    def test_env_file(self):
        path = os.path.join(tempfile.mkdtemp(), "tg.env")
        with open(path, "w") as f:
            f.write("TELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_CHAT_ID=7\n")
        self.assertTrue(self.b.TelegramNotifier(env_file=path).configured())


class SelfTest(unittest.TestCase):
    def test_selftest_green(self):
        b = load_bridge()
        self.assertEqual(b.selftest(), 0)


if __name__ == "__main__":
    unittest.main()
