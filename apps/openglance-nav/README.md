# OpenGlance Navigation

**Quietglass** · Turn-by-turn navigation on OpenStreetMap data. No Mapbox, no API key,
nothing to host.

## Works right after install

1. Open OpenGlance on the phone and **search for your destination** by name
   ("Mirabellplatz Salzburg"), then tap **Go here**.
2. Choose **On foot**, **Bike** or **Car**.
3. **Tap** the side of your glasses. That's it.

On the glasses OpenGlance opens on a **list of destinations** (saved places and
the last five you went to): swipe to choose, tap to go. In a private build with
a speech server, **hold** on the list and say where you want to go.

No account, no key, no server of your own. Routes come from the free public
OpenStreetMap routing server run by FOSSGIS e.V., place search from the free
public Photon server by komoot. The phone page and the glasses follow the
device language — **German and English** — and say what is wrong in plain
words: *"Kein GPS-Standort – Standort für Even am Handy erlauben"*, *"Routing-Server nicht erreichbar"*, *"Kein Weg zum Ziel
gefunden"*.

Running your own servers is still one field away — see
[Advanced: your own servers](#advanced-your-own-servers).

The turn view is three things you can read in a glance:

```
┌────────┐ ┌──────────────────────────┐
│   ██   │ │ 250 m          (large)   │
│  ████  │ │ ■■■■■□□□  ← fills as the  │
│   ██   │ └──────────────────────────┘    turn comes closer
│   ██   │  Example Road
└────────┘
```

A large high-contrast **pixel arrow** that changes with every manoeuvre
(left, right, straight, U-turn, roundabout, arrival); the **distance to the
turn in large pixel digits** — the glasses' text has one fixed size, so this
is a small image; and below it an **approach bar** of eight blocks that fill
over the last 150 m on foot, 300 m by bike, 600 m by car (or over the whole
stretch if it is shorter, so a quick double turn starts empty). The road name
stays as text beside the arrow.

What crosses Bluetooth is kept small: the arrow image is sent only when the
manoeuvre changes, the distance card only when its digits or a bar block
change (and while it only counts down, at most every 2 s); the text changes
in place.

For a non-persistent demo route in the simulator, open the development URL
with `?demo=1`, or switch on **Advanced → Demo route** on the phone.

---

![On the glasses](docs/screenshot.png)

*Captured from the Even Hub simulator at the real 576 × 288: the turn view (demo route, 950 m before the turn) and the map.*

![The map, heading-up](docs/screenshot-map.png)

## Driving mode is the whole design

A navigation display in a car competes with the road, so the turn view is built
to be read in one glance, from the corner of the eye:

- a **big arrow** (144 x 144, 32 px strokes) on the left,
- the **distance to the turn in huge pixel digits** (70 px tall, rounded:
  "950 m", "150 m", "1,2 km") on the right, and under it a **thick approach
  bar** of eight blocks that fills as the turn comes closer,
- the **road name in bold type across the full width** (drawn as an image,
  because the glasses text has one small fixed size),
- a small footer with the remaining distance and the arrival time.

**Within 200 m of the turn the footer goes**, and only arrow, distance and road
remain. The approach bar belongs to the distance - it is the same number, made
readable from the corner of the eye - not a progress bar for the trip.

Images are sent only when they change: the arrow and the road name with the
manoeuvre, the distance card when its rounded number or one of the eight bar
steps changes (and then at most every 2 s). The text updates are cheap and
always in place.

## Two views: next turn, or the map

Choose **View: map** (or **View: turns**) in the glasses' side menu. A swipe never switches the view. The
map fills the **whole display** (four 288 x 144 images, 576 x 288 together),
**heading-up**: it turns so that the direction of travel is up, with the car
as a large chevron low on the picture, so the road ahead gets the room. The
route is a thick white line with a black edge over the **real streets around
it**, with a ring on the next turn, a square at the destination and a small
compass whose needle follows north. One short line of text sits top left,
over a black plate: the next turn, "-> 960 m". The direction comes from the
route ahead (about 80 m), from the GPS heading when you are off the route, and
the map is north-up when neither is known. The zoom moves in steps (150 m ...
80 km ahead) so the next turn is always on the picture. The choice of view is
remembered and can also be picked on the phone.

Switching between the views rebuilds the page on the glasses (the two use
different image containers), which takes a moment - fine for a menu entry you chose,
and it never happens for an ordinary update. The map is sent when the route,
the streets, the next turn or the zoom step change, and otherwise at most every
4 s after you moved 12 m or the map has to turn 12 degrees; a tile that looks
exactly like the one already shown is not sent again.


### What the map shows

The G2 converts images to 16 grey levels, so streets are drawn dimmer than
the route and by importance: **main roads** (motorway … secondary) brighter
and thicker, **side streets** (tertiary, residential, living streets,
pedestrian zones) dim, and **footpaths** faint and thin — footpaths only on
foot. Service roads, tracks, sidewalks and crossings are never drawn. How
much is shown follows the zoom: footpaths only when the picture covers at
most 2.5 km, side streets up to 4 km, main roads up to 25 km, nothing beyond
(a cross-country route is just the route). Lines are cut to the picture,
thinned to whole pixels and capped at 1 500 segments, main roads kept first.

### Where the streets come from, and what happens when they don't

**Private build with `VITE_STREETS_URL`** (your own Valhalla, usually the same
server as `VITE_ROUTER_URL`; `selfhost/build-private.mjs` sets it): the street
names along the route come from that server - `trace_attributes` with the
route's own shape as one GET `?json=` (no preflight), 0.1-0.3 s even for a
300 km route. Those names label the map reliably; the streets *around* the
route still come from Overpass as below when it answers, and simply join in.

Streets are OpenStreetMap data from the public **Overpass API**: one request
per route, made only after the overview has been on screen for 1.5 s (so a
swipe past it costs nothing), with only way geometry asked for and cut to
the area server-side. A reroute inside the area already loaded asks nothing.
The answer is held in memory, never stored.

If the street server is slow (12 s timeout), busy, offline, or answers with
something oversized (> 3 MB) or broken, the next server is tried once, then
OpenGlance pauses street requests for a minute and shows **the route alone**.
Navigation never waits for streets. **Advanced → Show real streets on the
overview map** switches them off; the demo route never fetches them.

The overview comes from Map Glass, which has been merged into OpenGlance. Its
projection keeps one scale for both axes (turns keep their real angles),
centres straight routes instead of pinning them to an edge, and keeps routes
across the antimeridian in one piece — those fixes and their tests came along.
Map Glass drew faint diagonal lines behind the route as texture; they looked
like streets and were not, so they are gone — real streets replaced them.

## Rerouting is automatic

A driver should not have to ask. Three consecutive fixes more than 40 m from
the route trigger a new one — at most once every 15 seconds, so someone
standing beside the route does not hammer a free public server. A tap reroutes
at once.

The count matters: a single noisy GPS fix must not throw away a valid route, so
one stray reading is ignored and the counter resets the moment you are back on
course. Both behaviours are pinned by tests.

## What it uses

| | |
|---|---|
| **Position** | `getAppLocation` / `onAppLocationChanged` from the phone, with a 5 m distance filter so a stationary phone does not drain itself |
| **Routing** | Valhalla `/route`, costing `auto` · `bicycle` · `pedestrian`; default `https://valhalla1.openstreetmap.de` (FOSSGIS e.V.) |
| **Place search** | Photon `/api/`; default `https://photon.komoot.io` (komoot) |
| **Geometry** | Encoded polyline at **precision 6** |

> The precision-6 detail is worth stating: Valhalla encodes at 6, while Google
> and OSRM use 5. Getting it wrong misplaces the entire route by a factor of
> ten with no error raised anywhere. There is a test asserting the ratio.

## Public servers, and keeping to their rules

Checked on 2026-10-06 by reading the terms and by calling the servers with an
`Origin` header:

| Server | Terms | WebView (CORS) | What OpenGlance does |
|---|---|---|---|
| `valhalla1.openstreetmap.de` (FOSSGIS e.V.) | [Nutzungsbedingungen](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/): max. **1 request per second**; OSM attribution with a *fix the map* link; identifiable client; no high-traffic sites, commercial use only if not a substantial part of the offering; URL should not be hard-coded; no availability guarantee | `Access-Control-Allow-Origin: *`; preflight allows `Content-Type` and `X-Client-Id` | ≥ 1.1 s between requests (quick taps are queued, not dropped); automatic reroutes ≥ 15 s apart; never polls; sends `X-Client-Id: quietglass-openglance` because a WebView cannot set its User-Agent; attribution and fix-the-map link on the phone page; address editable under Advanced |
| `overpass-api.de` (FOSSGIS e.V., Overpass API) | [Overpass API wiki](https://wiki.openstreetmap.org/wiki/Overpass_API): fewer than 10 000 queries and 1 GB per day per user (divide by 100 for regular use); identify the app via User-Agent or Referer; after a 429 or 406 wait at least 30 s; no commercial use of the public instance | `Access-Control-Allow-Origin: *`. Returns **406** to a request with no `Referer`, or a bare default user agent (tested with curl); with a browser user agent plus `Referer` it answers 200. A WebView sends a `Referer` itself — whether the Even app's WebView does is **not verified on hardware**. Under load it answers **504** | one query per route, lazily, only after 1.5 s on the overview; reused for reroutes inside the loaded area; form POST (no preflight); 12 s timeout; on failure one try at `overpass.private.coffee` (no rate limit stated; it did not answer at all when tested), then a 60 s pause; switch under Advanced |
| `photon.komoot.io` (komoot) | [photon.komoot.io](https://photon.komoot.io/): free, "please be fair", heavy use is throttled | `Access-Control-Allow-Origin: *` | searches only on **Search** or Enter, never while typing; a repeated query is answered from memory; ≥ 1 s between searches; position bias rounded to about 1 km |

**Not used:** Nominatim. Its [usage policy](https://operations.osmfoundation.org/policies/nominatim/)
forbids client-side autocomplete, requires an identifying User-Agent (which a
WebView cannot set) and asks apps to proxy requests. The OSRM demo server
(`router.project-osrm.org`) also answers with CORS, but is for non-commercial
use at 1 request per second and does not give Valhalla's instructions and
street names, so it was not needed as a fallback.

The public Valhalla server caps walking routes at 100 km; OpenGlance then says
*"Too far for this way of travel"*.

### Attribution

The phone page shows, as both services' terms require:

> Map data © OpenStreetMap contributors (ODbL) · report a map error ·
> Routes: FOSSGIS e.V. · Valhalla · Search: Photon by komoot ·
> Overview streets: OpenStreetMap via Overpass API ·
> Charging stations: OpenStreetMap via Overpass API (ODbL) (when switched on) ·
> Peaks: © OpenStreetMap contributors (ODbL), via the Overpass API (peaks tab)

With your own servers entered, the provider line names them instead.

## Progress is measured along the route

Advancing to the next manoeuvre is based on how far along the route you are,
not on how close you are to the turn. On a road that doubles back on itself,
proximity alone announces the wrong turn.

Positions are projected onto the route line, and both the distance to the next
manoeuvre and the distance remaining are measured along that line.

## Destinations

Search by address or place name; **Go here** saves the result and makes it the
destination in one step. Saved places stay on the phone for next time. **Save
my current position** remembers where you are (the car, the hotel).
Coordinates can still be typed under *Enter coordinates instead*.

## Planned routes

On the phone, **Plan a route**: a start (a searched place, or *my position
when I start*), up to three stops and a destination, car / bike / on foot.
**Calculate route** asks the router once for the whole way (Valhalla
`locations` with every stop, a "break" at each) and shows distance, time and a
line drawing of the route made from the route's own points - no map tiles, no
further server. **Save route** keeps it under a name; saved routes can be
edited, renamed and deleted.

On the glasses the saved routes follow the places in the destination list,
marked `↑` with their number of stops. A tap starts from where you are:

- near the planned start (500 m) the route is driven as planned, through every stop;
- far from the start but within 2 km of the planned line, the route is joined
  where you are and stops already behind are left out;
- otherwise straight to the first stop (or the destination).

The arrival at a stop is its own turn on the glasses ("Stopp 1: Ladepark") and
is announced as a stop, not as the destination. A reroute keeps the stops not
yet passed.

## Charging stations (optional, off by default)

**Private build with `VITE_CHARGERS_URL`**: the stations come from your own
server instead of Overpass (see `selfhost/services/chargers`): official
registers (E-Control Austria with the ad-hoc price per kWh, Bundesnetzagentur
Germany), refreshed daily, asked with a plain GET (`/chargers?lat&lon&radius`
or `?boxes=…`, no preflight), at most one request every 5 s, answered in the
same element format. The price shows as "0,59 €/kWh" on the glasses list and
the phone. Without the variable everything below applies unchanged.

For electric cars: switch **Show charging stations** on under *Charging
stations* on the phone. The stations come from OpenStreetMap
(`amenity=charging_station`) through the public Overpass API - the same
servers as the overview streets, the same form POST without a CORS preflight.
Bicycle-only and private stations are left out; power is read from
`socket:*:output`, sockets from `socket:type2_combo` (CCS), `socket:chademo`
and `socket:type2`, places from `capacity`.

- **Along a planned route** (phone): stations within 2 km, with distance from
  the start, power, sockets and how far off the route; **Add as stop** puts one
  between the stops where it lies on the way and recalculates.
- **Charging nearby** (glasses list entry): the three nearest fast ones within
  15 km - at least 50 kW where the power is mapped, a CCS socket counts as
  fast without it; tap navigates there.
- **While driving**: "Laden in 12 km · 150 kW" under the road on the turn
  view (not within 200 m of a turn), and a marked plate on the overview map.

Asked sparingly: at most one request every 30 s, answers reused (nearby while
within 1.5 km for 10 minutes, along a route per route), an 18 s timeout, the
second server only when the first fails, and every failure said in words. The
route corridor is asked as a union of boxes of ~20 km each: an `around` along
a 130 km line ran into the server's time limit when tested.

## Peaks nearby (optional, off by default)

Switch **Show "Peaks nearby" on the glasses list** on in the phone's **Peaks**
tab. Named summits with an elevation (`natural=peak` with `name` and `ele`)
come from OpenStreetMap through the public Overpass API.

- **Glasses, compass band**: the upper half of the display is a compass band
  (±60°, compass points written on the scale) with the facing direction in the
  middle. Each peak is a triangle at its bearing, with name, elevation and
  distance above it (up to three rows, never overlapping); peaks outside the
  band are only counted, with an arrow at the edge. The seven nearest are
  shown, **swipe** switches to the seven highest. Below the band: which way
  the band faces and why, how many peaks, the highest one.
- **Facing direction**: while moving (from ~1 m/s), the GPS course; standing
  still, the **facing when standing still** set on the phone (N, NE … NW),
  otherwise north up. *Head direction from the glasses' own motion sensor
  (IMU) could come later; SDK 0.0.16 does not offer it to apps yet.*
- **Glasses, list**: **tap** on the band opens the peaks sorted by distance
  ("2.3 km · NE · Gaisberg 1287 m"); swipe chooses, tap navigates there (it
  joins the recent destinations), hold goes back to the band, double tap back
  to the destination list.
- **Phone**: radius 10 / 25 / 50 km, the facing direction, **Load peaks**, and
  the list with distance, bearing and elevation; **Go there** makes a peak the
  destination the same way a spoken destination does.

Asked sparingly: the world is cut into 5 km cells, and one request per cell
asks for the radius plus 4 km around the cell's centre, so the answer covers
every point of the cell. Answers are kept on the phone (Even app storage, up
to four areas, 30 days; a larger radius serves a smaller one). Nothing is
fetched in the background: only when the peaks page opens, on **Load peaks**,
or once when you walk into a new cell while the page is open; at most one
request every 20 s; a 30 s timeout; the next server only when one fails.
Servers in turn: `overpass-api.de`, `overpass.private.coffee` (maps.mail.ru deliberately not used: a location must not go there).
Checked with curl on 2026-10-14 (form POST with an `Origin`): overpass-api.de
and other mirrors answer `Access-Control-Allow-Origin: *`; both also answered
504 under load at times, and overpass-api.de 406 to a client without a
browser Referer (see the table above).

## Advanced: your own servers

Everything a beginner never needs sits under **Advanced** on the phone page:
the routing server, the place-search server, the demo route, reversed swipe
direction and the language.

Any Valhalla instance works. Self-hosted, using a community image:

```bash
docker run -p 8002:8002 -v "$(pwd)/custom_files:/custom_files" \
  ghcr.io/gis-ops/docker-valhalla/valhalla:latest
```

Then enter `http://your-host:8002` as the routing server. No key, no account.
Your server must answer the WebView's CORS preflight
(`Access-Control-Allow-Origin`, `Content-Type` allowed); OpenGlance sends it no
extra headers.

Photon self-hosts the same way (see [komoot/photon](https://github.com/komoot/photon));
enter its base URL as the place-search server. Empty either field to return to
the public default.

The **demo route** is a fixed made-up route that exercises the whole pipeline
without any network; the glasses mark it `DEMO` so it can never be mistaken for
real navigation.

## Glucose in the driving HUD (private build, optional)

Information only, never advice. With `VITE_SUGAR_URL` set at build time (the
address of your **own** Nightscout-compatible server) and the phone switch
*Glucose in the driving HUD* on (Glasses tab; on by default only when the build
has an address), the glasses show a small value with the trend arrow, e.g.
`128↗`, while you drive with a route: in the footer of the turn page (dropped
right at a turn, like the rest of the footer) and after the speed on the map.

- Read only: `GET <url>/api/v1/entries/sgv.json?count=3`, once a minute, only
  while navigating by car. Values come from your server only; no third party.
  An optional `VITE_SUGAR_TOKEN` goes into the query (`?token=`), never a header.
- A value older than 15 minutes is marked `128?` (no arrow, no warning), older
  than an hour it is hidden.
- Warning: below 80 mg/dl and falling (45°, down, double down), or below 70 mg/dl
  in any direction: `! 72↓ low & falling` / `! 65→ low` replaces the footer (on
  the map: the speed plate) until it clears, even right at a turn.
- A failed request changes nothing on the glasses and rebuilds no page; the
  text is updated in place through the normal draw.
- Without the address: nothing shown, no request.
- The server origin must be in the network whitelist of `app.private.json`
  (generated by `selfhost/build-private.mjs`, never committed).

## Today's appointments (private build, optional)

With `VITE_BRIEF_URL` (the base address of your **own** Quiet Hub daemon) and
`VITE_BRIEF_TOKEN` (its bearer token; private builds only) set at build time,
and the phone switch *Appointments from the morning brief* on (Glasses tab; on
by default only in such a build), today's appointments head the glasses list.

- Source: `GET <url>/brief/appointments` on your daemon, which merges your
  calendars and Shoot Day projects and geocodes the places. Asked at start and
  every 5 min while the list is shown (6 s timeout, one request at a time);
  a failure changes nothing. No third party is asked for appointments.
- Shown: timed appointments with a place found, starting later or at most 30 min
  ago, at most three, first in the list and marked `▸`, e.g.
  `▸ 10:30 Customer … · Musterdorf`. Tap drives there (by car).
- Before leaving: with a drive time from the normal router (at most one request
  per appointment per 5 min, only while the list is open), the row says
  `leave in 12 min` / `go now!` (start − drive time − 5 min).
- Driving there: the turn page footer says `Arrive 10:22 · 8 min early` /
  `· 5 min late` (a glucose warning wins); on the map a short chip after the
  speed when it fits. On arrival one extra line `Appt: <title> · Babel: client talk`.
- Without URL or token: nothing shown, no request.
- The daemon origin must be in the network whitelist of `app.private.json`.

## Choosing a route (car)

Starting a car trip without stops asks the router for up to two other ways
(Valhalla `alternates: 2`). When it offers more than one, the glasses show them
before anything starts:

```
OPENGLANCE · Route wählen
→ A 34 min · 41 km · A1 · +12 min Stau
    B 38 min · 33 km · B158 · Akku −2 %
    C 41 min · 39 km · Maut
Tippen = los · Wischen = wählen · 2× = zurück
```

Each row shows time and distance, then what tells the ways apart, as far as it
fits: the traffic delay (private build with the traffic service), the battery
difference to the fastest way (car link only; consumption from the car, a bit
more above 80 km/h average), toll when the router says so, and the road the way
mostly follows. Swipe moves, tap starts, double tap goes back to the list. With
one way only there is no picker. Reroutes, and a navigation picked up after the
phone ended the app, take the fastest way without asking.

## Traffic (private build, optional)

With `VITE_TRAFFIC_URL` (your **own** glass-traffic service,
`selfhost/services/glass-traffic`) set at build time:

- **Before the start** the route picker shows each way's delay (`+12 min Stau`,
  `Sperre` for a closure).
- **While driving** the app asks every 2 minutes, and once after a new route
  (never sooner than 15 s after the last request, one request at a time). The
  hint line says `Stau in 4,2 km · +9 min`, `Sperre in 800 m`,
  `Baustelle in …` (roadworks only when they cost time), up to 30 km ahead.
- **Detour**: with 5 min or more of delay (or a closure) ahead, the router's
  other ways from where you are are checked against their own traffic; if one
  saves 5 min or more the line says `Umfahrung spart 7 min · Tippen` and a
  **tap takes it**. The tap acts on the detour only while that line is what the
  glasses show (otherwise tap keeps its usual meaning: reroute when off route,
  charging nearby when the battery runs low). Trips with stops get no detour
  offer (the router offers other ways only between two places).
- What goes where: the app sends only the route line ahead to your own service.
  The service asks TomTom (key on the server, never in the app) with boxes
  around the route and a few points on it, and reads the ASFINAG DATEX II feed
  for Austrian motorways if you registered for it. Your position is never sent
  to TomTom as such. Details and setup: `selfhost/services/glass-traffic/README.md`.
- Without the address: nothing shown, no request.

## Speed hints at fixed enforcement points (on by default; off in Germany)

While driving with a route, a neutral hint `Tempo beachten · 50`
(`Mind your speed · 50`) appears in the hint line about 300 m before a fixed
speed-enforcement point mapped in OpenStreetMap (`highway=speed_camera`, and the
devices of `enforcement=maxspeed` relations); at speed at least 10 s ahead. The
number is the point's own `maxspeed`, else the current limit. The points are
asked once per route from the public Overpass servers (route corridor boxes,
cached; not at all for a route wholly inside Germany). Priority: below glucose
low & falling and the brake hint, below a jam or closure less than 3 km ahead,
above the arrival battery, appointment and charger hints. Phone switch:
*Speed hints (fixed enforcement points)*, Glasses tab.

**Why it is off in Germany.** § 23 Abs. 1c StVO forbids drivers in Germany to
operate or use a device intended to show or disrupt speed enforcement; the
prohibition is commonly read to cover such a function in a navigation app
while driving. OpenGlance therefore never shows the hint when it finds itself
in Germany: a coarse outline of Germany decides away from the border, and
within 20 km of it a reverse lookup on the place-search server (only the
centre of a ~1 km cell is sent, and only when a point is actually ahead) - until
that has answered, and if it fails, the hint stays off. In Austria and Italy
such hints are, as far as we know, not forbidden; other countries have their
own rules (Switzerland, for instance, also forbids warnings about traffic
controls), and the setting is yours to switch off. This is a description of
how the feature behaves, **not legal advice (keine Rechtsberatung)**. The
outline is approximate; near borders the result can be off by about a kilometre.

## Controls

| Gesture | Effect |
|---|---|
| **Tap** | List: go to the chosen destination (on the last row: switch car / bike / on foot) · route choice: start the chosen way · retry after an error · reroute when off route · take the detour while `Umfahrung spart … · Tippen` is shown |
| **Swipe** | Moves only, never changes anything: List: choose a destination (the last row is the travel mode) · route choice: choose a way · peaks band: nearest / highest. While navigating it does nothing |
| **Hold** | List: say a destination (private build with a speech server). A hold never stops the navigation |
| **Side menu** (glasses) | **Help** · **View: turns / View: map** · **Switch HUD layout** · **Speed hints on/off** (the last two while driving; from the list too) · **End navigation** — the first click **asks**, the footer says `Tap again = stop`; a second click on the entry or one tap within 4 s stops and goes back to the list; a swipe, a hold, a double tap, another entry or 4 s cancel |
| **Hold** on spoken results | Save the chosen place as a favourite |
| **2×** | Back (speaking, charging, peaks, help, route choice - nothing is guiding yet) · navigating: leave OpenGlance — the glasses ask to confirm; cancelling keeps navigating · cancels a pending stop instead of leaving |

## Install

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5199
npm run build      # typecheck + production bundle
npm test           # unit tests
npm run sim        # Even Hub simulator pointed at the dev server
```

## Privacy

Your position is used to route and **is never stored**. No position history is
written anywhere — where a person has been is among the most sensitive data a
device holds, and this app has no reason to keep it.

The overview map sends the area around the route, rounded to about 10 m,
once per route to the street server (Overpass), unless switched off.

Peaks nearby send only the centre of the 5 km cell you are in (not your exact
position) and the radius, once per cell, to the Overpass server; the answer is
kept on the phone.

Speed hints ask Overpass once per route with boxes around the route; near the
German border the centre of a ~1 km cell goes to the place-search server to tell
the country. Traffic (private build) sends only the route line ahead to your own
service; it never sends your position to TomTom.

Your position and destination go only to the routing server (the public
FOSSGIS one unless you enter your own) when a route is calculated. A place
search sends the words you typed and an area rounded to about a kilometre to
the search server. With the demo route, nothing leaves the device at all.

See [docs/PRIVACY.md](docs/PRIVACY.md).

## Known limitations

| Limitation | Detail |
|---|---|
| **Public servers, no guarantee** | FOSSGIS and komoot run them for free on single servers and may change terms or switch them off at any time. If OpenGlance became popular enough to matter to them, a self-hosted or sponsored server would be the right answer. |
| Overview streets are best effort | They depend on a free public server that is often overloaded (504) and may refuse a WebView that sends no `Referer` (406); then the overview shows the route alone. No street names, no buildings — the map cannot carry them. |
| Long walks | The public server caps walking routes at 100 km. |
| No lane guidance | Valhalla supplies some; it is not displayed yet. |
| No speed or speed limits | Not shown. |
| **Not verified on hardware** | Built and tested against SDK 0.0.16. The simulator supplies no GPS, so the position pipeline is covered by unit tests with synthetic fixes rather than by a real drive. |

**Do not rely on this as your only navigation.** It has not been road-tested.

## Roadmap

- Lane guidance where the router supplies it.
- Peaks band turning with the head (glasses IMU), once the SDK offers it.
- Offline route caching for a planned trip.

## License

MIT — see [LICENSE](LICENSE).
