#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Routen-Speicher fuer OpenGlance: gespeicherte Routen gleich auf Handy und PC.

    GET  /               die Planungsseite fuer den PC (Ordner ROUTES_WEB, gebaut mit `npm run build:pc`)
    GET  /routes         {"routes":[...], "deleted":[...]}
    POST /routes         Body = {"routes":[...], "deleted":[...]} (text/plain, kein Preflight);
                         wird mit dem Gespeicherten zusammengefuehrt, Antwort = Ergebnis
    GET  /health         Zaehler, ohne Anmeldung

Zusammenfuehren (gleiche Regeln wie mergeRoutes() in der App): je id gewinnt die
zuletzt geaenderte Fassung (`updated`), eine Loeschung (`deleted[].at`) schlaegt
jede aeltere Fassung, Loeschungen werden 180 Tage gemerkt, behalten werden die
20 zuletzt geaenderten Routen.

Anmeldung wie bei den anderen Brillen-Diensten: `tailscale serve` verbindet von
Loopback und setzt `Tailscale-User-Login`; vertraut wird dem Kopf NUR von
Loopback und NUR fuer Logins aus ROUTES_TAILSCALE_USERS. Alternativ
`Authorization: Bearer <ROUTES_TOKEN>`. Ohne beides: 401 (auch fuer die Seite).
CORS: die App schickt einfache Anfragen ohne eigene Kopfzeilen; OPTIONS
antwortet trotzdem mit 204 OHNE Body.

Nur Standardbibliothek, Python 3.9+. Daten: eine JSON-Datei (ROUTES_FILE),
atomar geschrieben (tmp + rename), eine Sicherung der Vorfassung (.bak).
"""

import hashlib
import hmac
import json
import mimetypes
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HIER = os.path.dirname(os.path.abspath(__file__))
HOST = os.environ.get("ROUTES_HOST", "127.0.0.1")
PORT = int(os.environ.get("ROUTES_PORT", "8468"))
DATEI = os.environ.get("ROUTES_FILE", os.path.join(HIER, "routes.json"))
WEB = os.path.abspath(os.environ.get("ROUTES_WEB", os.path.join(HIER, "web")))
NUTZER = {x.strip().lower() for x in os.environ.get("ROUTES_TAILSCALE_USERS", "").split(",") if x.strip()}
TOKEN = os.environ.get("ROUTES_TOKEN", "")
LOOPBACK = ("127.0.0.1", "::1", "::ffff:127.0.0.1")

MAX_ROUTES = 20
MAX_STOPS = 3
MAX_TOMBSTONES = 200
TOMBSTONE_KEEP_MS = 180 * 24 * 60 * 60 * 1000
MAX_BODY = 512 * 1024

SPERRE = threading.Lock()
ZAEHLER = {"get": 0, "post": 0, "page": 0, "denied": 0, "bad": 0}


def jetzt_ms():
    return int(time.time() * 1000)


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


# ------------------------------------------------------------------ Daten pruefen

def _zahl(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def _punkt(v):
    if not isinstance(v, dict):
        return None
    at = v.get("at")
    if not isinstance(at, dict):
        return None
    lat, lon = at.get("lat"), at.get("lon")
    if not (_zahl(lat) and _zahl(lon)) or abs(lat) > 90 or abs(lon) > 180:
        return None
    label = v.get("label")
    label = label.strip()[:80] if isinstance(label, str) and label.strip() else "%.4f, %.4f" % (lat, lon)
    return {"label": label, "at": {"lat": float(lat), "lon": float(lon)}}


def route_pruefen(r):
    """Nur bekannte Felder, Laengen begrenzt; None = verworfen (nie geraten)."""
    if not isinstance(r, dict):
        return None
    rid = r.get("id")
    if not isinstance(rid, str) or not rid or len(rid) > 40:
        return None
    ziel = _punkt(r.get("to"))
    if not ziel:
        return None
    start = None if r.get("start") is None else _punkt(r.get("start"))
    stopps = [p for p in (_punkt(s) for s in (r.get("stops") or [])[:MAX_STOPS] if isinstance(r.get("stops"), list)) if p]
    mode = r.get("mode") if r.get("mode") in ("driving", "cycling", "walking") else "driving"
    name = r.get("name")
    name = name.strip()[:60] if isinstance(name, str) and name.strip() else ziel["label"]
    out = {
        "id": rid, "name": name, "mode": mode, "start": start, "stops": stopps, "to": ziel,
        "distance": r["distance"] if _zahl(r.get("distance")) and r["distance"] >= 0 else 0,
        "duration": r["duration"] if _zahl(r.get("duration")) and r["duration"] >= 0 else 0,
    }
    line = r.get("line")
    if start and isinstance(line, str) and 0 < len(line) < 20000:
        out["line"] = line
    if _zahl(r.get("updated")) and r["updated"] > 0:
        out["updated"] = r["updated"]
    return out


def loeschungen_pruefen(liste, now):
    out = []
    for d in liste if isinstance(liste, list) else []:
        if not isinstance(d, dict):
            continue
        rid, at = d.get("id"), d.get("at")
        if not isinstance(rid, str) or not rid or len(rid) > 40 or not _zahl(at):
            continue
        if now - at > TOMBSTONE_KEEP_MS:
            continue
        out.append({"id": rid, "at": at})
    return out[-MAX_TOMBSTONES:]


def zusammenfuehren(a, b, now):
    """Gleiche Regeln wie mergeRoutes() in src/trip/saved.ts."""
    geloescht = {}
    for d in a["deleted"] + b["deleted"]:
        if now - d["at"] > TOMBSTONE_KEEP_MS:
            continue
        geloescht[d["id"]] = max(geloescht.get(d["id"], 0), d["at"])
    routen = {}
    reihenfolge = []
    for r in a["routes"] + b["routes"]:
        hat = routen.get(r["id"])
        if hat is None:
            reihenfolge.append(r["id"])
            routen[r["id"]] = r
        elif r.get("updated", 0) > hat.get("updated", 0):
            routen[r["id"]] = r
    lebend = [routen[i] for i in reihenfolge if geloescht.get(i, -1) < routen[i].get("updated", 0)]
    # stabil sortiert: bei gleichem `updated` bleibt die Reihenfolge
    lebend.sort(key=lambda r: r.get("updated", 0))
    lebend = lebend[-MAX_ROUTES:]
    grab = sorted(({"id": i, "at": at} for i, at in geloescht.items()), key=lambda d: d["at"])[-MAX_TOMBSTONES:]
    return {"routes": lebend, "deleted": grab}


def satz_pruefen(wert, now):
    wert = wert if isinstance(wert, dict) else {}
    routen = [r for r in (route_pruefen(x) for x in (wert.get("routes") or [])[:100] if isinstance(wert.get("routes"), list)) if r]
    return {"routes": routen, "deleted": loeschungen_pruefen(wert.get("deleted"), now)}


def laden():
    try:
        with open(DATEI, encoding="utf-8") as f:
            return satz_pruefen(json.load(f), jetzt_ms())
    except FileNotFoundError:
        return {"routes": [], "deleted": []}


def speichern(satz):
    tmp = DATEI + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(satz, f, ensure_ascii=False, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    if os.path.exists(DATEI):
        os.replace(DATEI, DATEI + ".bak")
    os.replace(tmp, DATEI)


# ------------------------------------------------------------------ HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "GlassRoutes/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        origin = self.headers.get("Origin")
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Vary", "Origin")

    def _senden(self, code, body, typ, form="-", t0=None, extra=None):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", typ)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        ms = (time.time() - t0) * 1000 if t0 else 0
        print("%s %s %d %s %.0fms" % (self.command, self.path.split("?")[0][:60], code, form, ms), flush=True)

    def _json(self, code, daten, form="-", t0=None):
        body = json.dumps(daten, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._senden(code, body, "application/json; charset=utf-8", form, t0, {"Cache-Control": "no-store"})

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _erlaubt(self, t0):
        ok, form = anmeldung(self.client_address[0], self.headers)
        if not ok:
            ZAEHLER["denied"] += 1
            self._json(401, {"error": "unauthorized"}, form, t0)
        return ok, form

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        t0 = time.time()
        pfad = self.path.split("?")[0]
        if pfad == "/health":
            with SPERRE:
                n = len(laden()["routes"])
            return self._json(200, {"ok": True, "routes": n, **ZAEHLER}, "-", t0)
        ok, form = self._erlaubt(t0)
        if not ok:
            return
        if pfad == "/routes":
            ZAEHLER["get"] += 1
            with SPERRE:
                satz = laden()
            return self._json(200, satz, form, t0)
        return self._datei(pfad, form, t0)

    def do_POST(self):
        t0 = time.time()
        pfad = self.path.split("?")[0]
        ok, form = self._erlaubt(t0)
        if not ok:
            return
        if pfad != "/routes":
            return self._json(404, {"error": "not found"}, form, t0)
        try:
            laenge = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            laenge = -1
        if laenge < 0 or laenge > MAX_BODY:
            ZAEHLER["bad"] += 1
            return self._json(413, {"error": "too large"}, form, t0)
        try:
            wert = json.loads(self.rfile.read(laenge).decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            ZAEHLER["bad"] += 1
            return self._json(400, {"error": "invalid json"}, form, t0)
        now = jetzt_ms()
        with SPERRE:
            alt = laden()
            neu = zusammenfuehren(alt, satz_pruefen(wert, now), now)
            if neu != alt:
                speichern(neu)
        ZAEHLER["post"] += 1
        return self._json(200, neu, form, t0)

    def _datei(self, pfad, form, t0):
        """Statische Planungsseite; nur Dateien unterhalb von WEB."""
        rel = pfad.lstrip("/") or "planner.html"
        if rel == "index.html":
            rel = "planner.html"
        ziel = os.path.abspath(os.path.join(WEB, rel))
        if not ziel.startswith(WEB + os.sep) or not os.path.isfile(ziel):
            return self._json(404, {"error": "not found"}, form, t0)
        ZAEHLER["page"] += 1
        typ = mimetypes.guess_type(ziel)[0] or "application/octet-stream"
        if typ.startswith("text/") or typ in ("application/javascript", "image/svg+xml"):
            typ += "; charset=utf-8"
        with open(ziel, "rb") as f:
            body = f.read()
        # Gehashte Dateien in assets/ duerfen lange im Cache bleiben, die Seite selbst nicht.
        cache = "public, max-age=31536000, immutable" if rel.startswith("assets/") else "no-cache"
        return self._senden(200, body, typ, form, t0, {
            "Cache-Control": cache,
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        })


def main():
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    os.makedirs(os.path.dirname(os.path.abspath(DATEI)), exist_ok=True)
    if not NUTZER and not TOKEN:
        print("WARNUNG: weder ROUTES_TAILSCALE_USERS noch ROUTES_TOKEN gesetzt - alles bleibt gesperrt", flush=True)
    print("glass-routes auf %s:%d, Daten %s, Seite %s" % (HOST, PORT, DATEI, WEB), flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
