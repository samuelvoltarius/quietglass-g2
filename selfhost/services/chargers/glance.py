#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ladestationen fuer die Brille (OpenGlance) - aus der eigenen Stationstabelle.

Warum nicht live: die Brille fragt "in der Naehe" und "entlang der Route"
(bis zu 24 Kaesten auf einmal). Live waeren das bis zu 24 E-Control-Abfragen
mit je 100er-Deckel; aus der Tabelle ist es eine Abfrage unter 100 ms.
Quellen der Tabelle: E-Control (AT, taeglich, Collector `econtrol_stationen`)
und das Ladesaeulenregister der BNetzA (DE, monatlich). Belegtstatus gibt es
hier bewusst NICHT - eine Tabelle von heute frueh weiss nicht, ob die Saeule
jetzt frei ist.

Antwortformat = das einer Overpass-Abfrage `out center tags` (Elemente mit
`tags` nach OSM-Schema), damit der vorhandene Parser der App unveraendert
weiterarbeitet. Zusaetzlich `x:price_eur_kwh` (amtlicher Ad-hoc-Preis aus
E-Control, nur wenn plausibel) und `x:source`.
"""

import math
import re
import sqlite3
import threading
import time

MAX_KAESTEN = 40
MAX_KASTEN_GRAD = 1.0
MAX_RADIUS_M = 50_000
MAX_ELEMENTE = 3000
# Unter 10 Cent ist ein Preis fast immer ein Meldefehler des Betreibers
# (siehe naehe.py), ueber 3 EUR ein Datenfehler. Beides wird nicht gezeigt.
PREIS_MIN, PREIS_MAX = 0.10, 3.0

_preis_cache = {"zeit": 0.0, "preise": {}}
_preis_lock = threading.Lock()


def haversine_m(a_lat, a_lon, b_lat, b_lon):
    r = 6_371_000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = math.radians(b_lat - a_lat), math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


# ------------------------------------------------------------ Parameter

def kaesten_lesen(text):
    """'s,w,n,e;s,w,n,e' -> Liste von Kaesten. ValueError bei allem Unsinn."""
    kaesten = []
    for teil in (text or "").replace("|", ";").split(";"):
        teil = teil.strip()
        if not teil:
            continue
        werte = [float(x) for x in teil.split(",")]
        if len(werte) != 4 or not all(math.isfinite(v) for v in werte):
            raise ValueError("Kasten braucht s,w,n,e")
        s, w, n, e = werte
        if not (-90 <= s < n <= 90 and -180 <= w < e <= 180):
            raise ValueError("Kasten ungueltig")
        if n - s > MAX_KASTEN_GRAD or e - w > MAX_KASTEN_GRAD:
            raise ValueError("Kasten zu gross (max %.1f Grad)" % MAX_KASTEN_GRAD)
        kaesten.append((s, w, n, e))
    if not kaesten:
        raise ValueError("kein Kasten")
    if len(kaesten) > MAX_KAESTEN:
        raise ValueError("zu viele Kaesten (max %d)" % MAX_KAESTEN)
    return kaesten


def umkreis_kasten(lat, lon, radius_m):
    if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("lat/lon ungueltig")
    if not (0 < radius_m <= MAX_RADIUS_M):
        raise ValueError("radius 1..%d m" % MAX_RADIUS_M)
    dlat = radius_m / 111_320.0
    dlon = radius_m / (111_320.0 * max(0.1, math.cos(math.radians(lat))))
    return (lat - dlat, lon - dlon, lat + dlat, lon + dlon)


# --------------------------------------------------------------- Preise

def _preise(con, max_alter_s=600):
    """evse -> Ad-hoc-Preis je kWh (amtlich). Ganz geladen und 10 min gehalten:
    regel hat keinen Index auf station_id, und es sind nur ~30.000 Zeilen."""
    with _preis_lock:
        if time.time() - _preis_cache["zeit"] < max_alter_s:
            return _preis_cache["preise"]
        preise = {}
        try:
            zeilen = con.execute(
                "SELECT r.station_id, r.preis_kwh, r.startgebuehr, r.preis_min"
                " FROM regel r JOIN tarif t ON t.id = r.tarif_id"
                " WHERE t.ist_adhoc = 1 AND r.quelle_typ = 'amtlich' AND r.station_id <> '*'"
                " AND (r.gueltig_bis IS NULL OR r.gueltig_bis >= date('now'))").fetchall()
        except sqlite3.OperationalError:
            zeilen = []   # nur Stationen, keine Tarif-Tabellen: dann eben ohne Preise
        for r in zeilen:
            pk = r[1]
            if pk is None or not (PREIS_MIN <= pk <= PREIS_MAX):
                continue
            alt = preise.get(r[0])
            if alt is None or pk < alt[0]:
                preise[r[0]] = (pk, r[2] or 0.0, r[3] or 0.0)
        _preis_cache.update(zeit=time.time(), preise=preise)
        return preise


# ------------------------------------------------------------ Stecker

def stecker_arten(text):
    """Steckertexte beider Quellen -> {'combo','chademo','type2'}.
    E-Control: 'TYPE_2_AC;CCS_2' (consumerName); BNetzA: 'DC Fahrzeugkupplung
    Typ Combo 2 (CCS)', 'AC Typ 2 Steckdose', 'DC CHAdeMO'."""
    t = (text or "").upper()
    arten = set()
    if re.search(r"CCS|COMBO", t):
        arten.add("combo")
    if "CHADEMO" in t:
        arten.add("chademo")
    # "Typ 2" auch als Teil von "Combo 2"? Nur zaehlen, wenn ein eigener Typ-2-Eintrag da ist.
    for teil in re.split(r"[;,/]", t):
        if re.search(r"TYP(E)?[ _]?2", teil) and not re.search(r"CCS|COMBO", teil):
            arten.add("type2")
    return arten


# -------------------------------------------------------------- Abfrage

def _zeilen(con, kaesten):
    gesehen, out = set(), []
    for s, w, n, e in kaesten:
        for r in con.execute(
                "SELECT evse_id, land, lat, lon, name, betreiber, kw, ladepunkte, stecker,"
                " status, quelle, stand FROM station"
                " WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?", (s, n, w, e)):
            if r[0] in gesehen:
                continue
            gesehen.add(r[0])
            status = (r[9] or "").lower()
            if status and status not in ("active", "in betrieb"):
                continue
            out.append(r)
    return out


def standorte(zeilen, preise):
    """Mehrere EVSE am selben Ort und vom selben Betreiber = ein Standort."""
    orte = {}
    for evse, land, lat, lon, name, betreiber, kw, ladepunkte, stecker, _st, quelle, stand in zeilen:
        schluessel = (round(lat, 4), round(lon, 4), (betreiber or name or "").strip().lower())
        o = orte.get(schluessel)
        if o is None:
            o = orte[schluessel] = {
                "id": evse, "lat": lat, "lon": lon, "name": name or "", "betreiber": betreiber or "",
                "kw": None, "punkte": 0, "combo": 0, "chademo": 0, "type2": 0,
                "preis": None, "preis_kw": -1.0, "quelle": quelle or "", "stand": stand or "",
            }
        n = ladepunkte if (ladepunkte and evse.startswith("DE*BNETZA*")) else 1
        o["punkte"] += n
        for art in stecker_arten(stecker):
            o[art] += n
        kw = kw or 0
        if kw and (o["kw"] is None or kw > o["kw"]):
            o["kw"] = kw
        p = preise.get(evse)
        # Preis des staerksten Ladepunkts (bei gleicher Leistung der guenstigste).
        if p and (kw > o["preis_kw"] or (kw == o["preis_kw"] and (o["preis"] is None or p[0] < o["preis"][0]))):
            o["preis"], o["preis_kw"] = p, kw
        if stand and stand > o["stand"]:
            o["stand"] = stand
    return _nahe_zusammen(list(orte.values()))


ZUSAMMEN_M = 60


def _nahe_zusammen(orte):
    """Gleicher Name + Betreiber im Umkreis von 60 m = ein Standort. E-Control
    fuehrt einen Ladepark oft als mehrere Stationen ein paar Meter auseinander;
    auf der Brille saehe das aus wie drei Orte, wo einer ist."""
    gruppen = {}
    for o in orte:
        gruppen.setdefault(((o["name"] or "").strip().lower(), (o["betreiber"] or "").strip().lower()), []).append(o)
    out = []
    for liste in gruppen.values():
        rest = []
        for o in liste:
            ziel = next((r for r in rest if haversine_m(r["lat"], r["lon"], o["lat"], o["lon"]) <= ZUSAMMEN_M), None)
            if ziel is None:
                rest.append(o)
                continue
            for k in ("punkte", "combo", "chademo", "type2"):
                ziel[k] += o[k]
            if o["kw"] and (ziel["kw"] is None or o["kw"] > ziel["kw"]):
                ziel["kw"] = o["kw"]
            if o["preis"] and (o["preis_kw"] > ziel["preis_kw"] or (o["preis_kw"] == ziel["preis_kw"] and (ziel["preis"] is None or o["preis"][0] < ziel["preis"][0]))):
                ziel["preis"], ziel["preis_kw"] = o["preis"], o["preis_kw"]
            if o["stand"] > ziel["stand"]:
                ziel["stand"] = o["stand"]
        out.extend(rest)
    return out


def _kw_text(kw):
    return ("%d kW" % kw) if float(kw).is_integer() else ("%.1f kW" % kw)


def als_element(o):
    quelle = o["quelle"] or ""
    kurz = "E-Control" if quelle.startswith("E-Control") else ("BNetzA" if "Bundesnetzagentur" in quelle else quelle)
    tags = {"amenity": "charging_station", "x:source": kurz}
    if o["name"]:
        tags["name"] = o["name"]
    if o["betreiber"]:
        tags["operator"] = o["betreiber"]
    if o["kw"]:
        tags["charging_station:output"] = _kw_text(o["kw"])
    if o["punkte"]:
        tags["capacity"] = str(o["punkte"])
    for art, key in (("combo", "socket:type2_combo"), ("chademo", "socket:chademo"), ("type2", "socket:type2")):
        if o[art]:
            tags[key] = str(o[art])
    if o["preis"]:
        pk, start, pmin = o["preis"]
        tags["x:price_eur_kwh"] = "%.2f" % pk
        if start:
            tags["x:start_fee_eur"] = "%.2f" % start
        if pmin:
            tags["x:price_eur_min"] = "%.2f" % pmin
    return {"type": "node", "id": o["id"], "lat": round(o["lat"], 6), "lon": round(o["lon"], 6), "tags": tags}


def abfrage(con, kaesten, mitte=None, radius_m=None):
    """Elemente fuer die Kaesten; mit Mitte+Radius genau gefiltert und nach Entfernung sortiert."""
    orte = standorte(_zeilen(con, kaesten), _preise(con))
    if mitte is not None:
        mit_d = [(haversine_m(mitte[0], mitte[1], o["lat"], o["lon"]), o) for o in orte]
        orte = [o for d, o in sorted(mit_d, key=lambda x: x[0]) if d <= radius_m]
    stand = max((o["stand"] for o in orte), default="")
    return {
        "version": 0.6,
        "generator": "ev-planer glance",
        "stand": stand,
        "elements": [als_element(o) for o in orte[:MAX_ELEMENTE]],
    }


def verbinden(pfad):
    con = sqlite3.connect("file:%s?mode=ro" % pfad, uri=True, timeout=10)
    con.execute("PRAGMA busy_timeout=10000")
    return con
