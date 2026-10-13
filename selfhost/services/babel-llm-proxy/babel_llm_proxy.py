#!/usr/bin/env python3
"""CORS + token + no-thinking proxy in front of Spark vLLM for Babel Glass translation (non-streaming)."""
import json, os, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
UP = os.environ.get("UPSTREAM", "http://127.0.0.1:8000"); TOKEN = os.environ.get("TOKEN", "")
PORT = int(os.environ.get("PORT", "8121"))
# Tailscale login auth: `tailscale serve` connects from loopback and sets Tailscale-User-Login.
TS_USERS = [u.strip().lower() for u in os.environ.get("TAILSCALE_USERS", "").split(",") if u.strip()]
class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
    def _send(self, code, body, ct="application/json"):
        self.send_response(code); self._cors(); self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def _auth(self):
        if not TOKEN: return True
        peer = str(self.client_address[0]).replace("::ffff:", "")
        if peer in ("127.0.0.1", "::1") and (self.headers.get("Tailscale-User-Login") or "").strip().lower() in TS_USERS: return True
        return self.headers.get("Authorization") == "Bearer " + TOKEN
    def do_OPTIONS(self): self._send(204, b"")
    def do_GET(self):
        if not self._auth(): return self._send(401, b'{"error":"unauthorized"}')
        if self.path.rstrip("/") not in ("/v1/models",): return self._send(404, b"{}")
        self._send(200, urllib.request.urlopen(UP + "/v1/models", timeout=10).read())
    def do_POST(self):
        if not self._auth(): return self._send(401, b'{"error":"unauthorized"}')
        if not self.path.rstrip("/").endswith("/chat/completions"): return self._send(404, b"{}")
        d = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        d["stream"] = False; d.setdefault("max_tokens", 300)
        d.setdefault("chat_template_kwargs", {})["enable_thinking"] = False
        try:
            r = urllib.request.urlopen(urllib.request.Request(UP + "/v1/chat/completions", json.dumps(d).encode(), {"Content-Type": "application/json"}), timeout=60)
            self._send(200, r.read())
        except Exception as e:
            self._send(502, json.dumps({"error": str(e)}).encode())
    def log_message(self, *a): pass
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
