"""GET /context/customers of babel_llm_proxy (Babel Glass 0.7.0 start screen), against a fake Shoot Day.

    python3 -m unittest test_shoot_customers
Stdlib only, no network beyond 127.0.0.1. Fictitious names only.
"""
import json, os, sys, threading, time, unittest, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import babel_llm_proxy as proxy  # noqa: E402

TODAY = time.strftime("%Y-%m-%d")
CUSTOMERS = {
    "customers": [
        {"id": "c_1", "name": "Zeta Werkstatt", "company": ""},
        {"id": "c_2", "name": "Alpha Studio", "company": "Alpha Studio KG"},
        {"id": "c_3", "name": "Beispiel Café", "company": "Beispiel Café GmbH"},
        {"id": "c_4", "name": "Muster Bäckerei", "company": ""},
        {"id": "unassigned", "name": "Ohne Zuordnung", "unassigned": True},
    ],
    "activeCustomer": "c_3",
}
PROJECTS = {"projects": [
    {"id": "p_1", "customerId": "c_1", "name": "Werkstatt-Reel", "date": TODAY + " 14:30"},
    {"id": "p_2", "customerId": "c_3", "name": "Imagefilm", "date": TODAY + " 09:00"},
    {"id": "p_3", "customerId": "c_3", "name": "Nachdreh", "date": "2099-01-02"},
    {"id": "p_4", "customerId": "c_2", "name": "Altes Projekt", "date": "2000-01-01"},
    {"id": "p_5", "customerId": "c_4", "name": "Brot-Reel", "date": "02.01.2099, 10.15"},
    {"id": "p_6", "customerId": "unassigned", "name": "Lose", "date": TODAY},
]}


class FakeShoot(BaseHTTPRequestHandler):
    delay = 0.0
    calls = []
    down = False

    def do_GET(self):
        FakeShoot.calls.append(self.path)
        if FakeShoot.delay: time.sleep(FakeShoot.delay)
        body = {"/api/customers": CUSTOMERS, "/api/projects": PROJECTS}.get(self.path)
        if body is None or FakeShoot.down:
            self.send_response(404 if body is None else 500); self.end_headers(); return
        raw = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try: self.wfile.write(raw)
        except OSError: pass

    def do_POST(self):
        self.send_response(405); self.end_headers()

    def log_message(self, *a): pass


def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, "http://127.0.0.1:%d" % server.server_address[1]


class ShootCustomersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shoot, cls.shoot_url = serve(FakeShoot)

    @classmethod
    def tearDownClass(cls):
        cls.shoot.shutdown(); cls.shoot.server_close()

    def setUp(self):
        self.saved = (proxy.SHOOT_URL, proxy.SHOOT_TIMEOUT, proxy.TOKEN)
        proxy.SHOOT_URL, proxy.SHOOT_TIMEOUT, proxy.TOKEN = self.shoot_url, 2.0, ""
        proxy._shoot_cache.clear()
        FakeShoot.delay, FakeShoot.calls, FakeShoot.down = 0.0, [], False

    def tearDown(self):
        proxy.SHOOT_URL, proxy.SHOOT_TIMEOUT, proxy.TOKEN = self.saved
        proxy._shoot_cache.clear()

    def get(self, path, token=None):
        server, base = serve(proxy.H)
        try:
            headers = {"Authorization": "Bearer " + token} if token else {}
            with urllib.request.urlopen(urllib.request.Request(base + path, headers=headers), timeout=5) as r:
                return r.status, json.loads(r.read()), r.headers
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}"), e.headers
        finally:
            server.shutdown(); server.server_close()

    def test_list_order_today_first_then_by_name(self):
        code, body, headers = self.get("/context/customers")
        self.assertEqual(code, 200)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
        self.assertTrue(body["enabled"])
        self.assertEqual([c["id"] for c in body["customers"]], ["c_3", "c_1", "c_2", "c_4"])
        first = body["customers"][0]
        self.assertEqual(first, {"id": "c_3", "name": "Beispiel Café", "company": "Beispiel Café GmbH",
                                 "next": {"date": TODAY + " 09:00", "name": "Imagefilm"}})
        by_id = {c["id"]: c for c in body["customers"]}
        self.assertIsNone(by_id["c_2"]["next"])  # only past projects
        self.assertEqual(by_id["c_4"]["next"], {"date": "2099-01-02 10:15", "name": "Brot-Reel"})
        self.assertNotIn("unassigned", by_id)

    def test_also_under_v1_and_cached_60s(self):
        self.get("/v1/context/customers")
        self.get("/context/customers")
        self.assertEqual(FakeShoot.calls.count("/api/customers"), 1)

    def test_needs_token(self):
        proxy.TOKEN = "geheim"
        self.assertEqual(self.get("/context/customers")[0], 401)
        self.assertEqual(self.get("/context/customers", token="geheim")[0], 200)

    def test_shoot_day_down_is_502_with_empty_list(self):
        FakeShoot.down = True
        code, body, _ = self.get("/context/customers")
        self.assertEqual((code, body["customers"]), (502, []))

    def test_timeout_after_two_seconds(self):
        FakeShoot.delay, proxy.SHOOT_TIMEOUT = 1.0, 0.3
        started = time.monotonic()
        code, _, _ = self.get("/context/customers")
        self.assertEqual(code, 502)
        self.assertLess(time.monotonic() - started, 1.5)

    def test_off_without_shoot_url(self):
        proxy.SHOOT_URL = ""
        code, body, _ = self.get("/context/customers")
        self.assertEqual((code, body["enabled"], body["customers"]), (200, False, []))


if __name__ == "__main__":
    unittest.main()
