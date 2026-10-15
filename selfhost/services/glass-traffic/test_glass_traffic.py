"""glass_traffic: parsing, merging, distance along the route, caching, HTTP.

    python3 -m unittest test_glass_traffic      (or: python3 -m pytest test_glass_traffic.py)
Stdlib only, no network beyond 127.0.0.1: TomTom and ASFINAG answers are made-up fixtures
(fixtures/), no real keys or data in the repo.
"""
import json, os, sys, threading, unittest, urllib.error, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glass_traffic as gt  # noqa: E402

HIER = os.path.dirname(os.path.abspath(__file__))
TOMTOM = open(os.path.join(HIER, "fixtures", "tomtom_incidents.json"), "rb").read()
DATEX = open(os.path.join(HIER, "fixtures", "asfinag_datex.xml"), "rb").read()
# West -> east along 47.80 N, about 15 km.
SHAPE = [[47.80, 13.00], [47.80, 13.05], [47.80, 13.10], [47.80, 13.15], [47.80, 13.20]]


def encode6(points):
    out, last = [], [0, 0]
    for lat, lon in points:
        for i, v in enumerate((round(lat * 1e6), round(lon * 1e6))):
            d = v - last[i]
            last[i] = v
            d = ~(d << 1) if d < 0 else d << 1
            while d >= 0x20:
                out.append(chr((0x20 | (d & 0x1F)) + 63))
                d >>= 5
            out.append(chr(d + 63))
    return "".join(out)


class FakeUpstream:
    """Stands in for holen(): records every URL, answers from fixtures."""

    def __init__(self, flow_slow=True):
        self.urls, self.headers, self.flow_slow = [], [], flow_slow

    def __call__(self, url, kopf=None, timeout=10):
        self.urls.append(url)
        self.headers.append(kopf or {})
        if "incidentDetails" in url:
            return 200, TOMTOM
        if "flowSegmentData" in url:
            point = url.split("point=")[1].split("&")[0].replace("%2C", ",")
            lat, lon = (float(x) for x in point.split(","))
            seg = {"flowSegmentData": {"currentSpeed": 30 if self.flow_slow else 95, "freeFlowSpeed": 100, "currentTravelTime": 300,
                                       "freeFlowTravelTime": 100, "confidence": 0.9, "roadClosure": False,
                                       "coordinates": {"coordinate": [{"latitude": lat, "longitude": lon - 0.005}, {"latitude": lat, "longitude": lon + 0.005}]}}}
            return 200, json.dumps(seg).encode()
        if url.startswith("https://datex.example"):
            return 200, DATEX
        return 404, b""


class Base(unittest.TestCase):
    def setUp(self):
        self.saved = {k: getattr(gt, k) for k in ("TOMTOM_KEY", "TOMTOM_FLOW_SAMPLES", "ASFINAG_URL", "ASFINAG_USER", "ASFINAG_PASSWORD", "holen", "TOKEN", "NUTZER")}
        gt.TOMTOM_KEY = "test-key-not-real"
        gt.TOMTOM_FLOW_SAMPLES = 0
        gt.ASFINAG_URL = "https://datex.example/feed"
        gt.ASFINAG_USER = "user"
        gt.ASFINAG_PASSWORD = "pass"
        self.up = FakeUpstream()
        gt.holen = self.up
        for c in (gt.ROUTEN_CACHE, gt.TOMTOM_CACHE, gt.ASFINAG_CACHE):
            c.d.clear()

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(gt, k, v)


class Parsing(Base):
    def test_tomtom_incidents_map_to_the_common_shape(self):
        out = gt.tomtom_lesen(json.loads(TOMTOM))
        jam = next(m for m in out if m["id"] == "tt:fake-jam-1")
        self.assertEqual(jam["type"], "jam")
        self.assertEqual(jam["delayMin"], 9)
        self.assertEqual(jam["lengthKm"], 1.5)
        self.assertEqual(jam["from"], "Beispielknoten West")
        self.assertEqual(jam["geometry"][0], (47.8, 13.05))  # [lon, lat] turned round
        self.assertEqual(next(m for m in out if m["id"] == "tt:fake-closure")["type"], "closure")

    def test_datex_records_skip_suspended_and_expired_and_order_tpeg_lines(self):
        out = gt.datex_lesen(DATEX)
        ids = [m["id"] for m in out]
        self.assertEqual(ids, ["asf:R-JAM", "asf:R-WORKS"])
        jam = out[0]
        self.assertEqual(jam["type"], "jam")
        self.assertEqual(jam["delayMin"], 10)
        self.assertEqual(jam["lengthKm"], 1.8)
        self.assertEqual(jam["text"], "Stau zwischen Beispielknoten West und Ost")
        # `from` first although the XML lists `to` first.
        self.assertEqual(jam["geometry"], [(47.8, 13.0505), (47.8, 13.07)])
        self.assertEqual(out[1]["type"], "roadwork")

    def test_polyline_and_point_lists_are_both_accepted(self):
        a = gt.form_lesen({"shape": encode6(SHAPE)})
        b = gt.form_lesen({"shape": SHAPE})
        self.assertEqual(len(a), len(b))
        self.assertAlmostEqual(a[-1][1], 13.20, places=5)
        for bad in ({}, {"shape": [[1, 2]]}, {"shape": [["x", 1], [1, 2]]}, {"shape": "??", "precision": 7}):
            with self.assertRaises(ValueError):
                gt.form_lesen(bad)

    def test_flow_marks_only_clearly_slow_segments(self):
        slow = {"flowSegmentData": {"currentSpeed": 30, "freeFlowSpeed": 100, "currentTravelTime": 400, "freeFlowTravelTime": 100,
                                    "confidence": 0.9, "coordinates": {"coordinate": [{"latitude": 47.8, "longitude": 13.1}]}}}
        self.assertEqual(gt.tomtom_flow_lesen(slow, 0)["delayMin"], 5)
        fine = json.loads(json.dumps(slow))
        fine["flowSegmentData"]["currentSpeed"] = 80
        self.assertIsNone(gt.tomtom_flow_lesen(fine, 0))
        unsure = json.loads(json.dumps(slow))
        unsure["flowSegmentData"]["confidence"] = 0.2
        self.assertIsNone(gt.tomtom_flow_lesen(unsure, 0))


class AlongRoute(Base):
    def test_distance_along_route_direction_and_merge(self):
        r = gt.verkehr_fuer_route(gt.form_lesen({"shape": SHAPE}), 60)
        ids = [m["id"] for m in r["incidents"]]
        # Opposite carriageway and the far-away closure are gone; TomTom and ASFINAG jam merged into one.
        self.assertNotIn("tt:fake-jam-opposite", ids)
        self.assertNotIn("tt:fake-far", ids)
        self.assertEqual(ids, ["tt:fake-jam-1", "tt:fake-closure", "asf:R-WORKS"])
        jam = r["incidents"][0]
        self.assertEqual(jam["source"], "asfinag+tomtom")
        self.assertEqual(jam["delayMin"], 10)  # the larger delay wins
        self.assertAlmostEqual(jam["alongM"], 3750, delta=40)
        closure = r["incidents"][1]
        self.assertAlmostEqual(closure["alongM"], 11250, delta=60)
        self.assertLessEqual(closure["offM"], 15)
        self.assertEqual(r["delayMin"], 10)
        self.assertEqual(r["sources"], {"tomtom": "ok", "asfinag": "ok"})

    def test_flow_jams_join_unless_a_report_covers_them(self):
        gt.TOMTOM_FLOW_SAMPLES = 2
        r = gt.verkehr_fuer_route(gt.form_lesen({"shape": SHAPE}), 60)
        flow = [m for m in r["incidents"] if m["source"] == "tomtom-flow"]
        # Sample 1 lies at 3.75 km inside the reported jam (dropped); sample 2 at 11.25 km is near only a closure.
        self.assertEqual(len(flow), 1)
        self.assertEqual(r["delayMin"], 10 + 3)

    def test_asfinag_basic_auth_and_key_only_to_tomtom(self):
        gt.verkehr_fuer_route(gt.form_lesen({"shape": SHAPE}), 60)
        datex = [h for u, h in zip(self.up.urls, self.up.headers) if u.startswith("https://datex.example")]
        self.assertTrue(datex[0]["Authorization"].startswith("Basic "))
        self.assertNotIn("test-key-not-real", "".join(u for u in self.up.urls if not u.startswith(gt.TOMTOM_BASE)))
        # TomTom gets a box, never a single "position".
        tt = [u for u in self.up.urls if "incidentDetails" in u][0]
        self.assertIn("bbox=", tt)

    def test_long_routes_are_split_into_boxes_under_the_tomtom_area_limit(self):
        long_route = gt.Route([(47.0 + i * 0.05, 9.5 + i * 0.07) for i in range(60)])  # ~ 500 km
        boxes = gt.rechtecke(long_route)
        self.assertGreater(len(boxes), 1)
        self.assertLessEqual(len(boxes), gt.TOMTOM_MAX_BOXES + 2)
        for s, w, n, e in boxes:
            area = (n - s) * 111.32 * (e - w) * 111.32 * __import__("math").cos(__import__("math").radians((s + n) / 2))
            self.assertLess(area, 10000)

    def test_answers_are_cached_two_minutes_and_sources_fetched_once(self):
        punkte = gt.form_lesen({"shape": SHAPE})
        a = gt.verkehr_fuer_route(punkte, 60)
        n = len(self.up.urls)
        b = gt.verkehr_fuer_route(punkte, 60)
        self.assertEqual(len(self.up.urls), n)
        self.assertFalse(a["cached"])
        self.assertTrue(b["cached"])
        # Another route: TomTom asked again, the ASFINAG feed is not (one fetch per 2 min).
        gt.verkehr_fuer_route(punkte[:-1], 60)
        self.assertEqual(sum(1 for u in self.up.urls if u.startswith("https://datex.example")), 1)

    def test_sources_off_without_configuration(self):
        gt.TOMTOM_KEY = ""
        gt.ASFINAG_URL = ""
        r = gt.verkehr_fuer_route(gt.form_lesen({"shape": SHAPE}), 60)
        self.assertEqual(r["incidents"], [])
        self.assertEqual(r["sources"], {"tomtom": "off", "asfinag": "off"})
        self.assertEqual(self.up.urls, [])

    def test_same_incident_from_overlapping_boxes_is_reported_once(self):
        long_route = gt.Route([(47.0 + i * 0.05, 9.5 + i * 0.07) for i in range(60)])
        self.assertGreater(len(gt.rechtecke(long_route)), 1)
        feed = {"incidents": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [9.5, 47.0]},
                               "properties": {"id": "same", "iconCategory": 6, "events": [{"description": "Stau"}]}}]}
        gt.holen = lambda url, kopf=None, timeout=10: (200, json.dumps(feed).encode()) if "incidentDetails" in url else (404, b"")
        gt.TOMTOM_FLOW_SAMPLES = 0
        liste, status = gt.tomtom_meldungen(long_route)
        self.assertEqual(status, "ok")
        self.assertEqual([m["id"] for m in liste], ["tt:same"])

    def test_upstream_failure_is_reported_not_raised(self):
        gt.holen = lambda url, kopf=None, timeout=10: (503, b"")
        r = gt.verkehr_fuer_route(gt.form_lesen({"shape": SHAPE}), 60)
        self.assertEqual(r["sources"], {"tomtom": "error", "asfinag": "error"})


O_LAT, O_LON = 47.80, 13.00
M_LON = gt.M_PER_DEG * __import__("math").cos(__import__("math").radians(O_LAT))


def xy(x, y):
    """Metres east/north of a made-up origin -> (lat, lon)."""
    return (O_LAT + y / gt.M_PER_DEG, O_LON + x / M_LON)


def line(*pts):
    return [xy(x, y) for x, y in pts]


def inc(geo, typ="closure", ident="x", **extra):
    return dict({"id": ident, "type": typ, "source": "tomtom", "geometry": geo}, **extra)


# Town: a staircase of 300 m blocks with right-angle turns. Motorway: 5 km dead straight.
TOWN = gt.Route(line((0, 0), (300, 0), (300, 300), (600, 300), (600, 600), (900, 600)))
MOTORWAY = gt.Route(line(*[(x, 0) for x in range(0, 5001, 250)]))


def ids(route, incidents, buffer_m=60):
    return [m["id"] for m in gt.auf_route(incidents, route, buffer_m)]


class Matching(unittest.TestCase):
    def test_corridor_is_tight_in_town_and_wide_on_motorways(self):
        self.assertEqual(set(TOWN.autobahn), {False})
        self.assertEqual(set(MOTORWAY.autobahn), {True})
        self.assertEqual(gt._korridor(TOWN, 0, {}, 60), 25)
        self.assertEqual(gt._korridor(MOTORWAY, 0, {}, 60), 60)
        self.assertEqual(gt._korridor(TOWN, 0, {"_autobahn": True}, 60), 60)
        self.assertEqual(gt._korridor(MOTORWAY, 0, {}, 30), 30)  # the client's buffer_m caps it

    def test_side_street_crossing_the_route_is_dropped(self):
        self.assertEqual(ids(TOWN, [inc(line((150, -100), (150, 100)))]), [])
        # even with a large buffer from an old client
        self.assertEqual(ids(TOWN, [inc(line((150, -100), (150, 100)))], 200), [])

    def test_parallel_street_40m_away_in_town_is_dropped(self):
        self.assertEqual(ids(TOWN, [inc(line((20, 40), (280, 40)))]), [])  # two points only
        self.assertEqual(ids(TOWN, [inc(line((20, 40), (150, 40), (280, 40)))]), [])  # dense line
        self.assertEqual(ids(TOWN, [inc(line((20, 40), (150, 40), (280, 40)))], 200), [])

    def test_slanted_crossing_inside_the_wide_corridor_is_dropped(self):
        # 45 degrees passes the direction test, but it walks from one side of the route to the other.
        self.assertEqual(ids(MOTORWAY, [inc(line((1000, -80), (1080, 0), (1160, 80)))]), [])

    def test_incident_along_the_route_in_driving_direction_is_kept(self):
        out = gt.auf_route([inc(line((50, 5), (150, 5), (250, 5)), ident="on")], TOWN, 60)
        self.assertEqual([m["id"] for m in out], ["on"])
        self.assertAlmostEqual(out[0]["alongM"], 50, delta=10)
        self.assertLessEqual(out[0]["offM"], 6)
        # Also around a corner: 150 m on block 1, 150 m on block 2.
        out = gt.auf_route([inc(line((150, 3), (300, 3), (303, 150)), ident="corner")], TOWN, 60)
        self.assertEqual([m["id"] for m in out], ["corner"])
        self.assertAlmostEqual(out[0]["alongM"], 150, delta=10)

    def test_opposite_carriageway_on_a_motorway_is_dropped(self):
        self.assertEqual(ids(MOTORWAY, [inc(line((3000, 40), (2500, 40), (2000, 40)), "jam")]), [])
        self.assertEqual(ids(MOTORWAY, [inc(line((3000, 0), (2000, 0)), "jam", _autobahn=True)]), [])

    def test_motorway_carriageway_45m_off_is_kept(self):
        out = gt.auf_route([inc(line((2000, -45), (2500, -45), (3000, -45)), "jam", "mw")], MOTORWAY, 60)
        self.assertEqual([m["id"] for m in out], ["mw"])
        self.assertAlmostEqual(out[0]["alongM"], 2000, delta=15)
        self.assertAlmostEqual(out[0]["offM"], 45, delta=2)

    def test_closure_for_both_directions_is_kept_either_way(self):
        reverse = line((250, 0), (150, 0), (50, 0))
        self.assertEqual(ids(TOWN, [inc(reverse, ident="both", _beide=True)]), ["both"])
        self.assertEqual(ids(TOWN, [inc(reverse, ident="one-way")]), [])

    def test_point_incident_needs_25m(self):
        self.assertEqual(ids(TOWN, [inc([xy(100, 20)], ident="p20")]), ["p20"])
        self.assertEqual(ids(TOWN, [inc([xy(100, 60)], ident="p60")]), [])
        self.assertEqual(ids(MOTORWAY, [inc([xy(1000, 60)], ident="p60mw")]), [])

    def test_short_overlap_is_dropped_but_a_jam_we_are_already_in_counts(self):
        # 300 m incident, only 60 m of it along the route, then it turns away.
        self.assertEqual(ids(TOWN, [inc(line((200, 0), (260, 0), (260, -240)))]), [])
        # A 2 km jam starting 1 km behind the start of the line sent: kept from 0 m.
        jam = inc(line((-1000, 0), (-500, 0), (0, 0), (500, 0), (1000, 0)), "jam", "inside")
        out = gt.auf_route([jam], MOTORWAY, 60)
        self.assertEqual([(m["id"], m["alongM"]) for m in out], [("inside", 0)])

    def test_start_end_only_lines_use_the_ends(self):
        # ASFINAG style: two points, km apart, on a motorway.
        fwd = inc(line((1000, -20), (2500, -20)), "jam", "fwd", _autobahn=True)
        back = inc(line((2500, 30), (1000, 30)), "jam", "back", _autobahn=True)
        cross = inc(line((1500, -400), (1600, 400)), "closure", "cross", _autobahn=True)
        started = inc(line((-800, 0), (700, 0)), "jam", "started", _autobahn=True)
        out = gt.auf_route([fwd, back, cross, started], MOTORWAY, 60)
        self.assertEqual([(m["id"], m["alongM"]) for m in out], [("started", 0), ("fwd", 1000)])

    def test_internal_hints_never_reach_the_answer(self):
        out = gt.auf_route([inc(line((50, 5), (250, 5)), ident="on", _autobahn=True, _beide=True)], TOWN, 60)
        self.assertEqual(sorted(out[0]), ["alongM", "geometry", "id", "offM", "point", "source", "type"])

    def test_hints_are_read_from_both_sources(self):
        tt = gt.tomtom_lesen({"incidents": [
            {"geometry": {"type": "LineString", "coordinates": [[13.0, 47.8], [13.01, 47.8]]},
             "properties": {"id": "a", "iconCategory": 8, "roadNumbers": ["A1"], "events": [{"description": "In beiden Richtungen gesperrt"}]}},
            {"geometry": {"type": "LineString", "coordinates": [[13.0, 47.8], [13.01, 47.8]]},
             "properties": {"id": "b", "iconCategory": 8, "roadNumbers": ["B158"], "events": [{"description": "Gesperrt"}]}}]})
        self.assertTrue(tt[0].get("_autobahn") and tt[0].get("_beide"))
        self.assertFalse(tt[1].get("_autobahn") or tt[1].get("_beide"))
        xml = (b'<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
               b'<situationRecord xsi:type="RoadOrCarriagewayOrLaneManagement" id="B"><validity><validityStatus>active</validityStatus></validity>'
               b'<groupOfLocations xsi:type="Point"><pointByCoordinates><pointCoordinates><latitude>47.8</latitude><longitude>13.1</longitude>'
               b'</pointCoordinates></pointByCoordinates></groupOfLocations><tpegDirection>bothWays</tpegDirection>'
               b'<roadOrCarriagewayOrLaneManagementType>roadClosed</roadOrCarriagewayOrLaneManagementType></situationRecord></d2LogicalModel>')
        d = gt.datex_lesen(xml)[0]
        self.assertTrue(d["_autobahn"] and d["_beide"])


class DedupeAndInterchange(unittest.TestCase):
    """Duplicates and ramps at junctions. Synthetic geometry, made-up road names."""

    def merged(self, incidents, route=MOTORWAY, buffer_m=60):
        return gt.zusammenfuehren(gt.auf_route(incidents, route, buffer_m))

    def test_identical_records_from_the_same_source_become_one(self):
        a = inc(line((1000, -10), (1400, -10)), "jam", "a", **{"from": "Musterstadt (A1)", "to": "Beispieldorf (A1)"}, delayMin=3)
        b = inc(line((1000, -10), (1400, -10)), "jam", "b", **{"from": "musterstadt A1", "to": "Beispieldorf, A1"}, delayMin=7)
        out = self.merged([a, b])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["delayMin"], 7)  # larger delay wins

    def test_incident_and_flow_duplicate_prefers_the_one_with_delay(self):
        a = inc(line((1000, -10), (1400, -10)), "jam", "rep")
        f = inc(line((1050, -10), (1450, -10)), "jam", "flow", source="tomtom-flow", delayMin=4)
        out = self.merged([a, f])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["id"], "rep")

    def test_same_type_close_by_but_different_places_stay_separate(self):
        a = inc(line((1000, -10), (1400, -10)), "jam", "a", **{"from": "Alpha", "to": "Beta"})
        b = inc(line((1100, -10), (1500, -10)), "jam", "b", **{"from": "Gamma", "to": "Delta"})
        self.assertEqual(len(self.merged([a, b])), 2)

    def test_same_text_but_more_than_300m_apart_stays_separate(self):
        a = inc(line((500, -10), (900, -10)), "jam", "a", **{"from": "Alpha", "to": "Beta"})
        b = inc(line((1400, -10), (1800, -10)), "jam", "b", **{"from": "Alpha", "to": "Beta"})
        self.assertEqual(len(self.merged([a, b])), 2)

    def test_closure_on_a_ramp_to_another_motorway_is_dropped(self):
        jam = inc(line((1000, -10), (2500, -10)), "jam", "jam", _strassen=["A1"], _autobahn=True)
        ramp = inc(line((2600, -20), (2700, -20)), "closure", "ramp", _strassen=["A8"], _autobahn=True,
                   **{"from": "Kreuz Muster (A8)", "to": "Kreuz Muster (A1)"})
        self.assertEqual(ids(MOTORWAY, [jam, ramp]), ["jam"])

    def test_ramp_with_the_main_road_number_among_others_is_kept(self):
        jam = inc(line((1000, -10), (2500, -10)), "jam", "jam", _strassen=["A1"], _autobahn=True)
        ok = inc(line((2600, -20), (2700, -20)), "closure", "ok", _strassen=["A1", "A8"], _autobahn=True)
        self.assertEqual(ids(MOTORWAY, [jam, ok]), ["jam", "ok"])

    def test_long_jam_on_a_different_number_is_kept_the_route_changed_road(self):
        short = inc(line((500, -10), (700, -10)), "jam", "short", _strassen=["A1"], _autobahn=True)
        longer = inc(line((1500, -10), (3500, -10)), "jam", "long", _strassen=["A8"], _autobahn=True)
        self.assertEqual(ids(MOTORWAY, [short, longer]), ["short", "long"])

    def test_long_same_road_jam_is_still_kept(self):
        jam = inc(line((500, -10), (4500, -10)), "jam", "jam", _strassen=["A1"], _autobahn=True)
        near = inc(line((2000, -10), (2400, -10)), "roadwork", "work", _strassen=["A1"], _autobahn=True)
        self.assertEqual(ids(MOTORWAY, [jam, near]), ["jam", "work"])

    def test_without_neighbours_carrying_a_number_nothing_is_dropped(self):
        lone = inc(line((2600, -20), (2700, -20)), "closure", "lone", _strassen=["A8"], _autobahn=True)
        self.assertEqual(ids(MOTORWAY, [lone]), ["lone"])

    def test_road_numbers_are_read_from_roadnumbers_and_from_to_text(self):
        tt = gt.tomtom_lesen({"incidents": [
            {"geometry": {"type": "LineString", "coordinates": [[13.0, 47.8], [13.01, 47.8]]},
             "properties": {"id": "a", "iconCategory": 8, "roadNumbers": ["A 8", "E52"], "from": "Muster (A1)"}},
            {"geometry": {"type": "LineString", "coordinates": [[13.0, 47.8], [13.01, 47.8]]},
             "properties": {"id": "b", "iconCategory": 8, "from": "Muster (A1)", "to": "Beispiel"}}]})
        self.assertEqual(tt[0]["_strassen"], ["A8", "E52"])  # roadNumbers win over the text
        self.assertEqual(tt[1]["_strassen"], ["A1"])         # text only when there are no roadNumbers


class LiveShapeRegression(Base):
    """Shape of a live case: a route straight through a town, several short closures on side streets that
    cross or run next to it near its start, all within an old 150-200 m buffer, none on the route.
    Coordinates and names are made up."""

    def test_short_side_street_closures_near_the_start_are_all_dropped(self):
        route_pts = line(*[(x, 0) for x in range(0, 2001, 40)])

        def feature(ident, pts, cat=8):
            return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[lon, lat] for lat, lon in line(*pts)]},
                    "properties": {"id": ident, "iconCategory": cat, "events": [{"description": "Gesperrt"}], "from": "Musterweg", "to": "Beispielgasse"}}

        feed = {"incidents": [
            feature("side-a", [(120, -60), (120, 60)]),            # crosses the route
            feature("side-b", [(210, 0), (210, 90)]),              # T-junction: starts on the route
            feature("side-c", [(330, -45), (330, 45)]),            # crosses
            feature("side-d", [(400, 50), (470, 50)]),             # short, parallel, 50 m off
            feature("side-e", [(520, -70), (590, 0), (660, 70)]),  # diagonal crossing
            feature("side-f", [(700, 8), (740, 80)]),              # starts 8 m off, leaves steeply
            feature("on-route", [(1200, 3), (1500, 3)], cat=6),    # control: a jam really on the route
        ]}
        gt.holen = lambda url, kopf=None, timeout=10: (200, json.dumps(feed).encode()) if "incidentDetails" in url else (404, b"")
        gt.ASFINAG_URL = ""
        for buffer_m in (60, 150, 200):
            gt.ROUTEN_CACHE.d.clear()
            r = gt.verkehr_fuer_route(route_pts, buffer_m)
            self.assertEqual([m["id"] for m in r["incidents"]], ["tt:on-route"], buffer_m)
            self.assertAlmostEqual(r["incidents"][0]["alongM"], 1200, delta=25)


class Http(Base):
    def setUp(self):
        super().setUp()
        gt.TOKEN = "t0ken-for-tests"
        gt.NUTZER = {"owner@example.com"}
        self.server = gt.ThreadingHTTPServer(("127.0.0.1", 0), gt.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def post(self, body, headers):
        req = urllib.request.Request(self.base + "/traffic/route", data=json.dumps(body).encode(), headers=dict({"Content-Type": "text/plain"}, **headers))
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read()), r.headers
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read() or b"{}"), e.headers

    def test_auth_cors_and_route_answer(self):
        code, _, _ = self.post({"shape": SHAPE}, {})
        self.assertEqual(code, 401)
        code, body, headers = self.post({"shape": encode6(SHAPE), "buffer_m": 60}, {"Authorization": "Bearer t0ken-for-tests", "Origin": "https://app.example"})
        self.assertEqual(code, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://app.example")
        self.assertEqual(body["incidents"][0]["type"], "jam")
        # Tailscale login from loopback counts for listed users only.
        self.assertEqual(self.post({"shape": SHAPE}, {"Tailscale-User-Login": "owner@example.com"})[0], 200)
        self.assertEqual(self.post({"shape": SHAPE}, {"Tailscale-User-Login": "other@example.com"})[0], 401)
        self.assertEqual(self.post({"shape": [[1, 2]]}, {"Authorization": "Bearer t0ken-for-tests"})[0], 400)

    def test_health_needs_no_login_and_shows_no_secrets(self):
        with urllib.request.urlopen(self.base + "/health", timeout=5) as r:
            text = r.read().decode()
        self.assertIn('"tomtom":true', text)
        self.assertNotIn("test-key-not-real", text)
        self.assertNotIn("pass", text.replace("bypass", ""))


if __name__ == "__main__":
    unittest.main()
