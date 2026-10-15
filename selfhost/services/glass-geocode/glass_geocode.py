#!/usr/bin/env python3
"""glass-geocode - Ortssuche fuer OpenGlance, spricht wie Photon.

Warum: photon.komoot.io antwortete unterwegs in 13-15 s (App-Timeout 10 s),
am Abend desselben Tages in 3-4 s - er schwankt. Dieser Dienst fragt Photon
und Nominatim (beide OpenStreetMap) GLEICHZEITIG, nimmt die erste Antwort mit
Treffern und merkt sie sich einen Tag. Die App bleibt beim Photon-Format:

  GET /api/?q=...&limit=5&lang=de&lat=47.80&lon=13.04   -> GeoJSON FeatureCollection
  GET /reverse?lat=47.80&lon=13.04&limit=1              -> GeoJSON (countrycode)
  GET /health

Nur Tailnet: hinter `tailscale serve` (Header Tailscale-User-Login, nur von
Loopback) oder mit Bearer-Token. Nominatim-Nutzungsregeln: eigener
User-Agent, hoechstens 1 Anfrage/s, Antworten werden zwischengespeichert.
"""
import hashlib
import hmac
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("GEOCODE_HOST", "127.0.0.1")
PORT = int(os.environ.get("GEOCODE_PORT", "8478"))
TOKEN = os.environ.get("GEOCODE_TOKEN", "").strip()
NUTZER = {u.strip().lower() for u in os.environ.get("GEOCODE_TAILSCALE_USERS", "").split(",") if u.strip()}
PHOTON = os.environ.get("GEOCODE_PHOTON_URL", "https://photon.komoot.io").rstrip("/")
NOMINATIM = os.environ.get("GEOCODE_NOMINATIM_URL", "https://nominatim.openstreetmap.org").rstrip("/")
USER_AGENT = os.environ.get("GEOCODE_USER_AGENT", "quietglass-openglance-geocode/1.0 (private, tailnet)")
TIMEOUT_S = float(os.environ.get("GEOCODE_TIMEOUT_S", "12"))
CACHE_S = 24 * 3600
CACHE_MAX = 5000
LOOPBACK = {"127.0.0.1", "::1"}

ZAEHLER = {"requests": 0, "cache": 0, "photon": 0, "nominatim": 0, "empty": 0, "failed": 0, "denied": 0}
_cache = {}
_cache_lock = threading.Lock()
_nominatim_lock = threading.Lock()
_nominatim_last = [0.0]
_pool = ThreadPoolExecutor(max_workers=8)


def anmeldung(adresse, kopf):
    """-> (erlaubt, form); form nur fuer das Log, nie der Wert selbst."""
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


def holen(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return json.loads(r.read(3_000_000).decode("utf-8"))


def photon_suche(q, limit, lang, lat, lon):
    p = {"q": q, "limit": str(limit)}
    if lang:
        p["lang"] = lang
    if lat is not None and lon is not None:
        p["lat"], p["lon"] = "%.2f" % lat, "%.2f" % lon
    daten = holen(PHOTON + "/api/?" + urllib.parse.urlencode(p))
    feats = daten.get("features") if isinstance(daten, dict) else None
    return feats if isinstance(feats, list) else []


def nominatim_takt():
    """Hoechstens eine Anfrage pro Sekunde an Nominatim (Nutzungsregeln)."""
    with _nominatim_lock:
        warten = 1.0 - (time.time() - _nominatim_last[0])
        if warten > 0:
            time.sleep(warten)
        _nominatim_last[0] = time.time()


def nominatim_als_photon(eintrag):
    """Nominatim jsonv2 (addressdetails=1) -> Photon-Feature mit den Feldern, die OpenGlance liest."""
    try:
        lat, lon = float(eintrag["lat"]), float(eintrag["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    a = eintrag.get("address") or {}
    stadt = a.get("city") or a.get("town") or a.get("village") or a.get("municipality") or a.get("hamlet") or ""
    eigen = {
        "name": eintrag.get("name") or "",
        "street": a.get("road") or a.get("pedestrian") or "",
        "housenumber": a.get("house_number") or "",
        "postcode": a.get("postcode") or "",
        "city": stadt,
        "district": a.get("suburb") or a.get("city_district") or "",
        "country": a.get("country") or "",
        "countrycode": (a.get("country_code") or "").upper(),
        "osm_key": eintrag.get("category") or "",
        "osm_value": eintrag.get("type") or "",
        "source": "nominatim",
    }
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {k: v for k, v in eigen.items() if v}}


def nominatim_suche(q, limit, lang, lat, lon):
    p = {"q": q, "format": "jsonv2", "addressdetails": "1", "limit": str(limit)}
    if lang:
        p["accept-language"] = lang
    if lat is not None and lon is not None:
        # Bevorzugt die Naehe, ohne darauf zu beschraenken (viewbox, bounded=0).
        p["viewbox"] = "%.2f,%.2f,%.2f,%.2f" % (lon - 0.5, lat + 0.5, lon + 0.5, lat - 0.5)
    nominatim_takt()
    daten = holen(NOMINATIM + "/search?" + urllib.parse.urlencode(p))
    if not isinstance(daten, list):
        return []
    return [f for f in (nominatim_als_photon(e) for e in daten) if f]


def zahl(wert):
    try:
        x = float(wert)
    except (TypeError, ValueError):
        return None
    return x if -180.0 <= x <= 180.0 else None


def suchen(q, limit, lang, lat, lon):
    """Beide gleichzeitig; die erste Antwort mit Treffern gewinnt. -> (features, quelle)"""
    schluessel = json.dumps([q.lower(), limit, lang, None if lat is None else round(lat, 2), None if lon is None else round(lon, 2)])
    jetzt = time.time()
    with _cache_lock:
        treffer = _cache.get(schluessel)
        if treffer and jetzt - treffer[0] < CACHE_S:
            ZAEHLER["cache"] += 1
            return treffer[1], "cache"
    auftraege = {
        _pool.submit(photon_suche, q, limit, lang, lat, lon): "photon",
        _pool.submit(nominatim_suche, q, limit, lang, lat, lon): "nominatim",
    }
    offen = set(auftraege)
    leer = None
    fehler = 0
    ende = jetzt + TIMEOUT_S + 2
    while offen and time.time() < ende:
        fertig, offen = wait(offen, timeout=max(0.1, ende - time.time()), return_when=FIRST_COMPLETED)
        for f in fertig:
            try:
                feats = f.result()
            except Exception:
                fehler += 1
                continue
            if feats:
                quelle = auftraege[f]
                ZAEHLER[quelle] += 1
                with _cache_lock:
                    if len(_cache) >= CACHE_MAX:
                        for k in sorted(_cache, key=lambda k: _cache[k][0])[: CACHE_MAX // 10]:
                            del _cache[k]
                    _cache[schluessel] = (time.time(), feats)
                return feats, quelle
            leer = []
    if leer is not None:
        ZAEHLER["empty"] += 1
        return [], "empty"
    ZAEHLER["failed"] += 1
    return None, "failed"


def rueckwaerts(lat, lon):
    """Land eines Punkts: Photon /reverse, sonst Nominatim /reverse."""
    try:
        daten = holen(PHOTON + "/reverse?" + urllib.parse.urlencode({"lat": "%.2f" % lat, "lon": "%.2f" % lon, "limit": "1"}))
        feats = daten.get("features") if isinstance(daten, dict) else None
        if feats:
            return {"type": "FeatureCollection", "features": feats[:1]}
    except Exception:
        pass
    nominatim_takt()
    e = holen(NOMINATIM + "/reverse?" + urllib.parse.urlencode({"lat": "%.2f" % lat, "lon": "%.2f" % lon, "format": "jsonv2", "zoom": "3"}))
    f = nominatim_als_photon(e) if isinstance(e, dict) else None
    return {"type": "FeatureCollection", "features": [f] if f else []}


class Handler(BaseHTTPRequestHandler):
    server_version = "glass-geocode/1.0"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        origin = self.headers.get("Origin")
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Vary", "Origin")

    def _json(self, code, daten, form="-", t0=None, quelle="-"):
        body = json.dumps(daten, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
        ms = int((time.time() - (t0 or time.time())) * 1000)
        # Nie die Suchanfrage selbst ins Log (kann ein Zuhause sein).
        print("%s %s %d %dms %s auth=%s" % (self.command, self.path.split("?")[0], code, ms, quelle, form), flush=True)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        t0 = time.time()
        teile = urllib.parse.urlsplit(self.path)
        pfad = teile.path.rstrip("/") or "/"
        if pfad == "/health":
            return self._json(200, {"ok": True, **ZAEHLER}, "-", t0)
        ok, form = anmeldung(self.client_address[0], self.headers)
        if not ok:
            ZAEHLER["denied"] += 1
            return self._json(401, {"error": "unauthorized"}, form, t0)
        a = urllib.parse.parse_qs(teile.query)
        eins = lambda k: (a.get(k) or [""])[0]
        lat, lon = zahl(eins("lat")), zahl(eins("lon"))
        if pfad == "/api":
            q = eins("q").strip()[:200]
            if len(q) < 2:
                return self._json(400, {"error": "q"}, form, t0)
            try:
                limit = max(1, min(10, int(eins("limit") or "5")))
            except ValueError:
                limit = 5
            lang = eins("lang")[:5] if eins("lang") in ("de", "en", "fr", "it") else ""
            ZAEHLER["requests"] += 1
            feats, quelle = suchen(q, limit, lang, lat, lon)
            if feats is None:
                return self._json(503, {"error": "upstream"}, form, t0, quelle)
            return self._json(200, {"type": "FeatureCollection", "features": feats}, form, t0, quelle)
        if pfad == "/reverse":
            if lat is None or lon is None:
                return self._json(400, {"error": "lat/lon"}, form, t0)
            try:
                return self._json(200, rueckwaerts(lat, lon), form, t0, "reverse")
            except Exception as e:
                return self._json(503, {"error": type(e).__name__}, form, t0)
        return self._json(404, {"error": "not found"}, form, t0)


if __name__ == "__main__":
    print("glass-geocode on %s:%d, users=%d, token=%s" % (HOST, PORT, len(NUTZER), "yes" if TOKEN else "no"), flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
