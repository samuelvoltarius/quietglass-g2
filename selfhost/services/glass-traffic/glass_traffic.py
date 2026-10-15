#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Verkehrsmeldungen entlang einer Route fuer OpenGlance (Stau, Sperren, Baustellen, Unfaelle).

    POST /traffic/route   Body {"shape": "<polyline6>" | [[lat,lon],...], "buffer_m": 60, "precision": 6}
                          (text/plain, kein Preflight) -> Meldungen auf/an der Route mit Abstand
                          entlang der Route und eine Summe der Verzoegerung; 2 min gecacht
    GET  /health          Zaehler und welche Quellen eingerichtet sind, ohne Anmeldung

Quellen (beide optional, beide nur am Server):
  (a) TomTom Traffic Incidents API v5 (+ Flow Segment Data v4 fuer Stau ohne Meldung),
      nur wenn TOMTOM_KEY gesetzt ist. Der Schluessel bleibt auf dem Server; TomTom
      bekommt nur Rechtecke um die Route (bbox) und wenige Punkte AUF der Route,
      nie die Position der Brille als solche.
  (b) ASFINAG DATEX II (Autobahnen/Schnellstrassen Oesterreich): der Datenstrom ist
      NICHT frei herunterladbar, sondern braucht Registrierung + Vertrag im ASFINAG
      Content-Portal (https://contentportal.asfinag.at/). Danach ASFINAG_DATEX_URL
      (+ ASFINAG_USER/ASFINAG_PASSWORD fuer HTTP-Basic) setzen. Gelesen werden
      DATEX II v2 und v3 SituationPublication (situationRecord mit Koordinaten).
      Der ganze Strom wird hoechstens alle 2 min geholt, unabhaengig von Anfragen.

Ergebnisform je Meldung:
  {id, type: jam|closure|roadwork|accident|other, delayMin?, lengthKm?, from?, to?, text?,
   point: [lat,lon], geometry: [[lat,lon],...], source, alongM, offM}

Anmeldung wie bei den anderen Brillen-Diensten: `Tailscale-User-Login` NUR von
Loopback und NUR fuer Logins aus TRAFFIC_TAILSCALE_USERS, alternativ
`Authorization: Bearer <TRAFFIC_TOKEN>`. Ohne beides: 401.

Nur Standardbibliothek, Python 3.9+. Keine Schluessel im Log (URLs mit key werden nie ausgegeben).
"""

import base64
import hashlib
import hmac
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("TRAFFIC_HOST", "127.0.0.1")
PORT = int(os.environ.get("TRAFFIC_PORT", "8475"))
NUTZER = {x.strip().lower() for x in os.environ.get("TRAFFIC_TAILSCALE_USERS", "").split(",") if x.strip()}
TOKEN = os.environ.get("TRAFFIC_TOKEN", "")
LOOPBACK = ("127.0.0.1", "::1", "::ffff:127.0.0.1")

TOMTOM_KEY = os.environ.get("TOMTOM_KEY", "").strip()
TOMTOM_BASE = os.environ.get("TOMTOM_BASE", "https://api.tomtom.com").rstrip("/")
TOMTOM_LANGUAGE = os.environ.get("TOMTOM_LANGUAGE", "de-DE")
# Punkte entlang der Route, an denen die Flussgeschwindigkeit gefragt wird (0 = Flow aus).
TOMTOM_FLOW_SAMPLES = max(0, min(20, int(os.environ.get("TOMTOM_FLOW_SAMPLES", "6") or "0")))
# Hoechstens so viele Rechtecke je Route (TomTom erlaubt je Anfrage hoechstens 10 000 km^2).
TOMTOM_MAX_BOXES = max(1, min(20, int(os.environ.get("TOMTOM_MAX_BOXES", "8") or "8")))

ASFINAG_URL = os.environ.get("ASFINAG_DATEX_URL", "").strip()
ASFINAG_USER = os.environ.get("ASFINAG_USER", "")
ASFINAG_PASSWORD = os.environ.get("ASFINAG_PASSWORD", "")

CACHE_S = 120
MAX_BODY = 1024 * 1024
DIAG_FILE = os.environ.get("TRAFFIC_DIAG_FILE", "/opt/glass-traffic/diag.jsonl")
DIAG_MAX_BODY = 256 * 1024
DIAG_MAX_BYTES = 20 * 1024 * 1024
MAX_POINTS = 20000
MAX_UPSTREAM_BYTES = 30 * 1024 * 1024
DEFAULT_BUFFER_M = 60
BOX_LIMIT_KM2 = 9500.0
TIMEOUT_S = 10

# Zuordnung Meldung -> Route (siehe auf_route und README "Zuordnung").
KORRIDOR_STADT_M = 25.0      # Stadt/Landstrasse: so weit darf eine Meldungslinie neben der Route liegen
KORRIDOR_AUTOBAHN_M = 60.0   # Autobahn: Richtungsfahrbahnen liegen bis ~45 m auseinander
PUNKT_MAX_M = 25.0           # Meldung nur als Punkt: hoechstens so weit neben der Route
UEBERLAPP_MIN_M = 80.0       # so viel Meldungslinie muss mindestens entlang der Route laufen
UEBERLAPP_ANTEIL = 0.6       # ... und mindestens dieser Anteil ihrer Laenge
RICHTUNG_MIN_COS = 0.7       # Meldungsrichtung vs. Routenrichtung (~45 Grad)
QUER_SPANNE_M = 30.0         # wandert die Meldung im Korridor seitlich weiter als das, quert sie die Route
MATCH_SCHRITT_M = 10.0       # Probenabstand auf der Meldungslinie
MATCH_MAX_PROBEN = 3000
ENDPUNKTE_AB_M = 200.0       # Meldung aus nur zwei Punkten, weiter auseinander: Start/Ende-Pruefung statt Proben
AUTOBAHN_FENSTER_M = 1000.0  # autobahnartig: so weit vor und nach dem Segment keine scharfe Kurve
AUTOBAHN_MIN_ROUTE_M = 1000.0
SCHARF_GRAD = 35.0           # scharfe Kurve: mehr Richtungswechsel als das ...
SCHARF_STRECKE_M = 60.0      # ... innerhalb dieser Strecke (Abbiegen an einer Kreuzung, Kreisverkehr)
AUTOBAHN_NUMMER = re.compile(r"^\s*[AS]\s?-?\d{1,3}\s*$", re.I)  # A1, S10 (AT), A8 (DE)
DUBLETTE_M = 300.0           # gleiche Art, so nah beieinander und aehnlicher Von/Nach-Text = dieselbe Meldung
KNOTEN_FENSTER_M = 1500.0    # Nachbarmeldungen so weit entlang der Route bestimmen die "Hauptstrasse"
RAMPE_MIN_M = 200.0          # Meldung auf einer fremden Strassennummer: mindestens so viel Ueberlappung
STRASSEN_NR = re.compile(r"\b([ABEMS])\s?-?(\d{1,3})\b")  # A8, B158, S10, auch im Text "(A8)"
BEIDE_RICHTUNGEN = re.compile(r"beide[n]? richtung|both directions|in beiden richtungen", re.I)

SPERRE = threading.Lock()
ZAEHLER = {"route": 0, "cached": 0, "denied": 0, "bad": 0, "tomtomCalls": 0, "tomtomFlowCalls": 0, "asfinagCalls": 0, "upstreamErrors": 0}
M_PER_DEG = 111320.0


def jetzt():
    return time.time()


# ------------------------------------------------------------------ Anmeldung

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


# ------------------------------------------------------------------ Geometrie

def polyline_dekodieren(text, precision=6):
    """Google-Polyline (Valhalla: 6 Nachkommastellen) -> [(lat, lon)]."""
    faktor = 10.0 ** precision
    punkte, i, lat, lon = [], 0, 0, 0
    n = len(text)
    while i < n:
        werte = []
        for _ in range(2):
            ergebnis, shift = 0, 0
            while True:
                if i >= n:
                    raise ValueError("polyline truncated")
                b = ord(text[i]) - 63
                i += 1
                ergebnis |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            werte.append(~(ergebnis >> 1) if ergebnis & 1 else ergebnis >> 1)
        lat += werte[0]
        lon += werte[1]
        punkte.append((lat / faktor, lon / faktor))
    return punkte


def _ok_punkt(lat, lon):
    return (isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and not isinstance(lat, bool)
            and not isinstance(lon, bool) and math.isfinite(lat) and math.isfinite(lon) and abs(lat) <= 90 and abs(lon) <= 180)


def form_lesen(wert):
    """Body -> Liste (lat, lon) oder ValueError."""
    if not isinstance(wert, dict):
        raise ValueError("body must be an object")
    shape = wert.get("shape")
    if isinstance(shape, str):
        precision = wert.get("precision", 6)
        if precision not in (5, 6):
            raise ValueError("precision must be 5 or 6")
        punkte = polyline_dekodieren(shape.strip(), precision)
    elif isinstance(shape, list):
        punkte = []
        for p in shape[:MAX_POINTS + 1]:
            if not (isinstance(p, (list, tuple)) and len(p) >= 2 and _ok_punkt(p[0], p[1])):
                raise ValueError("shape points must be [lat, lon]")
            punkte.append((float(p[0]), float(p[1])))
    else:
        raise ValueError("shape missing")
    punkte = [p for p in punkte if _ok_punkt(p[0], p[1])]
    if len(punkte) < 2:
        raise ValueError("shape needs at least two points")
    if len(punkte) > MAX_POINTS:
        raise ValueError("shape too long")
    return punkte


def abstand_m(a, b):
    mlon = M_PER_DEG * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((a[0] - b[0]) * M_PER_DEG, (a[1] - b[1]) * mlon)


def _richtung(a, b):
    """Einheitsvektor (ost, nord) von a nach b in Metern, None wenn a == b."""
    mlon = M_PER_DEG * math.cos(math.radians((a[0] + b[0]) / 2))
    dx, dy = (b[1] - a[1]) * mlon, (b[0] - a[0]) * M_PER_DEG
    l = math.hypot(dx, dy)
    return None if l < 1e-6 else (dx / l, dy / l)


def verdichten(punkte, schritt_m=MATCH_SCHRITT_M, max_proben=MATCH_MAX_PROBEN):
    """Linie -> Proben [(punkt, richtung, laenge_m)] alle ~schritt_m; laenge = Stueck, fuer das die Probe steht."""
    gesamt = sum(abstand_m(punkte[i], punkte[i + 1]) for i in range(len(punkte) - 1))
    schritt = max(schritt_m, gesamt / max_proben) if gesamt > 0 else schritt_m
    out = []
    for i in range(len(punkte) - 1):
        a, b = punkte[i], punkte[i + 1]
        l = abstand_m(a, b)
        r = _richtung(a, b)
        if r is None:
            continue
        n = max(1, int(math.ceil(l / schritt)))
        for k in range(n):
            t = (k + 0.5) / n
            out.append(((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])), r, l / n))
    return out


def ausduennen(punkte, schritt_m=20.0):
    """Punkte naeher als schritt_m am vorigen fallen weg (Anfang und Ende bleiben)."""
    if len(punkte) <= 2:
        return list(punkte)
    out = [punkte[0]]
    for p in punkte[1:-1]:
        if abstand_m(out[-1], p) >= schritt_m:
            out.append(p)
    out.append(punkte[-1])
    return out


class Route:
    """Route mit Strecke entlang jedes Punkts und einem Raster der Segmente fuer schnelle Projektion."""

    ZELLE = 0.01  # Grad, ~1 km

    def __init__(self, punkte):
        self.p = list(punkte)
        self.entlang = [0.0]
        for i in range(1, len(self.p)):
            self.entlang.append(self.entlang[-1] + abstand_m(self.p[i - 1], self.p[i]))
        self.laenge = self.entlang[-1]
        self.raster = {}
        for i in range(len(self.p) - 1):
            a, b = self.p[i], self.p[i + 1]
            for zy in range(self._z(min(a[0], b[0])), self._z(max(a[0], b[0])) + 1):
                for zx in range(self._z(min(a[1], b[1])), self._z(max(a[1], b[1])) + 1):
                    self.raster.setdefault((zy, zx), []).append(i)
        # Richtung je Segment (Einheitsvektor in Metern, Ost/Nord; None bei Laenge 0) und
        # ob das Segment autobahnartig ist (nur aus der Linie geschaetzt, siehe _autobahnartig).
        self.richtung = [_richtung(self.p[i], self.p[i + 1]) for i in range(len(self.p) - 1)]
        self.autobahn = self._autobahnartig()

    def _autobahnartig(self):
        """Segment i gilt als autobahnartig, wenn ±AUTOBAHN_FENSTER_M um seine Mitte keine scharfe Kurve liegt
        (mehr als SCHARF_GRAD Richtungswechsel innerhalb SCHARF_STRECKE_M) und die Route lang genug ist.
        Staedte haben Abbiegungen an Kreuzungen, Autobahnen nur weite Boegen."""
        n = len(self.p) - 1
        if self.laenge < AUTOBAHN_MIN_ROUTE_M:
            return [False] * n
        # Richtungswechsel an jedem inneren Punkt (Grad), Segmente der Laenge 0 uebersprungen.
        knicke = []  # (entlang_m, grad)
        vorher = None
        for i in range(n):
            r = self.richtung[i]
            if r is None:
                continue
            if vorher is not None:
                c = max(-1.0, min(1.0, r[0] * vorher[0] + r[1] * vorher[1]))
                knicke.append((self.entlang[i], math.degrees(math.acos(c))))
            vorher = r
        scharf = []
        j0, summe = 0, 0.0
        for j in range(len(knicke)):  # gleitendes Fenster der Laenge SCHARF_STRECKE_M
            summe += knicke[j][1]
            while knicke[j][0] - knicke[j0][0] > SCHARF_STRECKE_M:
                summe -= knicke[j0][1]
                j0 += 1
            if summe > SCHARF_GRAD:
                scharf.append(knicke[j][0])
        out = []
        k = 0
        for i in range(n):
            mitte = (self.entlang[i] + self.entlang[i + 1]) / 2
            while k < len(scharf) and scharf[k] < mitte - AUTOBAHN_FENSTER_M:
                k += 1
            out.append(not (k < len(scharf) and scharf[k] <= mitte + AUTOBAHN_FENSTER_M))
        return out

    def seitlich(self, punkt, seg):
        """Vorzeichenbehafteter Abstand (m) von punkt zur Geraden durch Segment seg (+ links, - rechts)
        und Lage entlang dieser Geraden ab dem Segmentanfang (m, negativ = davor)."""
        r = self.richtung[seg]
        if r is None:
            return 0.0, 0.0
        a = self.p[seg]
        mlon = M_PER_DEG * math.cos(math.radians(a[0]))
        dx, dy = (punkt[1] - a[1]) * mlon, (punkt[0] - a[0]) * M_PER_DEG
        return r[0] * dy - r[1] * dx, r[0] * dx + r[1] * dy

    def _z(self, v):
        return int(math.floor(v / self.ZELLE))

    def projizieren(self, punkt, puffer_m):
        """-> (abstand_m, entlang_m, segment) des naechsten Segments, oder None wenn weiter als puffer_m."""
        lat, lon = punkt
        # Nachbarzellen bis puffer_m (in Laengengraden gerechnet, die sind schmaler als Breitengrade).
        r = max(1, int(math.ceil(puffer_m / (M_PER_DEG * max(0.05, math.cos(math.radians(lat)))) / self.ZELLE)))
        zy, zx = self._z(lat), self._z(lon)
        kandidaten = set()
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                kandidaten.update(self.raster.get((zy + dy, zx + dx), ()))
        mlon = M_PER_DEG * math.cos(math.radians(lat))
        best = None
        for i in kandidaten:
            a, b = self.p[i], self.p[i + 1]
            ax, ay = (a[1] - lon) * mlon, (a[0] - lat) * M_PER_DEG
            bx, by = (b[1] - lon) * mlon, (b[0] - lat) * M_PER_DEG
            dx, dy = bx - ax, by - ay
            l2 = dx * dx + dy * dy
            t = 0.0 if l2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / l2))
            d = math.hypot(ax + t * dx, ay + t * dy)
            if best is None or d < best[0] or (d == best[0] and i < best[2]):
                best = (d, self.entlang[i] + t * math.sqrt(l2), i)
        if best is None or best[0] > puffer_m:
            return None
        return best

    def punkt_bei(self, entlang_m):
        if entlang_m <= 0:
            return self.p[0]
        for i in range(1, len(self.p)):
            if self.entlang[i] >= entlang_m:
                seg = self.entlang[i] - self.entlang[i - 1]
                t = 0 if seg == 0 else (entlang_m - self.entlang[i - 1]) / seg
                a, b = self.p[i - 1], self.p[i]
                return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
        return self.p[-1]


def rechtecke(route, puffer_m=500.0, max_anzahl=TOMTOM_MAX_BOXES, grenze_km2=BOX_LIMIT_KM2):
    """Route -> Rechtecke (sued, west, nord, ost), je hoechstens grenze_km2 gross (TomTom: 10 000 km^2)."""
    def flaeche(b):
        s, w, n, e = b
        return ((n - s) * 111.32) * ((e - w) * 111.32 * math.cos(math.radians((s + n) / 2)))

    def weiten(b):
        s, w, n, e = b
        dlat = puffer_m / M_PER_DEG
        dlon = puffer_m / (M_PER_DEG * max(0.1, math.cos(math.radians((s + n) / 2))))
        return (s - dlat, w - dlon, n + dlat, e + dlon)

    lats = [p[0] for p in route.p]
    lons = [p[1] for p in route.p]
    ganz = weiten((min(lats), min(lons), max(lats), max(lons)))
    if flaeche(ganz) <= grenze_km2:
        return [ganz]
    strecke = max(route.laenge / max_anzahl, 5000.0)
    out, box, start = [], None, 0.0
    for i, p in enumerate(route.p):
        neu = box is None or route.entlang[i] - start > strecke
        if not neu:
            probe = (min(box[0], p[0]), min(box[1], p[1]), max(box[2], p[0]), max(box[3], p[1]))
            if flaeche(weiten(probe)) > grenze_km2:
                neu = True
        if neu:
            if box is not None:
                box = (min(box[0], p[0]), min(box[1], p[1]), max(box[2], p[0]), max(box[3], p[1]))
                out.append(box)
            box, start = (p[0], p[1], p[0], p[1]), route.entlang[i]
        else:
            box = probe
    if box is not None:
        out.append(box)
    return [weiten(b) for b in out]


# ------------------------------------------------------------------ Netz

def holen(url, kopf=None, timeout=TIMEOUT_S):
    """GET -> (status, bytes). In Tests ersetzt. Fehler werfen."""
    req = urllib.request.Request(url, headers=dict(kopf or {}, **{"User-Agent": "quietglass-glass-traffic/1"}))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            daten = r.read(MAX_UPSTREAM_BYTES + 1)
            if len(daten) > MAX_UPSTREAM_BYTES:
                raise ValueError("upstream answer too large")
            return r.status, daten
    except urllib.error.HTTPError as e:
        return e.code, b""


class Zwischenspeicher:
    def __init__(self, sekunden, groesse=64):
        self.s, self.groesse, self.d = sekunden, groesse, {}
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            v = self.d.get(key)
            if v and jetzt() - v[0] < self.s:
                return v[1]
            return None

    def put(self, key, wert):
        with self.lock:
            if len(self.d) >= self.groesse:
                aeltester = min(self.d, key=lambda k: self.d[k][0])
                del self.d[aeltester]
            self.d[key] = (jetzt(), wert)


ROUTEN_CACHE = Zwischenspeicher(CACHE_S, 64)
TOMTOM_CACHE = Zwischenspeicher(CACHE_S, 256)
ASFINAG_CACHE = Zwischenspeicher(CACHE_S, 1)
ASFINAG_LOCK = threading.Lock()


# ------------------------------------------------------------------ TomTom

TOMTOM_FIELDS = ("{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,"
                 "events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers}}}")
# 0 unbekannt, 1 Unfall, 6 Stau, 7 Spur gesperrt, 8 Strasse gesperrt, 9 Baustelle, 14 Pannenfahrzeug
TOMTOM_KATEGORIEN = "0,1,6,7,8,9,14"
TOMTOM_TYP = {1: "accident", 6: "jam", 8: "closure", 9: "roadwork"}


def tomtom_url(box):
    s, w, n, e = box
    q = urllib.parse.urlencode({
        "key": TOMTOM_KEY,
        "bbox": "%.5f,%.5f,%.5f,%.5f" % (w, s, e, n),
        "fields": TOMTOM_FIELDS,
        "language": TOMTOM_LANGUAGE,
        "categoryFilter": TOMTOM_KATEGORIEN,
        "timeValidityFilter": "present",
    })
    return "%s/traffic/services/5/incidentDetails?%s" % (TOMTOM_BASE, q)


def tomtom_lesen(wert):
    """TomTom incidentDetails v5 -> gemeinsame Form (ohne Lage auf der Route)."""
    out = []
    for inc in (wert or {}).get("incidents") or []:
        if not isinstance(inc, dict):
            continue
        prop = inc.get("properties") or {}
        geo = inc.get("geometry") or {}
        koord = geo.get("coordinates")
        punkte = []
        if geo.get("type") == "Point" and isinstance(koord, list) and len(koord) >= 2:
            koord = [koord]
        for c in koord if isinstance(koord, list) else []:
            if isinstance(c, list) and len(c) >= 2 and _ok_punkt(c[1], c[0]):
                punkte.append((float(c[1]), float(c[0])))
        if not punkte:
            continue
        kat = prop.get("iconCategory")
        typ = TOMTOM_TYP.get(kat, "other")
        m = {"id": "tt:%s" % str(prop.get("id") or len(out))[:64], "type": typ, "source": "tomtom", "geometry": punkte}
        delay = prop.get("delay")
        if isinstance(delay, (int, float)) and not isinstance(delay, bool) and delay > 0:
            m["delayMin"] = int(round(delay / 60.0))
        laenge = prop.get("length")
        if isinstance(laenge, (int, float)) and not isinstance(laenge, bool) and laenge > 0:
            m["lengthKm"] = round(laenge / 1000.0, 1)
        for k in ("from", "to"):
            if isinstance(prop.get(k), str) and prop[k].strip():
                m[k] = prop[k].strip()[:80]
        events = prop.get("events") or []
        if events and isinstance(events[0], dict) and isinstance(events[0].get("description"), str):
            m["text"] = events[0]["description"].strip()[:80]
        # Interne Hinweise fuer die Zuordnung (Schluessel mit "_" gehen nie in die Antwort):
        # Strassenkategorie aus der Strassennummer, beide Richtungen aus dem Meldungstext.
        # Keine Nummer: Kategorie unbekannt, dann entscheidet die Form der Route.
        nummern = [x for x in (prop.get("roadNumbers") or []) if isinstance(x, str) and x.strip()]
        if nummern:
            m["_autobahn"] = any(AUTOBAHN_NUMMER.match(x) for x in nummern)
        strassen = {a + b for x in nummern for a, b in STRASSEN_NR.findall(x.upper())}
        if not strassen:  # roadNumbers gehen vor; der Text nennt bei Rampen oft beide Autobahnen
            for k in ("from", "to"):
                strassen |= {a + b for a, b in STRASSEN_NR.findall(str(m.get(k, "")).upper())}
        if strassen:
            m["_strassen"] = sorted(strassen)
        texte = [e.get("description") for e in events if isinstance(e, dict) and isinstance(e.get("description"), str)]
        if any(BEIDE_RICHTUNGEN.search(t) for t in texte):
            m["_beide"] = True
        out.append(m)
    return out


def tomtom_flow_url(punkt):
    q = urllib.parse.urlencode({"key": TOMTOM_KEY, "point": "%.5f,%.5f" % punkt, "unit": "KMPH"})
    return "%s/traffic/services/4/flowSegmentData/absolute/10/json?%s" % (TOMTOM_BASE, q)


def tomtom_flow_lesen(wert, nr):
    """flowSegmentData -> Stau-Meldung, wenn deutlich langsamer als frei; sonst None."""
    seg = (wert or {}).get("flowSegmentData")
    if not isinstance(seg, dict):
        return None
    punkte = []
    for c in ((seg.get("coordinates") or {}).get("coordinate") or []):
        if isinstance(c, dict) and _ok_punkt(c.get("latitude"), c.get("longitude")):
            punkte.append((float(c["latitude"]), float(c["longitude"])))
    if not punkte:
        return None
    # Functional Road Class: FRC0 Autobahn, FRC1 Schnellstrasse.
    frc = seg.get("frc")
    extra = {"_autobahn": frc in ("FRC0", "FRC1")} if isinstance(frc, str) and frc.startswith("FRC") else {}
    if seg.get("roadClosure") is True:
        return dict({"id": "ttf:%d" % nr, "type": "closure", "source": "tomtom-flow", "geometry": punkte}, **extra)
    jetzt_kmh, frei_kmh = seg.get("currentSpeed"), seg.get("freeFlowSpeed")
    t_jetzt, t_frei = seg.get("currentTravelTime"), seg.get("freeFlowTravelTime")
    conf = seg.get("confidence", 1)
    if not all(isinstance(v, (int, float)) for v in (jetzt_kmh, frei_kmh, t_jetzt, t_frei)):
        return None
    if frei_kmh <= 0 or conf < 0.5 or jetzt_kmh > 0.6 * frei_kmh or t_jetzt - t_frei < 60:
        return None
    return dict({"id": "ttf:%d" % nr, "type": "jam", "source": "tomtom-flow", "geometry": punkte,
                 "delayMin": int(round((t_jetzt - t_frei) / 60.0))}, **extra)


def tomtom_meldungen(route):
    """-> (liste, status). status: off|ok|error."""
    if not TOMTOM_KEY:
        return [], "off"
    out, fehler, ok, gesehen = [], 0, 0, set()
    for box in rechtecke(route):
        key = "%.3f,%.3f,%.3f,%.3f" % box
        liste = TOMTOM_CACHE.get(key)
        if liste is None:
            try:
                status, daten = holen(tomtom_url(box))
                ZAEHLER["tomtomCalls"] += 1
                if status != 200:
                    raise ValueError("HTTP %d" % status)
                liste = tomtom_lesen(json.loads(daten.decode("utf-8")))
                TOMTOM_CACHE.put(key, liste)
            except Exception as e:  # noqa: BLE001 - nie den Schluessel ausgeben
                fehler += 1
                ZAEHLER["upstreamErrors"] += 1
                print("tomtom incidents: %s" % type(e).__name__, flush=True)
                continue
        ok += 1
        # Overlapping boxes return the same TomTom incident twice: one per id.
        for meldung in liste:
            mid = meldung.get("id")
            if mid and mid in gesehen:
                continue
            if mid:
                gesehen.add(mid)
            out.append(meldung)
    if TOMTOM_FLOW_SAMPLES and route.laenge > 0:
        for nr in range(TOMTOM_FLOW_SAMPLES):
            entlang = route.laenge * (nr + 0.5) / TOMTOM_FLOW_SAMPLES
            punkt = route.punkt_bei(entlang)
            key = "flow:%.3f,%.3f" % punkt
            m = TOMTOM_CACHE.get(key)
            if m is None:
                try:
                    status, daten = holen(tomtom_flow_url(punkt))
                    ZAEHLER["tomtomFlowCalls"] += 1
                    if status != 200:
                        raise ValueError("HTTP %d" % status)
                    m = tomtom_flow_lesen(json.loads(daten.decode("utf-8")), nr) or {}
                    TOMTOM_CACHE.put(key, m)
                except Exception as e:  # noqa: BLE001
                    ZAEHLER["upstreamErrors"] += 1
                    print("tomtom flow: %s" % type(e).__name__, flush=True)
                    continue
            if m:
                out.append(m)
    if fehler and not ok:
        return out, "error"
    return out, "ok"


# ------------------------------------------------------------------ ASFINAG DATEX II

def _lokal(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _xsi_typ(el):
    for k, v in el.attrib.items():
        if _lokal(k) == "type":
            return v.rsplit(":", 1)[-1]
    return ""


def _kinder(el, name):
    return [c for c in el.iter() if _lokal(c.tag) == name]


def _text(el, name):
    for c in el.iter():
        if _lokal(c.tag) == name and c.text and c.text.strip():
            return c.text.strip()
    return ""


def _datex_zeit(text):
    """'2026-10-14T10:00:00+02:00' / '...Z' -> epoch s, oder None."""
    if not text:
        return None
    try:
        from datetime import datetime
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _datex_typ(record):
    x = _xsi_typ(record)
    if x == "AbnormalTraffic":
        return "jam"
    if x == "Accident":
        return "accident"
    if x in ("MaintenanceWorks", "ConstructionWorks", "Roadworks"):
        return "roadwork"
    if x in ("RoadOrCarriagewayOrLaneManagement", "RoadOrCarriagewayOrLaneManagementType"):
        art = _text(record, "roadOrCarriagewayOrLaneManagementType") or _text(record, "roadOrCarriagewayOrLaneManagementTypeExtension")
        if art in ("roadClosed", "carriagewayClosures", "closedPermanentlyForTheWinter"):
            return "closure"
        return "roadwork" if "lane" in art.lower() else "other"
    if x == "GeneralNetworkManagement" and "closure" in (_text(record, "generalNetworkManagementType") or "").lower():
        return "closure"
    return "other"


def _datex_beide(rec):
    """Gilt der Eintrag fuer beide Richtungen? (v2 tpegDirection/directionRelative, v3 direction*: both/bothWays/allDirections)"""
    for el in rec.iter():
        if "irection" in _lokal(el.tag) and el.text and el.text.strip() in ("both", "bothWays", "allDirections"):
            return True
    return False


def _ecke(rec, namen):
    """Erster Koordinatenpunkt unter einem Element mit einem dieser Namen, oder None."""
    for el in rec.iter():
        if _lokal(el.tag) in namen:
            for pc in el.iter():
                if _lokal(pc.tag) == "pointCoordinates":
                    try:
                        p = (float(_text(pc, "latitude")), float(_text(pc, "longitude")))
                    except ValueError:
                        continue
                    if _ok_punkt(p[0], p[1]):
                        return p
    return None


def datex_lesen(xml_bytes, nun=None):
    """DATEX II v2/v3 SituationPublication -> gemeinsame Form. Unbekanntes wird uebersprungen, nie geraten."""
    nun = jetzt() if nun is None else nun
    wurzel = ET.fromstring(xml_bytes)
    out = []
    for rec in _kinder(wurzel, "situationRecord"):
        status = _text(rec, "validityStatus")
        if status == "suspended":
            continue
        ende = _datex_zeit(_text(rec, "overallEndTime"))
        if ende is not None and ende < nun:
            continue
        # Erst die eigentlichen Koordinaten (Punkt bzw. Start/Ende einer Linie, in Fahrtrichtung),
        # nur ohne sie der Anzeigepunkt.
        # TPEG-Linien schreiben `to` VOR `from`: Start und Ende werden ausdruecklich geordnet.
        start, ende_p = _ecke(rec, ("from", "linearCoordinatesStartPoint")), _ecke(rec, ("to", "linearCoordinatesEndPoint"))
        punkte = [start, ende_p] if start and ende_p and start != ende_p else []
        for namen in (() if punkte else ("pointCoordinates",), ("locationForDisplay", "coordinatesForDisplay")):
            if punkte:
                break
            for pc in rec.iter():
                if _lokal(pc.tag) not in namen:
                    continue
                try:
                    p = (float(_text(pc, "latitude")), float(_text(pc, "longitude")))
                except ValueError:
                    continue
                if _ok_punkt(p[0], p[1]) and p not in punkte:
                    punkte.append(p)
            if punkte:
                break
        if not punkte:
            continue
        # ASFINAG betreibt nur Autobahnen und Schnellstrassen: immer der breite Korridor.
        m = {"id": "asf:%s" % (rec.attrib.get("id") or len(out))[:64], "type": _datex_typ(rec), "source": "asfinag", "geometry": punkte,
             "_autobahn": True}
        if _datex_beide(rec):
            m["_beide"] = True
        try:
            delay = float(_text(rec, "delayTimeValue"))
            if delay > 0:
                m["delayMin"] = int(round(delay / 60.0))
        except ValueError:
            pass
        for name in ("queueLength", "lengthAffected"):
            try:
                laenge = float(_text(rec, name))
                if laenge > 0:
                    m["lengthKm"] = round(laenge / 1000.0, 1)
                    break
            except ValueError:
                pass
        kommentar = ""
        for c in _kinder(rec, "comment"):
            for v in _kinder(c, "value"):
                if v.text and v.text.strip():
                    if not kommentar or (v.attrib.get("lang") == "de"):
                        kommentar = v.text.strip()
            if kommentar:
                break
        if kommentar:
            m["text"] = " ".join(kommentar.split())[:80]
        out.append(m)
    return out


def asfinag_meldungen():
    """-> (liste, status). Der ganze Strom hoechstens alle 2 min, egal wie viele Anfragen."""
    if not ASFINAG_URL:
        return [], "off"
    with ASFINAG_LOCK:
        gemerkt = ASFINAG_CACHE.get("feed")
        if gemerkt is not None:
            return gemerkt
        kopf = {"Accept": "application/xml"}
        if ASFINAG_USER:
            kopf["Authorization"] = "Basic " + base64.b64encode(("%s:%s" % (ASFINAG_USER, ASFINAG_PASSWORD)).encode()).decode()
        try:
            status, daten = holen(ASFINAG_URL, kopf, timeout=20)
            ZAEHLER["asfinagCalls"] += 1
            if status != 200:
                raise ValueError("HTTP %d" % status)
            if daten[:2] == b"\x1f\x8b":
                import gzip
                daten = gzip.decompress(daten)
            ergebnis = (datex_lesen(daten), "ok")
        except Exception as e:  # noqa: BLE001
            ZAEHLER["upstreamErrors"] += 1
            print("asfinag: %s" % type(e).__name__, flush=True)
            ergebnis = ([], "error")
        # Auch ein Fehler wird 2 min gemerkt: kein Sturm auf die Quelle.
        ASFINAG_CACHE.put("feed", ergebnis)
        return ergebnis


# ------------------------------------------------------------------ Zusammenfuehren

def _korridor(route, seg, m, puffer_m):
    """Erlaubter Abstand Meldungslinie <-> Route an Segment seg; buffer_m des Clients ist die Obergrenze."""
    # Strassenkategorie der Meldung (TomTom-Strassennummer/FRC, ASFINAG) geht vor der Schaetzung aus der Linie.
    breit = m["_autobahn"] if "_autobahn" in m else route.autobahn[seg]
    return min(KORRIDOR_AUTOBAHN_M if breit else KORRIDOR_STADT_M, puffer_m)


def _gleiche_richtung(route, seg, r, beide):
    rr = route.richtung[seg]
    if rr is None or r is None:
        return True
    c = rr[0] * r[0] + rr[1] * r[1]
    return c >= RICHTUNG_MIN_COS or (beide and -c >= RICHTUNG_MIN_COS)


def _noetig(laenge_m):
    """Mindest-Ueberlappung fuer eine Meldungslinie dieser Laenge: max(60 %, 80 m); kuerzere als 80 m zu 80 %."""
    if laenge_m < UEBERLAPP_MIN_M:
        return 0.8 * laenge_m
    return max(UEBERLAPP_ANTEIL * laenge_m, UEBERLAPP_MIN_M)


def _zuordnen_endpunkte(m, route, puffer_m):
    """Linie nur aus Start und Ende (ASFINAG linear, TPEG from/to): beide Enden im Korridor und in
    Fahrtrichtung geordnet, die Strecke entlang der Route passt zur Laenge. Reicht die Meldung ueber
    den Anfang/das Ende der geschickten Linie hinaus (man steht schon im Stau), genuegt ein Ende."""
    geo = m["geometry"]
    weit = min(puffer_m, KORRIDOR_AUTOBAHN_M)
    sehne = abstand_m(geo[0], geo[1])
    varianten = [(geo[0], geo[1])] + ([(geo[1], geo[0])] if m.get("_beide") else [])
    for a, b in varianten:
        pa, pb = route.projizieren(a, weit), route.projizieren(b, weit)
        if pa and pa[0] > _korridor(route, pa[2], m, puffer_m):
            pa = None
        if pb and pb[0] > _korridor(route, pb[2], m, puffer_m):
            pb = None
        r = _richtung(a, b)
        if pa and pb:
            lauf = pb[1] - pa[1]
            if lauf >= _noetig(sehne) and lauf <= 3 * sehne + 500:
                return pa[1], min(pa[0], pb[0])
        elif pb and not pa:
            # Start liegt vor dem Anfang der Linie (man steht schon drin): er muss auf der Verlaengerung des
            # ersten Segments nach hinten liegen, im Korridor, und die Meldung muss in Fahrtrichtung laufen.
            quer, laengs = route.seitlich(a, 0)
            if (laengs < 0 and abs(quer) <= _korridor(route, 0, m, puffer_m) and pb[1] >= UEBERLAPP_MIN_M
                    and _gleiche_richtung(route, 0, r, False)):
                return 0.0, pb[0]
        elif pa and not pb:
            # Ende liegt hinter dem Ende der Linie: entsprechend auf der Verlaengerung des letzten Segments.
            letzt = len(route.p) - 2
            quer, laengs = route.seitlich(b, letzt)
            seg_l = route.entlang[letzt + 1] - route.entlang[letzt]
            if (laengs > seg_l and abs(quer) <= _korridor(route, letzt, m, puffer_m) and route.laenge - pa[1] >= UEBERLAPP_MIN_M
                    and _gleiche_richtung(route, letzt, r, False)):
                return pa[1], pa[0]
    return None


def zuordnen(m, route, puffer_m, info=None):
    """Liegt die Meldung wirklich AUF der Route in Fahrtrichtung? -> (alongM, offM) oder None.

    - Punkt (keine Linie): hoechstens PUNKT_MAX_M neben der Route.
    - Linie: in Proben alle ~10 m zerlegt; eine Probe zaehlt, wenn sie im Korridor liegt (Stadt 25 m,
      autobahnartig 60 m, nie mehr als buffer_m) UND ihre Richtung zur Route passt (cos >= 0.7; bei
      Meldungen fuer beide Richtungen auch entgegen). Die zaehlenden Proben muessen zusammen mindestens
      max(60 % der Meldungslaenge, 80 m) lang sein. Querstrassen (kreuzen nur), Parallelstrassen
      ausserhalb des Korridors und die Gegenfahrbahn fallen so weg.
    - alongM = Strecke entlang der Route bis zum Beginn der Ueberlappung, offM = kleinster Abstand dort.
    - info (dict, optional): bekommt "ueberM" = Laenge der Ueberlappung (fuer den Rampen-Filter).
    """
    info = info if info is not None else {}
    geo = m["geometry"]
    laenge = sum(abstand_m(geo[i], geo[i + 1]) for i in range(len(geo) - 1))
    if len(geo) == 1 or laenge < 1.0:
        pr = route.projizieren(geo[0], min(PUNKT_MAX_M, puffer_m))
        info["ueberM"] = 0.0
        return (pr[1], pr[0]) if pr else None
    if len(geo) == 2 and laenge > ENDPUNKTE_AB_M:
        info["ueberM"] = laenge
        return _zuordnen_endpunkte(m, route, puffer_m)
    weit = min(puffer_m, KORRIDOR_AUTOBAHN_M)
    # Schneller Vorab-Test: grobe Proben alle 50 m; liegt keine in Reichweite, ist die Meldung weit weg.
    if not any(route.projizieren(p, weit + 30) for p, _, _ in verdichten(geo, 50.0, 400)):
        return None
    beide = bool(m.get("_beide"))
    gesamt, ueber, entlang, ab, seite = 0.0, 0.0, [], [], []
    # Kurze Linien (< 80 m) koennen nicht 80 m ueberlappen: sie muessen wie ein Punkt eng (25 m) an der
    # Route liegen und zusaetzlich in Fahrtrichtung laufen.
    kurz = laenge < UEBERLAPP_MIN_M
    for punkt, r, stueck in verdichten(geo):
        gesamt += stueck
        pr = route.projizieren(punkt, weit)
        if not pr:
            continue
        korridor = min(_korridor(route, pr[2], m, puffer_m), PUNKT_MAX_M) if kurz else _korridor(route, pr[2], m, puffer_m)
        if pr[0] > korridor or not _gleiche_richtung(route, pr[2], r, beide):
            continue
        ueber += stueck
        entlang.append(pr[1])
        ab.append(pr[0])
        seite.append(route.seitlich(punkt, pr[2])[0])
    if not entlang:
        return None
    # Querung: eine Strasse, die schraeg ueber die Route laeuft, wandert im Korridor von einer Seite zur
    # anderen; eine Meldung auf der Route (oder der eigenen Richtungsfahrbahn) bleibt im gleichen Abstand.
    if max(seite) - min(seite) > QUER_SPANNE_M:
        return None
    if ueber < _noetig(gesamt):
        # Ausnahme: die Meldung reicht ueber Anfang/Ende der geschickten Linie hinaus (man steht schon drin,
        # oder sie geht hinter dem Ziel weiter) - dann zaehlt nur der Teil auf der Linie, aber mindestens 80 m.
        am_rand = min(entlang) <= 30 or max(entlang) >= route.laenge - 30
        if not (am_rand and ueber >= min(UEBERLAPP_MIN_M, 0.8 * gesamt)):
            return None
    info["ueberM"] = ueber
    return min(entlang), min(ab)


def auf_route(meldungen, route, puffer_m):
    """Nur Meldungen wirklich auf der Route (Fahrtrichtung beachtet), mit alongM/offM; sortiert.
    Danach fliegen Rampen/Querautobahnen an Knoten raus (_ohne_rampen)."""
    gefunden = []
    for m in meldungen:
        info = {}
        lage = zuordnen(m, route, puffer_m, info)
        if lage is not None:
            gefunden.append((m, lage, info.get("ueberM", 0.0)))
    out = []
    for m, lage, _ in _ohne_rampen(gefunden):
        n = {k: v for k, v in m.items() if not k.startswith("_")}
        n["alongM"] = int(round(lage[0]))
        n["offM"] = int(round(lage[1]))
        geo = m["geometry"]
        n["point"] = [round(geo[0][0], 5), round(geo[0][1], 5)]
        schritt = max(1, len(geo) // 20)
        n["geometry"] = [[round(p[0], 5), round(p[1], 5)] for p in geo[::schritt][:20]]
        out.append(n)
    out.sort(key=lambda x: (x["alongM"], x["id"]))
    return out


def _ohne_rampen(gefunden):
    """Knoten-Filter. Die App schickt nur Geometrie, die Strasse der Route ist also unbekannt - sie wird aus den
    Nachbarn abgeleitet. Traegt eine Meldung Strassennummern (TomTom roadNumbers oder "(A8)" im Von/Nach-Text),
    zaehlt je Nummer die Ueberlappung aller ANDEREN Meldungen mit Nummer innerhalb KNOTEN_FENSTER_M entlang der
    Route (Abstand zwischen den Ueberlappungen); die Nummer mit der laengsten Ueberlappung ist die Hauptstrasse. Traegt die Meldung diese Nummer nicht
    und liegt weniger als RAMPE_MIN_M auf der Route, ist es eine Rampe/Querautobahn am Knoten -> raus.
    Drin bleibt: lange Ueberlappung (Route wechselt die Autobahn), keine Nummer, keine Nachbarn mit Nummer."""
    out = []
    for i, (m, lage, ueber) in enumerate(gefunden):
        nr = set(m.get("_strassen") or ())
        if nr and ueber < RAMPE_MIN_M:
            gewicht = {}
            for j, (o, olage, oueber) in enumerate(gefunden):
                if j != i and max(olage[0] - (lage[0] + ueber), lage[0] - (olage[0] + oueber)) <= KNOTEN_FENSTER_M:
                    for x in o.get("_strassen") or ():
                        gewicht[x] = gewicht.get(x, 0.0) + max(oueber, 1.0)
            if gewicht and max(gewicht, key=gewicht.get) not in nr:
                continue
        out.append((m, lage, ueber))
    return out


RANG = {"closure": 0, "accident": 1, "jam": 2, "roadwork": 3, "other": 4}


def _norm_text(t):
    """Von/Nach-Text vergleichbar machen: klein, ohne Satzzeichen/Klammern, als Wortmenge."""
    return frozenset(re.sub(r"[^\w ]+", " ", str(t or "").lower()).split())


def _aehnlich(a, b):
    """Von/Nach zweier Meldungen gleich genug (Wortmengen-Jaccard >= 0.6)? Beide leer = ja, nur eine leer = nein."""
    for k in ("from", "to"):
        x, y = _norm_text(a.get(k)), _norm_text(b.get(k))
        if not x and not y:
            continue
        if not x or not y or len(x & y) / len(x | y) < 0.6:
            return False
    return True


def _dublette(o, m):
    """Dieselbe Sache doppelt gemeldet (auch aus derselben Quelle): gleiche Art, innerhalb DUBLETTE_M entlang
    der Route und aehnlicher Von/Nach-Text."""
    return o["type"] == m["type"] and abs(o["alongM"] - m["alongM"]) <= DUBLETTE_M and _aehnlich(o, m)


def zusammenfuehren(liste, naehe_m=600):
    """Gleiche Art an fast derselben Stelle -> eine Meldung (die mit Verzoegerung gewinnt, max. Verzoegerung).
    - zwei verschiedene Quellen: gleiche Art innerhalb naehe_m.
    - gleiche oder verschiedene Quelle: gleiche Art innerhalb 300 m und aehnlicher Von/Nach-Text (_dublette).
    - Flow-Stau in einer gemeldeten Stau-/Sperr-/Unfallmeldung (2 km) ist dieselbe Sache."""
    out = []
    for m in liste:
        gleich = None
        for o in out:
            if o["type"] == m["type"] and abs(o["alongM"] - m["alongM"]) <= naehe_m and o["source"].split("+")[0] != m["source"]:
                gleich = o
                break
            if _dublette(o, m):
                gleich = o
                break
            # Flow-Stau, der in einer gemeldeten Stau-/Sperrmeldung liegt, ist dieselbe Sache.
            if m["source"] == "tomtom-flow" and o["type"] in ("jam", "closure", "accident") and abs(o["alongM"] - m["alongM"]) <= 2000:
                gleich = o
                break
        if gleich is None:
            out.append(m)
            continue
        if m["source"] == "tomtom-flow" and gleich["source"] != "tomtom-flow":
            continue  # Flow ergaenzt eine gemeldete Sache nicht
        quellen = sorted(set(gleich["source"].split("+")) | {m["source"]})
        if m.get("delayMin", 0) > gleich.get("delayMin", 0):
            for k in ("delayMin", "lengthKm", "text", "from", "to"):
                if k in m:
                    gleich[k] = m[k]
        for k in ("lengthKm", "text", "from", "to"):
            if k not in gleich and k in m:
                gleich[k] = m[k]
        gleich["source"] = "+".join(quellen)
    return out


def verkehr_fuer_route(punkte, puffer_m):
    """Kern von POST /traffic/route; gecacht CACHE_S je (ausgeduennter) Form und Puffer."""
    punkte = ausduennen(punkte)
    puffer_m = max(10, min(500, int(puffer_m)))
    schluessel = hashlib.sha256(("%d|" % puffer_m + ";".join("%.4f,%.4f" % p for p in punkte)).encode()).hexdigest()
    gemerkt = ROUTEN_CACHE.get(schluessel)
    if gemerkt is not None:
        ZAEHLER["cached"] += 1
        return dict(gemerkt, cached=True)
    route = Route(punkte)
    tt, tt_status = tomtom_meldungen(route)
    asf, asf_status = asfinag_meldungen()
    liste = zusammenfuehren(auf_route(tt + asf, route, puffer_m))
    for m in liste:
        m.setdefault("text", "")
    ergebnis = {
        "incidents": liste,
        "delayMin": sum(m.get("delayMin", 0) for m in liste),
        "routeM": int(round(route.laenge)),
        "sources": {"tomtom": tt_status, "asfinag": asf_status},
        "at": int(jetzt() * 1000),
        "cached": False,
    }
    ROUTEN_CACHE.put(schluessel, ergebnis)
    return ergebnis


# ------------------------------------------------------------------ HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "GlassTraffic/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        origin = self.headers.get("Origin")
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Vary", "Origin")

    def _json(self, code, daten, form="-", t0=None):
        body = json.dumps(daten, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        ms = (time.time() - t0) * 1000 if t0 else 0
        # Nie Koordinaten oder Schluessel ins Log: nur Pfad, Code, Anmeldeform, Dauer.
        print("%s %s %d %s %.0fms" % (self.command, self.path.split("?")[0][:40], code, form, ms), flush=True)

    def _diag(self, form, t0):
        """Diagnose-Protokoll der Brillen-App (Schritte, Zeiten, Fehler - keine Positionen).
        Wird nur angehaengt (DIAG_FILE), bei DIAG_MAX_BYTES einmal rotiert."""
        try:
            laenge = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            laenge = -1
        if laenge <= 0 or laenge > DIAG_MAX_BODY:
            return self._json(413 if laenge > DIAG_MAX_BODY else 400, {"error": "body size"}, form, t0)
        try:
            wert = json.loads(self.rfile.read(laenge).decode("utf-8"))
            if not isinstance(wert, dict) or not isinstance(wert.get("events"), list):
                raise ValueError("events missing")
        except (ValueError, UnicodeDecodeError) as e:
            return self._json(400, {"error": str(e)[:80]}, form, t0)
        try:
            if os.path.exists(DIAG_FILE) and os.path.getsize(DIAG_FILE) > DIAG_MAX_BYTES:
                os.replace(DIAG_FILE, DIAG_FILE + ".1")
            with open(DIAG_FILE, "a", encoding="utf-8") as f:
                kopf = {"rx": round(time.time(), 3), "app": str(wert.get("app", ""))[:40], "ver": str(wert.get("ver", ""))[:20], "sid": str(wert.get("sid", ""))[:20]}
                for ev in wert["events"][:500]:
                    f.write(json.dumps({**kopf, "ev": ev}, ensure_ascii=True)[:4000] + "\n")
        except OSError as e:
            return self._json(500, {"error": "write " + type(e).__name__}, form, t0)
        return self._json(200, {"ok": True, "n": len(wert["events"])}, form, t0)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        t0 = time.time()
        if self.path.split("?")[0] == "/health":
            return self._json(200, {"ok": True, "tomtom": bool(TOMTOM_KEY), "tomtomFlowSamples": TOMTOM_FLOW_SAMPLES if TOMTOM_KEY else 0,
                                    "asfinag": bool(ASFINAG_URL), **ZAEHLER}, "-", t0)
        ok, form = anmeldung(self.client_address[0], self.headers)
        if not ok:
            ZAEHLER["denied"] += 1
            return self._json(401, {"error": "unauthorized"}, form, t0)
        return self._json(404, {"error": "not found"}, form, t0)

    def do_POST(self):
        t0 = time.time()
        ok, form = anmeldung(self.client_address[0], self.headers)
        if not ok:
            ZAEHLER["denied"] += 1
            return self._json(401, {"error": "unauthorized"}, form, t0)
        if self.path.split("?")[0] == "/diag":
            return self._diag(form, t0)
        if self.path.split("?")[0] != "/traffic/route":
            return self._json(404, {"error": "not found"}, form, t0)
        try:
            laenge = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            laenge = -1
        if laenge <= 0 or laenge > MAX_BODY:
            ZAEHLER["bad"] += 1
            return self._json(413 if laenge > MAX_BODY else 400, {"error": "body size"}, form, t0)
        try:
            wert = json.loads(self.rfile.read(laenge).decode("utf-8"))
            punkte = form_lesen(wert)
            puffer = wert.get("buffer_m", DEFAULT_BUFFER_M)
            if not isinstance(puffer, (int, float)) or isinstance(puffer, bool) or not math.isfinite(puffer):
                puffer = DEFAULT_BUFFER_M
        except (ValueError, UnicodeDecodeError) as e:
            ZAEHLER["bad"] += 1
            return self._json(400, {"error": str(e)[:80]}, form, t0)
        ZAEHLER["route"] += 1
        return self._json(200, verkehr_fuer_route(punkte, puffer), form, t0)


def main():
    if not NUTZER and not TOKEN:
        print("WARNUNG: weder TRAFFIC_TAILSCALE_USERS noch TRAFFIC_TOKEN gesetzt - alles bleibt gesperrt", flush=True)
    print("glass-traffic auf %s:%d, TomTom %s (Flow %d), ASFINAG %s" % (
        HOST, PORT, "an" if TOMTOM_KEY else "aus", TOMTOM_FLOW_SAMPLES if TOMTOM_KEY else 0, "an" if ASFINAG_URL else "aus"), flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
