"""Talk record of babel_llm_proxy: after a summary call, the summary text and the conversation's tip cards are
posted once to Shoot Day's POST /api/projects/<id>/talks (against a fake Shoot Day server and a fake LLM).

    python3 -m pytest test_shoot_talks.py      (or: python3 -m unittest test_shoot_talks)
Stdlib only, no network beyond 127.0.0.1. Example data only, no real customers.
"""
import json, os, sys, threading, time, unittest, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import babel_llm_proxy as proxy  # noqa: E402

LISTING = {
    "customers": [
        {"id": "c_000000000001", "name": "Beispiel Café", "company": "Beispiel Café GmbH"},
        {"id": "unassigned", "name": "Ohne Zuordnung", "unassigned": True},
    ],
    "active": "p_000000000001",
    "activeCustomer": "c_000000000001",
}
BRIEF = {"id": "c_000000000001", "name": "Beispiel Café", "projects": [{"id": "p_000000000001", "name": "Imagefilm", "date": "2026-10-14"}]}
SUMMARY_SYSTEM = "Du fasst ein mitgeschriebenes Gespräch auf Deutsch zusammen. Antworte NUR mit JSON."
TRANSCRIPT = "B: Die Drohne finde ich zu laut. A: Verstehe. B: Lieber soll unser Barista die Bohnen erklären."
CARDS = ("\n\nTipp-Karten während des Gesprächs (Hinweise der Brille, nicht gesagt):\n"
         "- 10:02 Color Codes präzise anfordern: Frage nach HEX/RGB und Pantone.\n"
         "- 10:07 Drehgenehmigung: Für Drohnen braucht es meist eine Genehmigung.")
ANSWER = json.dumps({"kurz": "Barista statt Drohne", "lang": "- Barista erklärt die Bohnen\n- Keine Drohne",
                     "abmachungen": "Angebot bis Freitag"}, ensure_ascii=False)
SUMMARY = "- Barista erklärt die Bohnen\n- Keine Drohne\n\nAbmachungen:\nAngebot bis Freitag"


class FakeShoot(BaseHTTPRequestHandler):
    posts = []
    fail = False
    listing = LISTING

    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
        self.end_headers(); self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/api/customers": return self._send(200, FakeShoot.listing)
        if self.path == "/api/customers/c_000000000001/brief": return self._send(200, BRIEF)
        self._send(404, {})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        FakeShoot.posts.append((self.path, body, self.headers.get("Authorization")))
        if FakeShoot.fail: return self._send(500, {"error": "boom"})
        if self.path != "/api/projects/p_000000000001/talks": return self._send(404, {})
        self._send(200, {"ok": True, "id": "t_000000000001", "count": len(FakeShoot.posts)})

    def log_message(self, *a): pass


class FakeLlm(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def do_GET(self):
        raw = json.dumps({"data": [{"id": "fake-model"}]}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        system = body["messages"][0]["content"]
        content = ANSWER if system.startswith(SUMMARY_SYSTEM) else "{\"keine\":true}"
        if "Du liest die Mitschrift" in system: content = "{}"
        if body.get("stream"):
            self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
            for i in range(0, len(content), 7):
                chunk = {"choices": [{"delta": {"content": content[i:i + 7]}}]}
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode()); self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            return
        raw = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
        self.end_headers(); self.wfile.write(raw)

    def log_message(self, *a): pass


def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, "http://127.0.0.1:%d" % server.server_address[1]


class TalkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shoot, cls.shoot_url = serve(FakeShoot)
        cls.llm, cls.llm_url = serve(FakeLlm)
        cls.proxy, cls.proxy_url = serve(proxy.H)

    @classmethod
    def tearDownClass(cls):
        for s in (cls.shoot, cls.llm, cls.proxy): s.shutdown(); s.server_close()

    def setUp(self):
        self.saved = (proxy.SHOOT_URL, proxy.SHOOT_TOKEN, proxy.SHOOT_TIMEOUT, proxy.SHOOT_FEEDBACK, proxy.SHOOT_TALKS, proxy.UP, proxy.TOKEN)
        proxy.SHOOT_URL, proxy.SHOOT_TOKEN, proxy.SHOOT_TIMEOUT = self.shoot_url, "sd-token", 2.0
        proxy.SHOOT_FEEDBACK, proxy.SHOOT_TALKS = False, True   # only the talk record here
        proxy.UP, proxy.TOKEN = self.llm_url, ""
        proxy._shoot_cache.clear(); proxy._talk_seen.clear()
        FakeShoot.posts, FakeShoot.fail, FakeShoot.listing = [], False, LISTING

    def tearDown(self):
        (proxy.SHOOT_URL, proxy.SHOOT_TOKEN, proxy.SHOOT_TIMEOUT, proxy.SHOOT_FEEDBACK, proxy.SHOOT_TALKS, proxy.UP, proxy.TOKEN) = self.saved
        proxy._shoot_cache.clear(); proxy._talk_seen.clear()

    def _post(self, body):
        req = urllib.request.Request(self.proxy_url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r: return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def _summary(self, stream=False, cards=True):
        return self._post({"model": "m", "stream": stream, "messages": [
            {"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": TRANSCRIPT + (CARDS if cards else "")}]})

    def _wait(self, n, timeout=5.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end and len(FakeShoot.posts) < n: time.sleep(0.02)
        time.sleep(0.1)

    # ---- parsing
    def test_cards_from_summary_request(self):
        cards = proxy.summary_cards([{"role": "system", "content": "x"}, {"role": "user", "content": TRANSCRIPT + CARDS}])
        self.assertEqual(cards, [
            {"title": "Color Codes präzise anfordern", "text": "Frage nach HEX/RGB und Pantone.", "kind": "tipp"},
            {"title": "Drehgenehmigung", "text": "Für Drohnen braucht es meist eine Genehmigung.", "kind": "tipp"}])
        self.assertEqual(proxy.summary_cards([{"role": "user", "content": TRANSCRIPT}]), [])
        english = "\n\nTip cards during the conversation (hints shown on the glasses, not said):\n- 09:01 Ask for the logo"
        self.assertEqual(proxy.summary_cards([{"role": "user", "content": "x" + english}]), [{"title": "", "text": "Ask for the logo", "kind": "tipp"}])

    def test_summary_text(self):
        self.assertEqual(proxy.summary_text(ANSWER), SUMMARY)
        self.assertEqual(proxy.summary_text('{"kurz":"Nur kurz","lang":"","abmachungen":""}'), "Nur kurz")
        self.assertEqual(proxy.summary_text("einfach Text"), "einfach Text")

    # ---- over HTTP
    def test_posts_once_after_summary(self):
        code, body = self._summary()
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["choices"][0]["message"]["content"], ANSWER)
        self._wait(1)
        self.assertEqual(len(FakeShoot.posts), 1)
        path, sent, auth = FakeShoot.posts[0]
        self.assertEqual(path, "/api/projects/p_000000000001/talks")
        self.assertEqual(auth, "Bearer sd-token")
        self.assertEqual(sent["summary"], SUMMARY)
        self.assertEqual([c["title"] for c in sent["cues"]], ["Color Codes präzise anfordern", "Drehgenehmigung"])
        self.assertIsInstance(sent["at"], int)
        self._summary(); self._wait(2, 0.8)
        self.assertEqual(len(FakeShoot.posts), 1, "the same summary again is not recorded twice")

    def test_streamed_summary(self):
        code, body = self._summary(stream=True, cards=False)
        self.assertEqual(code, 200)
        self.assertIn("data: [DONE]", body)
        self._wait(1)
        self.assertEqual(len(FakeShoot.posts), 1)
        self.assertEqual(FakeShoot.posts[0][1]["summary"], SUMMARY)
        self.assertEqual(FakeShoot.posts[0][1]["cues"], [])

    def test_not_for_reply_calls_or_when_off(self):
        self._post({"model": "m", "messages": [{"role": "system", "content": "Du hilfst jemandem live in einem Gespräch"},
                                               {"role": "user", "content": TRANSCRIPT}]})
        proxy.SHOOT_TALKS = False
        self._summary(); self._wait(1, 0.8)
        self.assertEqual(FakeShoot.posts, [])

    def test_no_customer_nothing_posted(self):
        FakeShoot.listing = dict(LISTING, activeCustomer="")
        self._summary(); self._wait(1, 0.8)
        self.assertEqual(FakeShoot.posts, [])

    def test_summary_survives_shoot_day_failure_and_retries_later(self):
        FakeShoot.fail = True
        code, _ = self._summary()
        self.assertEqual(code, 200)
        self._wait(1)
        self.assertEqual(len(FakeShoot.posts), 1)
        FakeShoot.fail = False
        self._summary(); self._wait(2)
        self.assertEqual(len(FakeShoot.posts), 2, "a failed post frees the summary for the next try")


if __name__ == "__main__":
    unittest.main()
