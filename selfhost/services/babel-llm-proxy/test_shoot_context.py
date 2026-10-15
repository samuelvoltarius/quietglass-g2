"""Shoot Day customer context of babel_llm_proxy, against a fake Shoot Day server and a fake LLM.

    python3 -m pytest test_shoot_context.py      (or: python3 -m unittest test_shoot_context)
Stdlib only, no network beyond 127.0.0.1.
"""
import json, os, sys, threading, time, unittest, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import babel_llm_proxy as proxy  # noqa: E402

CUSTOMERS = {
    "customers": [
        {"id": "c_000000000001", "name": "Beispiel Café", "company": "Beispiel Café GmbH"},
        {"id": "c_000000000002", "name": "Muster Bäckerei", "company": ""},
        {"id": "unassigned", "name": "Ohne Zuordnung", "unassigned": True},
    ],
    "active": "p_000000000001",
    "activeCustomer": "c_000000000001",
}
BRIEFS = {
    "c_000000000001": {
        "id": "c_000000000001", "name": "Beispiel Café", "company": "Beispiel Café GmbH", "phone": "", "email": "",
        "notes": "Mag warme Farben, kein Drohnenlärm am Vormittag.",
        "projects": [{"id": "p_000000000001", "name": "Imagefilm Frühstück", "date": "2026-10-14"}],
        "ideas": [{"text": "Latte-Art in Zeitlupe", "tags": ["zeitlupe", "detail"], "project": "Imagefilm Frühstück"}],
    },
    "c_000000000002": {
        "id": "c_000000000002", "name": "Muster Bäckerei", "company": "", "notes": "",
        "projects": [{"id": "p_000000000002", "name": "Brot-Reel", "date": "2026-11-02"}],
        "ideas": [{"text": "Mehlstaub im Gegenlicht", "tags": ["licht"], "project": "Brot-Reel"}],
    },
}
PROJECTS = {
    "p_000000000001": {
        "id": "p_000000000001", "name": "Imagefilm Frühstück", "date": "2026-10-14", "place": "Beispielgasse 1",
        "prompter": "Guten Morgen im Beispiel Café. Hier beginnt der Tag mit frischem Kaffee.",
        "storyboards": [{"title": "Morgenroutine", "scenes": [
            {"n": 1, "title": "Ankunft", "content": "Tür geht auf, Licht fällt herein.", "camera": "Totale", "overlay": "Dein Morgen beginnt hier", "goal": ""},
            {"n": 2, "title": "Siebträger", "content": "Nah am Siebträger.", "camera": "Nah", "overlay": "", "goal": ""},
        ]}],
    },
    "p_000000000002": {"id": "p_000000000002", "name": "Brot-Reel", "date": "2026-11-02", "place": "", "prompter": "", "storyboards": []},
}


class FakeShoot(BaseHTTPRequestHandler):
    delay = 0.0
    customers = CUSTOMERS
    calls = []
    writes = []

    def do_GET(self):
        FakeShoot.calls.append((self.path, self.headers.get("Authorization")))
        if FakeShoot.delay: time.sleep(FakeShoot.delay)
        parts = self.path.strip("/").split("/")
        if self.path == "/api/customers": body = FakeShoot.customers
        elif len(parts) == 4 and parts[1] == "customers" and parts[3] == "brief" and parts[2] in BRIEFS: body = BRIEFS[parts[2]]
        elif len(parts) == 3 and parts[1] == "projects" and parts[2] in PROJECTS: body = PROJECTS[parts[2]]
        else:
            self.send_response(404); self.end_headers(); return
        raw = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try: self.wfile.write(raw)
        except OSError: pass

    def do_POST(self):  # the proxy must never write to Shoot Day
        FakeShoot.writes.append(self.path); self.send_response(405); self.end_headers()

    def log_message(self, *a): pass


class FakeLlm(BaseHTTPRequestHandler):
    bodies = []

    def do_POST(self):
        FakeLlm.bodies.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        raw = json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
        self.end_headers(); self.wfile.write(raw)

    def log_message(self, *a): pass


def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, "http://127.0.0.1:%d" % server.server_address[1]


REPLY_SYSTEM = "Du hilfst jemandem live in einem Gespräch (Mitschrift per Spracherkennung, kann Hörfehler enthalten). Antworte genau -"
WORD_SYSTEM = "Der Sprecher sucht ein Wort. Gib das wahrscheinlich gesuchte Wort."
SUMMARY_SYSTEM = "Du fasst ein mitgeschriebenes Gespräch auf Deutsch zusammen. Antworte NUR mit JSON."
TRANSLATE_SYSTEM = "Translate from German to English. Output only the translation."


class ShootContextTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shoot, cls.shoot_url = serve(FakeShoot)
        cls.llm, cls.llm_url = serve(FakeLlm)

    @classmethod
    def tearDownClass(cls):
        cls.shoot.shutdown(); cls.shoot.server_close(); cls.llm.shutdown(); cls.llm.server_close()

    def setUp(self):
        self.saved = (proxy.SHOOT_URL, proxy.SHOOT_TOKEN, proxy.SHOOT_TIMEOUT, proxy.UP, proxy.TOKEN)
        self.saved_feedback = proxy.SHOOT_FEEDBACK
        proxy.SHOOT_FEEDBACK = False  # the write path has its own tests (test_shoot_feedback.py)
        proxy.SHOOT_URL, proxy.SHOOT_TOKEN, proxy.SHOOT_TIMEOUT = self.shoot_url, "", 2.0
        proxy.UP, proxy.TOKEN = self.llm_url, ""
        proxy._shoot_cache.clear()
        FakeShoot.delay, FakeShoot.customers, FakeShoot.calls, FakeShoot.writes = 0.0, CUSTOMERS, [], []
        FakeLlm.bodies = []

    def tearDown(self):
        proxy.SHOOT_URL, proxy.SHOOT_TOKEN, proxy.SHOOT_TIMEOUT, proxy.UP, proxy.TOKEN = self.saved
        proxy.SHOOT_FEEDBACK = self.saved_feedback
        proxy._shoot_cache.clear()

    # ---- picking the customer
    def test_active_customer_is_default(self):
        ctx = proxy.shoot_context()
        self.assertEqual(ctx["name"], "Beispiel Café")
        self.assertIn("Projekt: Imagefilm Frühstück · 2026-10-14 · Beispielgasse 1", ctx["text"])
        self.assertIn("Latte-Art in Zeitlupe #zeitlupe #detail", ctx["text"])
        self.assertIn("[Morgenroutine]", ctx["text"])
        self.assertIn("1. Ankunft: Tür geht auf", ctx["text"])
        self.assertIn("Einblendungen/Slogans: Dein Morgen beginnt hier", ctx["text"])
        self.assertIn("Skript (Anfang): Guten Morgen", ctx["text"])
        self.assertEqual((ctx["ideas"], ctx["storyboards"]), (1, 1))
        self.assertEqual(FakeShoot.writes, [])

    def test_override_by_id_and_name(self):
        self.assertEqual(proxy.shoot_context("c_000000000002")["name"], "Muster Bäckerei")
        ctx = proxy.shoot_context("muster bäckerei")
        self.assertEqual(ctx["name"], "Muster Bäckerei")
        self.assertIn("Mehlstaub im Gegenlicht #licht", ctx["text"])
        self.assertEqual(proxy.shoot_context("Bäckerei")["name"], "Muster Bäckerei")  # part of the name
        self.assertIsNone(proxy.shoot_context("gibt es nicht"))
        self.assertIsNone(proxy.shoot_context("-"))

    def test_unassigned_is_skipped(self):
        FakeShoot.customers = dict(CUSTOMERS, activeCustomer="unassigned")
        self.assertIsNone(proxy.shoot_context())
        proxy._shoot_cache.clear()
        self.assertIsNone(proxy.shoot_context("Ohne Zuordnung"))
        self.assertIsNone(proxy.shoot_pick({"customers": [{"id": "c_9", "name": "Unassigned"}], "activeCustomer": "c_9"}))

    def test_token_is_sent(self):
        proxy.SHOOT_TOKEN = "t-123"
        proxy.shoot_context()
        self.assertTrue(FakeShoot.calls and all(auth == "Bearer t-123" for _, auth in FakeShoot.calls))

    def test_cache_60s(self):
        proxy.shoot_context(); n = len(FakeShoot.calls)
        proxy.shoot_context()
        self.assertEqual(len(FakeShoot.calls), n)

    # ---- size
    def test_size_cap(self):
        brief = dict(BRIEFS["c_000000000001"], ideas=[{"text": "Idee %d " % i + "x" * 150, "tags": ["t"]} for i in range(40)])
        board = {"title": "Lang", "scenes": [{"n": i, "title": "Szene %d" % i, "content": "y" * 300, "overlay": "Slogan %d" % i} for i in range(40)]}
        project = dict(PROJECTS["p_000000000001"], storyboards=[board] * 6, prompter="z" * 5000)
        text = proxy.shoot_block(brief, project)
        self.assertLessEqual(len(text), proxy.SHOOT_MAX_CHARS)
        self.assertTrue(text.startswith("Kunde: Beispiel Café (Beispiel Café GmbH)"))
        self.assertLessEqual(len(proxy.shoot_block(BRIEFS["c_000000000001"], PROJECTS["p_000000000001"])), 2500)
        script = proxy.shoot_block({"name": "Beispiel Café"}, {"name": "x", "prompter": "w " * 2000})
        self.assertLessEqual(len(script.split("Skript (Anfang): ")[1]), 600)

    # ---- failures never break Babel
    def test_timeout_omits_context(self):
        FakeShoot.delay = 1.0
        proxy.SHOOT_TIMEOUT = 0.3
        start = time.monotonic()
        self.assertIsNone(proxy.shoot_context())
        self.assertLess(time.monotonic() - start, 0.9)
        d = {"messages": [{"role": "system", "content": REPLY_SYSTEM}, {"role": "user", "content": "B: Was kostet das?"}]}
        proxy._shoot_cache.clear()
        self.assertIsNone(proxy.shoot_inject(d))
        self.assertEqual(d["messages"][0]["content"], REPLY_SYSTEM)

    def test_server_down_omits_context(self):
        proxy.SHOOT_URL = "http://127.0.0.1:9"  # nothing listens there
        self.assertIsNone(proxy.shoot_context())

    def test_off_without_url(self):
        proxy.SHOOT_URL = ""
        d = {"messages": [{"role": "system", "content": REPLY_SYSTEM}]}
        self.assertIsNone(proxy.shoot_inject(d))
        self.assertEqual(FakeShoot.calls, [])

    # ---- injection into the prompts (through the real proxy HTTP handler)
    def _chat(self, body, headers=None):
        server, base = serve(proxy.H)
        try:
            req = urllib.request.Request(base + "/v1/chat/completions", json.dumps(body).encode(),
                                         dict({"Content-Type": "application/json"}, **(headers or {})))
            with urllib.request.urlopen(req, timeout=10) as r:
                self.assertEqual(r.status, 200)
        finally:
            server.shutdown(); server.server_close()
        return FakeLlm.bodies[-1]

    def test_injected_into_reply_word_summary(self):
        for system in (REPLY_SYSTEM, WORD_SYSTEM, SUMMARY_SYSTEM):
            sent = self._chat({"model": "m", "messages": [{"role": "system", "content": system}, {"role": "user", "content": "B: Hallo"}]})
            content = sent["messages"][0]["content"]
            self.assertTrue(content.startswith(system))
            self.assertIn("Gesprächskontext (Kunde):\nKunde: Beispiel Café", content)
            self.assertIn("erfinde nichts dazu", content)
            self.assertEqual(sent["messages"][1]["content"], "B: Hallo")

    def test_translation_untouched(self):
        sent = self._chat({"model": "m", "messages": [{"role": "system", "content": TRANSLATE_SYSTEM}, {"role": "user", "content": "Hallo"}]})
        self.assertEqual(sent["messages"][0]["content"], TRANSLATE_SYSTEM)

    def test_override_field_and_header_not_forwarded(self):
        sent = self._chat({"model": "m", "customer": "Muster Bäckerei",
                           "messages": [{"role": "system", "content": REPLY_SYSTEM}, {"role": "user", "content": "B: Hallo"}]})
        self.assertNotIn("customer", sent)
        self.assertIn("Kunde: Muster Bäckerei", sent["messages"][0]["content"])
        sent = self._chat({"model": "m", "messages": [{"role": "system", "content": WORD_SYSTEM}, {"role": "user", "content": "x"}]},
                          {"X-Babel-Customer": "c_000000000002"})
        self.assertIn("Kunde: Muster Bäckerei", sent["messages"][0]["content"])
        sent = self._chat({"model": "m", "shoot_context": False, "messages": [{"role": "system", "content": REPLY_SYSTEM}]})
        self.assertNotIn("shoot_context", sent)
        self.assertEqual(sent["messages"][0]["content"], REPLY_SYSTEM)

    def test_chat_still_works_when_shoot_day_hangs(self):
        FakeShoot.delay = 1.0
        proxy.SHOOT_TIMEOUT = 0.3
        sent = self._chat({"model": "m", "messages": [{"role": "system", "content": REPLY_SYSTEM}, {"role": "user", "content": "B: Hallo"}]})
        self.assertEqual(sent["messages"][0]["content"], REPLY_SYSTEM)

    def test_context_endpoint(self):
        server, base = serve(proxy.H)
        try:
            with urllib.request.urlopen(base + "/context/customer", timeout=5) as r:
                body = json.loads(r.read())
            with urllib.request.urlopen(base + "/v1/context/customer?customer=Muster%20B%C3%A4ckerei", timeout=5) as r:
                other = json.loads(r.read())
        finally:
            server.shutdown(); server.server_close()
        self.assertEqual(body["name"], "Beispiel Café")
        self.assertTrue(body["enabled"] and body["chars"] > 0 and body["ideas"] == 1 and body["storyboards"] == 1)
        self.assertNotIn("text", body)
        self.assertEqual(other["name"], "Muster Bäckerei")

    def test_context_endpoint_full(self):
        server, base = serve(proxy.H)
        try:
            with urllib.request.urlopen(base + "/context/customer?full=1", timeout=5) as r:
                body = json.loads(r.read())
            with urllib.request.urlopen(base + "/context/customer?full=1&customer=c_000000000002", timeout=5) as r:
                other = json.loads(r.read())
        finally:
            server.shutdown(); server.server_close()
        self.assertTrue(body["full"] and body["enabled"])
        self.assertEqual((body["name"], body["project"], body["date"], body["place"]),
                         ("Beispiel Café", "Imagefilm Frühstück", "2026-10-14", "Beispielgasse 1"))
        self.assertEqual(body["ideas"], ["Latte-Art in Zeitlupe"])
        self.assertEqual(body["storyboards"], [{"title": "Morgenroutine", "scenes": ["Ankunft", "Siebträger"]}])
        self.assertEqual(body["slogans"], ["Dein Morgen beginnt hier"])
        self.assertNotIn("text", body)
        self.assertEqual((other["name"], other["ideas"], other["storyboards"], other["slogans"]),
                         ("Muster Bäckerei", ["Mehlstaub im Gegenlicht"], [], []))
        self.assertEqual(FakeShoot.writes, [])

    def test_context_endpoint_full_needs_token_and_survives_no_shoot(self):
        proxy.TOKEN = "geheim"
        server, base = serve(proxy.H)
        try:
            with self.assertRaises(urllib.error.HTTPError) as err:
                urllib.request.urlopen(base + "/context/customer?full=1", timeout=5)
            self.assertEqual(err.exception.code, 401)
            proxy.SHOOT_URL = ""
            req = urllib.request.Request(base + "/context/customer?full=1", headers={"Authorization": "Bearer geheim"})
            with urllib.request.urlopen(req, timeout=5) as r:
                body = json.loads(r.read())
        finally:
            server.shutdown(); server.server_close()
        self.assertEqual((body["enabled"], body["name"], body["ideas"], body["storyboards"]), (False, "", [], []))


if __name__ == "__main__":
    unittest.main()
