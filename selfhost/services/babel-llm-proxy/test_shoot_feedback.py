"""Shoot Day feedback filing of babel_llm_proxy (POST /context/feedback + background after the summary),
against a fake Shoot Day server and a fake LLM.

    python3 -m pytest test_shoot_feedback.py      (or: python3 -m unittest test_shoot_feedback)
Stdlib only, no network beyond 127.0.0.1. Example data only, no real customers.
"""
import copy, json, os, sys, threading, time, unittest, urllib.error, urllib.request
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
BRIEF = {"id": "c_000000000001", "name": "Beispiel Café", "company": "Beispiel Café GmbH", "notes": "",
         "projects": [{"id": "p_000000000001", "name": "Imagefilm Frühstück", "date": "2026-10-14"}],
         "ideas": [{"text": "Latte-Art in Zeitlupe", "tags": ["zeitlupe"]}]}
EXISTING = [
    {"id": "i_000000000001", "text": "Latte-Art in Zeitlupe", "tags": ["zeitlupe", "detail"], "done": False, "created": 1},
    {"id": "i_000000000002", "text": "Drohnenflug über den Gastgarten", "tags": ["drohne"], "done": True, "created": 2},
]
PROJECT = {"id": "p_000000000001", "customerId": "c_000000000001", "name": "Imagefilm Frühstück", "date": "2026-10-14",
           "place": "Beispielgasse 1", "prompter": "", "storyboards": [], "ideas": EXISTING}

GOOD = json.dumps({
    "neu": [{"text": "Barista erklärt die Bohnenauswahl vor der Kamera", "tags": ["interview", "#Barista"]}],
    "abgelehnt": [{"text": "Drohnenflug über den Gastgarten – zu laut für die Gäste", "tags": ["drohne"]}],
    "wunsch": [{"text": "Stimmung eher ruhig und warm, Dreh am Nachmittag", "tags": ["stimmung"]},
               {"text": "latte-art in zeitlupe", "tags": []}],
    "frage": [{"text": "Wer aus dem Team soll vor die Kamera?", "tags": []}],
}, ensure_ascii=False)
EXTRACT_MARK = "Du liest die Mitschrift eines Kundengesprächs"
SUMMARY_SYSTEM = "Du fasst ein mitgeschriebenes Gespräch auf Deutsch zusammen. Antworte NUR mit JSON."
TRANSCRIPT = "B: Die Drohne finde ich zu laut. A: Verstehe. B: Lieber soll unser Barista die Bohnen erklären."


class FakeShoot(BaseHTTPRequestHandler):
    listing = LISTING
    project = None
    posts = []
    fail_post = False

    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
        self.end_headers(); self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/api/customers": return self._send(200, FakeShoot.listing)
        if self.path == "/api/customers/c_000000000001/brief": return self._send(200, BRIEF)
        if self.path == "/api/projects/p_000000000001": return self._send(200, FakeShoot.project)
        self._send(404, {})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        FakeShoot.posts.append((self.path, body))
        if FakeShoot.fail_post: return self._send(500, {"error": "boom"})
        if self.path != "/api/projects/p_000000000001/ideas": return self._send(404, {})
        FakeShoot.project = dict(FakeShoot.project, ideas=body["ideas"])
        self._send(200, {"ideas": body["ideas"]})

    def log_message(self, *a): pass


class FakeLlm(BaseHTTPRequestHandler):
    answer = GOOD
    bodies = []

    def do_GET(self):
        raw = json.dumps({"data": [{"id": "fake-model"}]}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        FakeLlm.bodies.append(body)
        extract = EXTRACT_MARK in body["messages"][0]["content"]
        raw = json.dumps({"choices": [{"message": {"content": FakeLlm.answer if extract else "{\"summary\":\"ok\"}"}}]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw)))
        self.end_headers(); self.wfile.write(raw)

    def log_message(self, *a): pass


def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, "http://127.0.0.1:%d" % server.server_address[1]


class FeedbackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shoot, cls.shoot_url = serve(FakeShoot)
        cls.llm, cls.llm_url = serve(FakeLlm)

    @classmethod
    def tearDownClass(cls):
        for s in (cls.shoot, cls.llm): s.shutdown(); s.server_close()

    def setUp(self):
        self.saved = (proxy.SHOOT_URL, proxy.SHOOT_TOKEN, proxy.SHOOT_TIMEOUT, proxy.SHOOT_FEEDBACK, proxy.UP, proxy.TOKEN, proxy.SHOOT_TALKS)
        proxy.SHOOT_URL, proxy.SHOOT_TOKEN, proxy.SHOOT_TIMEOUT, proxy.SHOOT_FEEDBACK = self.shoot_url, "", 2.0, True
        proxy.SHOOT_TALKS = False  # the talk record has its own test (test_shoot_talks.py)
        proxy.UP, proxy.TOKEN = self.llm_url, ""
        proxy._shoot_cache.clear(); proxy._feedback_seen.clear()
        FakeShoot.listing, FakeShoot.project, FakeShoot.posts, FakeShoot.fail_post = LISTING, copy.deepcopy(PROJECT), [], False
        FakeLlm.answer, FakeLlm.bodies = GOOD, []

    def tearDown(self):
        (proxy.SHOOT_URL, proxy.SHOOT_TOKEN, proxy.SHOOT_TIMEOUT, proxy.SHOOT_FEEDBACK, proxy.UP, proxy.TOKEN, proxy.SHOOT_TALKS) = self.saved
        proxy._shoot_cache.clear(); proxy._feedback_seen.clear()

    # ---- parsing
    def test_parse(self):
        items = proxy.feedback_parse("```json\n" + GOOD + "\n```")
        self.assertEqual([k for k, _, _ in items], ["neu", "abgelehnt", "wunsch", "wunsch", "frage"])
        self.assertEqual(items[0][2], ["interview", "barista"])
        for bad in ("", "kein json", "{kaputt", "[1,2]", None, '{"neu": "x"}', '{"neu":[{"text":""}, 5]}'):
            self.assertEqual(proxy.feedback_parse(bad), [], bad)

    def test_malformed_answer_writes_nothing(self):
        FakeLlm.answer = "Hier ist das Ergebnis: {neu: kaputt"
        r = proxy.feedback_file(TRANSCRIPT)
        self.assertEqual(r["added"], [])
        self.assertEqual(FakeShoot.posts, [])

    # ---- merge / dedupe
    def test_merge_keeps_existing_and_dedupes(self):
        r = proxy.feedback_file(TRANSCRIPT, now=time.mktime((2026, 10, 14, 9, 0, 0, 0, 0, -1)))
        self.assertEqual(len(FakeShoot.posts), 1)
        path, body = FakeShoot.posts[0]
        self.assertEqual(path, "/api/projects/p_000000000001/ideas")
        self.assertEqual(body["ideas"][:2], EXISTING)  # untouched, same order, ids/done kept
        new = body["ideas"][2:]
        texts = [i["text"] for i in new]
        self.assertEqual(texts, [
            "14.10.: Barista erklärt die Bohnenauswahl vor der Kamera",
            "14.10.: Abgelehnt: Drohnenflug über den Gastgarten – zu laut für die Gäste",
            "14.10.: Stimmung eher ruhig und warm, Dreh am Nachmittag",
            "14.10.: Wer aus dem Team soll vor die Kamera?",
        ])
        self.assertEqual(new[0]["tags"], ["gespraech", "neu", "interview", "barista"])
        self.assertEqual(new[1]["tags"], ["gespraech", "abgelehnt", "drohne"])
        self.assertEqual(new[3]["tags"][:2], ["gespraech", "frage"])
        # "latte-art in zeitlupe" is already there -> skipped
        self.assertEqual((r["added"], r["skipped"]), (texts, 1))
        self.assertEqual(r["customer"], "Beispiel Café")
        # a second run with the same answer adds nothing (dedupe against the "14.10.: " entries too)
        r2 = proxy.feedback_file(TRANSCRIPT)
        self.assertEqual((r2["added"], r2["skipped"]), ([], 5))
        self.assertEqual(len(FakeShoot.posts), 1)

    def test_rejected_gets_label(self):
        FakeShoot.project = dict(FakeShoot.project, ideas=[])
        FakeLlm.answer = json.dumps({"abgelehnt": [{"text": "Drohnenflug – zu laut"}]})
        r = proxy.feedback_file(TRANSCRIPT)
        self.assertEqual(len(r["added"]), 1)
        self.assertIn("Abgelehnt: Drohnenflug – zu laut", r["added"][0])
        self.assertEqual(FakeShoot.posts[0][1]["ideas"][0]["tags"], ["gespraech", "abgelehnt"])

    def test_no_customer_writes_nothing(self):
        FakeShoot.listing = dict(LISTING, activeCustomer="unassigned")
        self.assertEqual(proxy.feedback_file(TRANSCRIPT)["reason"], "no customer")
        self.assertEqual(proxy.feedback_file(TRANSCRIPT, "gibt es nicht")["reason"], "no customer")
        FakeShoot.listing = dict(LISTING, activeCustomer="")
        self.assertEqual(proxy.feedback_file(TRANSCRIPT)["reason"], "no customer")
        self.assertEqual((FakeShoot.posts, FakeLlm.bodies), ([], []))

    def test_off_switches(self):
        proxy.SHOOT_FEEDBACK = False
        self.assertEqual(proxy.feedback_file(TRANSCRIPT)["reason"], "off")
        proxy.SHOOT_FEEDBACK, proxy.SHOOT_URL = True, ""
        self.assertEqual(proxy.feedback_file(TRANSCRIPT)["reason"], "off")
        self.assertEqual(FakeShoot.posts, [])

    def test_transcript_capped(self):
        proxy.feedback_file("x" * 50000 + " ENDE")
        sent = [b for b in FakeLlm.bodies if EXTRACT_MARK in b["messages"][0]["content"]][0]
        self.assertLessEqual(len(sent["messages"][1]["content"]), proxy.FEEDBACK_MAX_CHARS)
        self.assertTrue(sent["messages"][1]["content"].endswith("ENDE"))
        self.assertEqual((sent["temperature"], sent["chat_template_kwargs"]["enable_thinking"]), (0.1, False))

    # ---- idempotency
    def test_once_per_transcript(self):
        self.assertEqual(len(proxy.feedback_once(TRANSCRIPT)["added"]), 4)
        self.assertTrue(proxy.feedback_once(TRANSCRIPT).get("duplicate"))
        n = len([b for b in FakeLlm.bodies if EXTRACT_MARK in b["messages"][0]["content"]])
        self.assertEqual(n, 1)
        # a failure frees the hash again
        FakeShoot.fail_post, FakeShoot.project = True, copy.deepcopy(PROJECT)
        with self.assertRaises(Exception): proxy.feedback_once("anderes Gespräch")
        FakeShoot.fail_post = False
        self.assertFalse(proxy.feedback_once("anderes Gespräch").get("duplicate"))

    def test_expires_after_30_min(self):
        proxy.feedback_once(TRANSCRIPT, now=1000.0)
        self.assertTrue(proxy.feedback_once(TRANSCRIPT, now=1000.0 + 60).get("duplicate"))
        self.assertFalse(proxy.feedback_once(TRANSCRIPT, now=1000.0 + proxy.FEEDBACK_REPEAT_S + 1).get("duplicate"))

    # ---- HTTP
    def _post(self, path, body):
        server, base = serve(proxy.H)
        try:
            req = urllib.request.Request(base + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=10) as r: return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read() or b"{}")
        finally:
            server.shutdown(); server.server_close()

    def test_endpoint(self):
        code, body = self._post("/context/feedback", {"transcript": TRANSCRIPT, "customer": "Beispiel"})
        self.assertEqual(code, 200)
        self.assertEqual((len(body["added"]), body["skipped"]), (4, 1))
        self.assertEqual(self._post("/v1/context/feedback", {"transcript": " "})[0], 400)
        self.assertEqual(self._post("/context/feedback", {"transcript": TRANSCRIPT, "customer": "Beispiel"})[1].get("duplicate"), True)
        FakeShoot.fail_post, FakeShoot.project = True, copy.deepcopy(PROJECT)
        code, body = self._post("/context/feedback", {"transcript": "neu " + TRANSCRIPT})
        self.assertEqual((code, body["added"]), (502, []))
        proxy.SHOOT_FEEDBACK = False
        self.assertEqual(self._post("/context/feedback", {"transcript": "x"})[0], 503)

    def test_endpoint_needs_token(self):
        proxy.TOKEN = "geheim"
        self.assertEqual(self._post("/context/feedback", {"transcript": TRANSCRIPT})[0], 401)
        self.assertEqual(FakeShoot.posts, [])

    def _summary(self):
        return self._post("/v1/chat/completions", {"model": "m", "messages": [
            {"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": TRANSCRIPT}]})

    def _wait_posts(self, n, timeout=5.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end and len(FakeShoot.posts) < n: time.sleep(0.02)
        time.sleep(0.1)

    def test_background_after_summary(self):
        code, body = self._summary()
        self.assertEqual((code, body["choices"][0]["message"]["content"]), (200, "{\"summary\":\"ok\"}"))
        self._wait_posts(1)
        self.assertEqual(len(FakeShoot.posts), 1)
        extract = [b for b in FakeLlm.bodies if EXTRACT_MARK in b["messages"][0]["content"]][0]
        self.assertEqual(extract["model"], "m")
        self.assertEqual(extract["messages"][1]["content"], TRANSCRIPT)
        # the same summary again (e.g. re-tapped) does not file twice
        self._summary(); self._wait_posts(2, 1.0)
        self.assertEqual(len(FakeShoot.posts), 1)

    def test_no_background_for_reply_or_when_off(self):
        self._post("/v1/chat/completions", {"model": "m", "messages": [
            {"role": "system", "content": "Du hilfst jemandem live in einem Gespräch"}, {"role": "user", "content": TRANSCRIPT}]})
        proxy.SHOOT_FEEDBACK = False
        self._summary(); self._wait_posts(1, 0.8)
        self.assertEqual(FakeShoot.posts, [])

    def test_summary_survives_feedback_failure(self):
        FakeShoot.fail_post = True
        code, body = self._summary()
        self.assertEqual((code, body["choices"][0]["message"]["content"]), (200, "{\"summary\":\"ok\"}"))
        FakeLlm.answer = "kaputt"
        FakeShoot.fail_post = False
        proxy._feedback_seen.clear()
        code, _ = self._summary()
        self.assertEqual(code, 200)

    def test_reply_instruction_added(self):
        self._post("/v1/chat/completions", {"model": "m", "messages": [
            {"role": "system", "content": "Du hilfst jemandem live in einem Gespräch"}, {"role": "user", "content": "B: lieber was anderes"}]})
        system = FakeLlm.bodies[-1]["messages"][0]["content"]
        self.assertIn("vorbereitete Idee ablehnt", system)
        self.assertIn("Keine erfundenen Fakten", system)
        self._summary()
        self.assertNotIn("vorbereitete Idee ablehnt", [b for b in FakeLlm.bodies if b["messages"][0]["content"].startswith(SUMMARY_SYSTEM)][-1]["messages"][0]["content"])


if __name__ == "__main__":
    unittest.main()
