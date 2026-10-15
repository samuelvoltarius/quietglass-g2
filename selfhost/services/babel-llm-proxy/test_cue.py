"""Live tip cards of babel_llm_proxy (POST /context/cue), against a fake Shoot Day server and a fake LLM.

    python3 -m pytest test_cue.py      (or: python3 -m unittest test_cue)
Stdlib only, no network beyond 127.0.0.1. Example data only, no real customers.
"""
import json, os, sys, threading, time, unittest, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import babel_llm_proxy as proxy  # noqa: E402

LISTING = {"customers": [{"id": "c_000000000001", "name": "Beispiel Café", "company": "Beispiel Café GmbH"},
                         {"id": "c_000000000002", "name": "Muster Bäckerei", "company": ""}],
           "active": "p_000000000001", "activeCustomer": "c_000000000001"}
BRIEFS = {
    "c_000000000001": {"id": "c_000000000001", "name": "Beispiel Café", "company": "Beispiel Café GmbH", "notes": "",
                       "projects": [], "ideas": [{"text": "Latte-Art in Zeitlupe", "tags": []}]},
    "c_000000000002": {"id": "c_000000000002", "name": "Muster Bäckerei", "company": "", "notes": "",
                       "projects": [], "ideas": [{"text": "Brot aus dem Ofen in Zeitlupe", "tags": []}]},
}
CARD = {"title": "Color Codes präzise anfordern", "text": "Frage nach HEX/RGB und CMYK/Pantone.", "kind": "tipp"}
TRANSCRIPT = "B: Unser Logo ist so ein Orange. A: Habt ihr dazu genaue Farbwerte? B: Die Agentur hat das irgendwo."


class FakeShoot(BaseHTTPRequestHandler):
    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
        self.end_headers(); self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/api/customers": return self._send(200, LISTING)
        for cid, brief in BRIEFS.items():
            if self.path == "/api/customers/%s/brief" % cid: return self._send(200, brief)
        self._send(404, {})

    def log_message(self, *a): pass


class FakeLlm(BaseHTTPRequestHandler):
    answer = json.dumps(CARD, ensure_ascii=False)
    delay = 0.0
    bodies = []

    def do_GET(self):
        raw = json.dumps({"data": [{"id": "fake-model"}]}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        FakeLlm.bodies.append(body)
        if FakeLlm.delay: time.sleep(FakeLlm.delay)
        raw = json.dumps({"choices": [{"message": {"content": FakeLlm.answer}}]}).encode()
        try:
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
            self.end_headers(); self.wfile.write(raw)
        except OSError:
            pass  # the proxy gave up already

    def log_message(self, *a): pass


def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, "http://127.0.0.1:%d" % server.server_address[1]


class CueTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shoot, cls.shoot_url = serve(FakeShoot)
        cls.llm, cls.llm_url = serve(FakeLlm)
        cls.proxy, cls.proxy_url = serve(proxy.H)

    @classmethod
    def tearDownClass(cls):
        for s in (cls.shoot, cls.llm, cls.proxy): s.shutdown(); s.server_close()

    def setUp(self):
        self.saved = (proxy.SHOOT_URL, proxy.SHOOT_TIMEOUT, proxy.UP, proxy.TOKEN, proxy.CUE_TIMEOUT)
        proxy.SHOOT_URL, proxy.SHOOT_TIMEOUT, proxy.UP, proxy.TOKEN = self.shoot_url, 2.0, self.llm_url, ""
        proxy._shoot_cache.clear(); proxy._model_cache.clear()
        FakeLlm.answer, FakeLlm.delay, FakeLlm.bodies = json.dumps(CARD, ensure_ascii=False), 0.0, []

    def tearDown(self):
        (proxy.SHOOT_URL, proxy.SHOOT_TIMEOUT, proxy.UP, proxy.TOKEN, proxy.CUE_TIMEOUT) = self.saved
        proxy._shoot_cache.clear(); proxy._model_cache.clear()

    def post(self, body, headers=None):
        h = {"Content-Type": "application/json"}; h.update(headers or {})
        req = urllib.request.Request(self.proxy_url + "/context/cue", json.dumps(body).encode(), h, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=15) as r: return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    # ---- one card
    def test_one_card_with_customer_context(self):
        code, body = self.post({"transcript": TRANSCRIPT, "recent_titles": ["Hero-Produkte abfragen"]})
        self.assertEqual(code, 200)
        self.assertEqual(body, {"cue": CARD})
        sent = FakeLlm.bodies[0]
        self.assertEqual(sent["temperature"], 0.3)
        self.assertEqual(sent["max_tokens"], 120)
        self.assertIs(sent["stream"], False)
        self.assertEqual(sent["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(sent["model"], "fake-model")
        system = sent["messages"][0]["content"]
        self.assertIn("HÖCHSTENS EINE", system)
        self.assertIn("Kunde: Beispiel Café", system)  # Shoot Day's active customer
        self.assertIn("Hero-Produkte abfragen", system)  # recent titles go into the prompt too
        self.assertEqual(sent["messages"][1]["content"], TRANSCRIPT)

    def test_customer_header_and_body_override(self):
        self.post({"transcript": TRANSCRIPT}, {"X-Babel-Customer": "c_000000000002"})
        self.assertIn("Kunde: Muster Bäckerei", FakeLlm.bodies[-1]["messages"][0]["content"])
        self.post({"transcript": TRANSCRIPT, "customer": "c_000000000001"}, {"X-Babel-Customer": "c_000000000002"})
        self.assertIn("Kunde: Beispiel Café", FakeLlm.bodies[-1]["messages"][0]["content"])
        self.post({"transcript": TRANSCRIPT}, {"X-Babel-Customer": "-"})
        self.assertNotIn("Gesprächskontext", FakeLlm.bodies[-1]["messages"][0]["content"])

    def test_transcript_capped_to_newest(self):
        long = "A: alt " * 2000 + "B: neu am Ende"
        self.post({"transcript": long})
        sent = FakeLlm.bodies[-1]["messages"][1]["content"]
        self.assertLessEqual(len(sent), proxy.CUE_TRANSCRIPT_MAX)
        self.assertTrue(sent.endswith("B: neu am Ende"))

    def test_clips_title_and_text_and_unknown_kind(self):
        FakeLlm.answer = json.dumps({"title": "T" * 80, "text": "x " * 200, "kind": "egal"})
        code, body = self.post({"transcript": TRANSCRIPT})
        self.assertEqual(code, 200)
        self.assertLessEqual(len(body["cue"]["title"]), 40)
        self.assertLessEqual(len(body["cue"]["text"]), 140)
        self.assertEqual(body["cue"]["kind"], "tipp")

    # ---- nothing
    def test_none(self):
        FakeLlm.answer = '{"none":true}'
        self.assertEqual(self.post({"transcript": TRANSCRIPT}), (200, {"none": True}))

    def test_malformed_is_none(self):
        for bad in ("kein json", "{kaputt", "[1,2]", '{"title":"","text":"x"}', '{"title":"x"}', "<think>{\"title\":\"a\"}</think>"):
            FakeLlm.answer = bad
            self.assertEqual(self.post({"transcript": TRANSCRIPT}), (200, {"none": True}), bad)

    def test_repeat_filtered(self):
        for recent in (["Color Codes präzise anfordern"], ["color codes präzise anfordern!"], ["Color Codes präzise anfordern – HEX"]):
            self.assertEqual(self.post({"transcript": TRANSCRIPT, "recent_titles": recent}), (200, {"none": True}), recent)
        self.assertIsNone(proxy.cue_parse(json.dumps(CARD), ["Color Codes prazise anfordern"]))  # fuzzy
        self.assertIsNotNone(proxy.cue_parse(json.dumps(CARD), ["Donnerstag ideal für Bäckereidreh", 5, None]))

    def test_bad_requests(self):
        self.assertEqual(self.post({"transcript": "  "})[0], 400)
        self.assertEqual(self.post({"text": TRANSCRIPT})[0], 400)
        self.assertEqual(self.post({"transcript": TRANSCRIPT, "recent_titles": "kein array"})[0], 200)

    def test_auth(self):
        proxy.TOKEN = "geheim"
        self.assertEqual(self.post({"transcript": TRANSCRIPT})[0], 401)
        self.assertEqual(self.post({"transcript": TRANSCRIPT}, {"Authorization": "Bearer geheim"})[0], 200)

    # ---- timeout / failure
    def test_timeout(self):
        proxy.CUE_TIMEOUT = 0.5
        FakeLlm.delay = 1.5
        started = time.monotonic()
        code, body = self.post({"transcript": TRANSCRIPT})
        self.assertEqual(code, 504)
        self.assertEqual(body, {"none": True, "error": "timeout"})
        self.assertLess(time.monotonic() - started, 1.4)

    def test_llm_failure(self):
        proxy.UP = "http://127.0.0.1:9"  # nothing listens there
        proxy._model_cache.append("fake-model")
        code, body = self.post({"transcript": TRANSCRIPT})
        self.assertEqual(code, 502)
        self.assertTrue(body["none"])

    def test_works_without_shoot_day(self):
        proxy.SHOOT_URL = ""
        code, body = self.post({"transcript": TRANSCRIPT})
        self.assertEqual((code, body), (200, {"cue": CARD}))
        self.assertNotIn("Gesprächskontext", FakeLlm.bodies[-1]["messages"][0]["content"])

    # ---- summary: the app's cards never reach the Shoot Day filing
    def test_summary_transcript_drops_cards(self):
        messages = [{"role": "system", "content": "Du fasst ein mitgeschriebenes Gespräch"},
                    {"role": "user", "content": TRANSCRIPT + "\n\nTipp-Karten während des Gesprächs (Hinweise der Brille, nicht gesagt):\n- 10:02 Color Codes präzise anfordern"}]
        self.assertEqual(proxy.summary_transcript(messages), TRANSCRIPT)
        messages[1]["content"] = TRANSCRIPT
        self.assertEqual(proxy.summary_transcript(messages), TRANSCRIPT)


if __name__ == "__main__":
    unittest.main()
