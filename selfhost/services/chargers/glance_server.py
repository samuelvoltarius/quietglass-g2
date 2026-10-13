#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Schlanker Lesedienst vor der Stationstabelle - fuer OpenGlance auf der Brille.

Bewusst ein eigener Prozess statt ein Endpunkt im Planer: der Planer haengt
oeffentlich hinter nginx mit Basic-Auth. Wuerde man ihn per `tailscale serve`
freigeben, stuende seine ganze API (auch die schreibenden Endpunkte) ohne
diese Anmeldung im Tailnet. Dieser Dienst kann nur lesen und nur zwei Dinge.

    GET /chargers?lat=..&lon=..&radius=<m>        Umkreis (max. 50 km)
    GET /chargers?boxes=s,w,n,e;s,w,n,e...        Kaesten entlang einer Route
    GET /health                                   Zaehler, ohne Anmeldung

Anmeldung wie bei den anderen Brillen-Diensten: `tailscale serve` verbindet
von Loopback und setzt `Tailscale-User-Login`; vertraut wird dem Kopf NUR von
Loopback und NUR fuer Logins aus GLANCE_TAILSCALE_USERS. Alternativ
`Authorization: Bearer <GLANCE_TOKEN>`. Ohne beides ist alles gesperrt.
CORS: einfache GETs ohne eigene Kopfzeilen (kein Preflight); OPTIONS
antwortet trotzdem mit 204 OHNE Body.
"""

import hashlib
import hmac
import json
import os
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HIER = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HIER)
import glance  # noqa: E402

DB = os.environ.get("TARIF_DB", os.path.join(HIER, "tarife.db"))
HOST = os.environ.get("GLANCE_HOST", "127.0.0.1")
PORT = int(os.environ.get("GLANCE_PORT", "8467"))
NUTZER = {x.strip().lower() for x in os.environ.get("GLANCE_TAILSCALE_USERS", "").split(",") if x.strip()}
TOKEN = os.environ.get("GLANCE_TOKEN", "")
LOOPBACK = ("127.0.0.1", "::1", "::ffff:127.0.0.1")


def anmeldung(adresse, kopf):
    """-> (erlaubt, form) ; form nur fuer das Log, nie der Wert selbst."""
    auth = kopf.get("Authorization") or ""
    if TOKEN and auth.startswith("Bearer "):
        wert = auth[7:].strip()
        ok = hmac.compare_digest(wert.encode(), TOKEN.encode())
        return ok, "token len%d fp=%s" % (len(wert), hashlib.sha256(wert.encode()).hexdigest()[:8])
    login = (kopf.get("Tailscale-User-Login") or "").strip().lower()
    if login:
        if adresse not in LOOPBACK:
            return False, "tailscale-not-loopback"
        return (login in NUTZER), "tailscale"
    return False, "none"


class Handler(BaseHTTPRequestHandler):
    server_version = "EVGlance/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # eigenes, knappes Log in _antwort

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
        sys.stderr.write("%s %s %d %.0fms auth=%s\n" % (self.command, pfad, code, ms, form))

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        self._antwort(405, {"fehler": "nur GET"})

    def do_GET(self):
        t0 = time.time()
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path in ("/health", "/health/"):
            con = glance.verbinden(DB)
            try:
                rows = con.execute("SELECT land, COUNT(*), MAX(stand) FROM station GROUP BY land").fetchall()
            finally:
                con.close()
            return self._antwort(200, {"ok": True, "stationen": {r[0]: {"evse": r[1], "stand": r[2]} for r in rows}}, "-", t0)
        if u.path not in ("/chargers", "/chargers/"):
            return self._antwort(404, {"fehler": "unbekannter Pfad"}, "-", t0)
        erlaubt, form = anmeldung(self.client_address[0], self.headers)
        if not erlaubt:
            return self._antwort(401, {"fehler": "nicht angemeldet"}, form, t0)
        try:
            if "boxes" in q:
                kaesten, mitte, radius = glance.kaesten_lesen(q["boxes"][0]), None, None
            else:
                lat, lon = float(q["lat"][0]), float(q["lon"][0])
                radius = float(q.get("radius", ["15000"])[0])
                kaesten, mitte = [glance.umkreis_kasten(lat, lon, radius)], (lat, lon)
        except (KeyError, ValueError, IndexError) as exc:
            return self._antwort(400, {"fehler": "Parameter: %s" % exc}, form, t0)
        con = glance.verbinden(DB)
        try:
            daten = glance.abfrage(con, kaesten, mitte, radius)
        finally:
            con.close()
        return self._antwort(200, daten, form, t0)


def main():
    if not NUTZER and not TOKEN:
        sys.stderr.write("WARNUNG: weder GLANCE_TAILSCALE_USERS noch GLANCE_TOKEN gesetzt - alles gesperrt\n")
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    sys.stderr.write("ev-glance auf %s:%d, DB %s\n" % (HOST, PORT, DB))
    srv.serve_forever()


if __name__ == "__main__":
    main()
