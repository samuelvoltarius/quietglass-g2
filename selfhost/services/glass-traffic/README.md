# glass-traffic — traffic jams, closures and roadworks along the route (tailnet only)

A small service for OpenGlance. The app sends the **route line** (not the position). The service asks the traffic
sources and answers with the reports **on the route**, with the distance along the route and a sum of the
delay. The keys stay on the server.

```
 Glasses/iPhone ──► tailscale serve :8474 ──► glass_traffic.py (127.0.0.1:8475) ──► TomTom (bbox + a few route points)
   (route line)                                                                  └─► ASFINAG DATEX II (whole feed, every 2 min)
```

| Local | Tailscale port (suggestion) | Build variable (`config.json`) |
|---|---|---|
| `glass_traffic.py` `127.0.0.1:8475` | `8474` | `VITE_TRAFFIC_URL` (`services.traffic`) |

Suggested host: **ns1**, next to `glass-routes` (same pattern: systemd user service + `tailscale serve`).

## Interface

```
POST /traffic/route   Body (text/plain, no preflight):
                      {"shape": "<polyline, 6 decimal places>" | [[lat,lon],...], "buffer_m": 60, "precision": 6}
GET  /health          Counters, which sources are set up; without sign-in, without secrets
```

Answer:

```json
{"incidents": [{"id": "tt:…", "type": "jam", "delayMin": 9, "lengthKm": 1.5, "from": "…", "to": "…", "text": "Stau",
                "point": [47.8, 13.05], "geometry": [[47.8, 13.05], …], "source": "asfinag+tomtom",
                "alongM": 3750, "offM": 2}],
 "delayMin": 9, "routeM": 15000, "sources": {"tomtom": "ok", "asfinag": "off"}, "at": 1760000000000, "cached": false}
```

- `type`: `jam | closure | roadwork | accident | other`. `alongM` = meters from the start of the sent line to the
  start of the report (in driving direction), `offM` = distance to the line.
- **On the route** means: the report really runs *along* the route and in the driving direction (see
  [Matching](#matching-report--route)). Cross streets, parallel streets and the opposite carriageway are dropped.
- **Merging**: the same kind at almost the same place (≤ 600 m) from TomTom and ASFINAG becomes one report
  (`source: "asfinag+tomtom"`, the larger delay counts). A flow jam within 2 km of a reported
  jam/closure/accident report is not counted twice.
- **Cache**: the same (thinned) line for 2 min; TomTom per box/point for 2 min; the ASFINAG feed at most every
  2 min (an error is also remembered for 2 min, so there is no storm on the source).
- `sources.*`: `off` (not set up), `ok`, `error` (source not reachable; the app then simply shows less).

### Matching: report → route

Before, a single report point within `buffer_m` was enough. Because of that, closures on **side streets** that only
cross the route or lie next to it got through in the city. Now the geometry of the report is checked
(values are constants at the top of `glass_traffic.py`):

| Case | Rule |
|---|---|
| **Line** (TomTom LineString, flow segment) | Split into samples every ~10 m. A sample counts if it lies in the **corridor** *and* its direction fits the route (cos(angle) ≥ 0.7; for reports for **both directions**, also against it). The counting samples together must be ≥ **max(60 % of the report length, 80 m)** long. |
| **Short line** (< 80 m) | Must lie ≥ 80 % close (≤ 25 m) to the route and in the driving direction. |
| **Crossing** | If the report moves sideways by more than 30 m within the corridor (diagonally across the route), it is dropped, even if one point lies directly on the route. |
| **Start/end only** (ASFINAG linear, TPEG from/to, 2 points > 200 m apart) | Both ends in the corridor, the end *after* the start in the driving direction, distance along the route ≥ max(60 % of the straight-line distance, 80 m) and ≤ 3 × the straight-line distance + 500 m. |
| **Point** (no line) | At most **25 m** next to the route. |
| **Already inside** | If a report extends beyond the start (or the end) of the sent line, only the part on the line counts, at least 80 m; `alongM` is then 0. For start/end reports, the missing end must lie on the extension of the first/last route segment. |

**Corridor** per route segment: **25 m** in the city / on country roads, **60 m** on motorways (the
carriageways of the two directions are up to ~45 m apart). It is never more than the client's `buffer_m` (upper
limit). The decision is made in this order:

1. Road category of the report: TomTom `roadNumbers` (A…/S… = motorway/expressway, other numbers = neither),
   TomTom flow `frc` (FRC0/FRC1 = motorway), ASFINAG (only runs motorways/expressways) = always motorway.
2. Without a category, the shape of the route: a segment is motorway-like if there is no sharp bend within ±1 km
   around it (> 35° change of direction within 60 m, such as turning at junctions or a roundabout). The app does
   not send road classes or speeds.

Limit of the estimate: a dead-straight city street over more than 2 km without turning counts as motorway-like. A
parallel street in the same direction at a distance of 25–60 m that runs along for ≥ 80 m would get through there.
Cross streets and short pieces would not.

`alongM` = meters along the route to the **start of the overlap**, `offM` = smallest distance there. The
shape of the answer is unchanged. Internal hints (`_autobahn`, `_beide`) never go out.

### Duplicates and ramps at the junction

After matching (and before delivery), two filters run:

- **Ramps / crossing motorway** (`_ohne_rampen`): the app only sends geometry, so the road of the route is unknown.
  It is derived from the neighbors. Reports carry road numbers internally (`_strassen`: TomTom `roadNumbers`, and
  only if there are none, the numbers from the from/to text such as "(A8)"). For each number, the overlap of all
  *other* reports with a number within **1.5 km** along the route counts (distance between the overlaps). The
  number with the longest overlap is the main road. If a report does not carry this number **and** lies less than
  **200 m** on the route, it is dropped (a ramp or another motorway at the junction). It stays in if the overlap is
  ≥ 200 m (the route changes motorway), if it has no number, or if there is no neighboring report with a number.
  Limit: a single ramp closure with no neighbors at all cannot be recognized from geometry alone.
- **Duplicates** (`zusammenfuehren`): the same kind within **300 m** along the route and a similar from/to text
  (lowercase, no punctuation, word-set Jaccard ≥ 0.6) count as one report, also from the same source (two
  TomTom entries, incidents + flow). The one with `delayMin` is kept, delay = maximum. Two sources
  (for example ASFINAG + TomTom) still merge within 600 m without a text comparison.

**Sign-in** works as with the other services: `Tailscale-User-Login` only from loopback and only for logins in
`TRAFFIC_TAILSCALE_USERS`, alternatively `Authorization: Bearer <TRAFFIC_TOKEN>`. With neither, everything except
`/health` is blocked. CORS: the answer carries the origin of the request; OPTIONS → 204.

**Log**: only method, path, code, sign-in kind and duration. No coordinates, no keys (URLs with `key=` are
never printed, errors only as the type name).

## Sources

### (a) TomTom (optional, `TOMTOM_KEY`)

- **Traffic Incidents API v5** (`/traffic/services/5/incidentDetails`): per box around the route (at most
  `TOMTOM_MAX_BOXES`, each < 10,000 km², as TomTom requires), categories accident, jam, lane closed, road closed,
  roadworks, broken-down vehicle, current reports only. The delay (`delay`, s) and length are taken over.
- **Flow Segment Data v4**: at `TOMTOM_FLOW_SAMPLES` points spread evenly along the route (default 6, 0 = off).
  If it is clearly slower than free flow (≤ 60 % of the free speed, ≥ 1 min longer, confidence ≥ 0.5), it becomes a
  jam; `roadClosure` becomes a closure.
- Cost: TomTom counts requests (free tier, as of the docs: 2,500 per day; **please check with TomTom**).
  At most `TOMTOM_MAX_BOXES + TOMTOM_FLOW_SAMPLES` calls per route request, usually fewer thanks to the cache. The app
  asks every 2 min while driving, once per way before the start, and once per way for a detour check.
- TomTom gets boxes around the route and single points **on** the route, never the glasses' position as such.

### (b) ASFINAG DATEX II (optional, `ASFINAG_DATEX_URL`)

Research (2026-10-14): ASFINAG delivers traffic data for all Austrian motorways and expressways as
**DATEX II** feeds (events/traffic messages, roadworks, network management, travel times ...). They are **not freely
downloadable**: access is given after **registration and a contract in the ASFINAG Content Portal**
<https://contentportal.asfinag.at/> (formerly `services2.asfinag.at/web/trafficdata/`). The profiles are described in
the DATEX II directory (repo.datex2.eu, node "ASFINAG – Austria", for example "D2 ASFINAG profile Traffic
Messages / Network Management (uses Ext. LinearByCoordinates)"). On data.gv.at and at the national access point
mobilitydata.gv.at, no freely usable ASFINAG message feed could be found. Whether access is free of charge for
private persons could not be clarified publicly. The portal tells you during registration.

**What you have to do:**

1. Register in the Content Portal, request the feed with **traffic messages / unplanned events**
   (SituationPublication, preferably with coordinates or LinearByCoordinates) and conclude the contract.
2. Enter the **retrieval URL** (pull) named there as `ASFINAG_DATEX_URL`, and the user and password (HTTP Basic) as
   `ASFINAG_USER` / `ASFINAG_PASSWORD`. If the portal offers a different sign-in (for example a certificate), please
   report it. So far the service can only do Basic or open.
3. Restart and check `GET /health` (`"asfinag": true`), then send a route over a motorway and look for
   `ok` in `sources.asfinag`.

DATEX II **v2 and v3** are read (`situationRecord`, namespaces do not matter): the kind from `xsi:type`
(`AbnormalTraffic` → jam, `Accident` → accident, `MaintenanceWorks`/`ConstructionWorks`/`Roadworks` → roadworks,
`RoadOrCarriagewayOrLaneManagement` with `roadClosed`/`carriagewayClosures` → closure), the delay from
`delayTimeValue`, the length from `queueLength`/`lengthAffected`, the text from `generalPublicComment` (German
preferred), the coordinates from `from`/`to` (TPEG, correctly ordered), `linearCoordinatesStartPoint`/`EndPoint`,
otherwise `pointCoordinates`, otherwise `locationForDisplay`. `suspended` and expired (`overallEndTime`) records are
dropped. Compressed (gzip) answers are unpacked. The test data in `fixtures/` is **made up** and only in the format
of such a feed. The parser has **not** yet been checked against the real feed.

## Set-up (ns1)

```bash
mkdir -p ~/glass-traffic
cp glass_traffic.py ~/glass-traffic/
install -m 600 glass-traffic.env.example ~/glass-traffic/.env    # fill in: logins, optionally TOMTOM_KEY, ASFINAG_*
cp glass-traffic.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now glass-traffic
tailscale serve --bg --https=8474 http://127.0.0.1:8475           # never "serve reset"
curl -s https://<your-machine>.<your-tailnet>.ts.net:8474/health
```

Then set `services.traffic` in `selfhost/config.json` (`https://<your-machine>.<your-tailnet>.ts.net:8474`) and rebuild OpenGlance with
`node selfhost/build-private.mjs`. This puts `VITE_TRAFFIC_URL` and the origin into the whitelist of
`app.private.json`. Without a TomTom key and without ASFINAG, the service answers with empty lists
(`sources: off`), and the app then simply shows no traffic.

## Tests

```bash
python3 -m unittest test_glass_traffic      # or: python3 -m pytest test_glass_traffic.py
```

Standard library only, no network except 127.0.0.1. The TomTom and ASFINAG answers come from `fixtures/`
(made up, no real keys or data). What is checked: reading both sources, the opposite carriageway, distance along the
route, matching (cross street, a parallel street 40 m away in the city, a report along the route, the opposite
direction on the motorway, a closure in both directions, a point 20 m/60 m away, a carriageway 45 m next to it, a
diagonal crossing, start/end lines, "already in the jam", a rebuild of the shape of a live case with short cross
closures at the start of the route), merging, flow, boxes under the TomTom area limit, the cache (also: ASFINAG only
once per 2 min), sources off, source errors, sign-in/CORS/HTTP, and `/health` without secrets.
