# OpenGlance — privacy

## Short version

Your position routes you and is never stored. No location history exists.

## Permissions (as declared in `app.json`)

| Permission | Why | What it touches |
|---|---|---|
| `location` | Route from where you are; measure how far the next turn is | Position from the phone, held in memory only — see *Location* |
| `network` | Talk to the three map services below, or to your own servers instead | `valhalla1.openstreetmap.de` (routes, FOSSGIS e.V.), `photon.komoot.io` (place search, komoot), `overpass-api.de` with `overpass.private.coffee` as fallback (streets of the overview map, charging stations, peaks nearby, fixed speed-enforcement points; OpenStreetMap data); Photon also tells the country near the German border (speed hints). The `http://*` / `https://*` entries exist only so that servers *you* enter under Advanced can be reached. |

No other permission is requested: no microphone, no camera, no album, no
notifications.

## Location

OpenGlance reads your position through the SDK's `getAppLocation` and
`onAppLocationChanged`, supplied by the phone.

It is used for exactly two things: routing from where you are, and working out
how far the next turn is. It is held in memory for the current fix and replaced
by the next one.

**No position history is written to storage.** Not a track, not a breadcrumb
trail, not a "last known location". Where a person has been is among the most
revealing data a device can hold, and there is no file here recording it.

Location updates stop when you stop navigating and when you leave the app.

## What leaves the device

When a route is calculated, your current coordinates and your destination are
sent to the **routing server** — the free public server of FOSSGIS e.V.
(`valhalla1.openstreetmap.de`) unless you enter your own. That is what routing
requires. The request carries `X-Client-Id: quietglass-openglance`, which
identifies the app, not you.

When you press **Search**, the words you typed and an area rounded to about
one kilometre are sent to the **place-search server** — Photon by komoot
(`photon.komoot.io`) unless you enter your own. Nothing is sent while you type.

When you look at the **overview map** for a couple of seconds, the area
around the route — a rectangle rounded to about 10 m, a bit larger than the
picture — is sent once per route to the **street server**: the public
Overpass API (`overpass-api.de`, run by FOSSGIS e.V.), or
`overpass.private.coffee` if that one does not answer. That rectangle
reveals roughly where the route is, not where you are within it, and it is
not sent again for each GPS fix. Switch **Show real streets on the overview
map** off under Advanced and nothing goes there; the overview then shows the
route alone. Your browser engine sends its usual `Referer` and user agent
with the request, as with any web request; OpenGlance adds nothing.

With **charging stations** switched on (off by default), the same Overpass
servers get: for *Charging nearby* on the glasses, your position rounded to
about 10 m and a 15 km radius; for *Charging stations along the route* on the
phone and while driving, boxes covering the route, rounded to about 10 m.
Switched off, nothing is asked.

**Peaks nearby** (glasses list entry off by default; the phone tab asks only
on *Load peaks*) send the centre of the 5 km cell you are in - not your exact
position - and the radius (10, 25 or 50 km, plus 4 km), once per cell, to the
same Overpass servers. The answer (peak
names, heights, positions; no position of yours) is kept on the phone in the
Even app's storage for up to 30 days, at most four areas.

In a **private build with your own servers** (`VITE_STREETS_URL`,
`VITE_CHARGERS_URL`), the route's line goes to your own routing server for
the street names, and the charging-station questions above (position rounded
to about 10 m, or the route boxes) go to your own server instead of Overpass.
The streets around the route are still asked from Overpass as described.

**Speed hints at fixed enforcement points** (on by default, car only): once
per route, boxes covering the route (rounded to about 10 m, about 200 m wide
around it) go to the same Overpass servers; not at all for a route wholly inside
Germany. Only when such a point is actually ahead and you are within about 20 km
of the German border, the centre of the ~1 km cell you are in (two decimals)
goes to the place-search server (`/reverse`) to tell the country; the answer is
kept in memory for the session. Switch the setting off and nothing is asked.

**Traffic** (private build with `VITE_TRAFFIC_URL` only): every 2 minutes while
driving, after a new route, for each way in the route choice and for each way
of a detour check, the **route line** ahead (thinned to about one point per
25 m) goes to **your own** traffic service. Traffic data comes only through that
service. Your own service then asks TomTom (if you set a key there) with boxes
around that line and a few points on it, and reads the ASFINAG feed (one
download for all of Austria every 2 minutes, no route sent); **your position is
never sent to TomTom directly** - the app does not talk to TomTom at all, and the
key stays on your server. The service keeps answers for 2 minutes in memory and
logs neither coordinates nor keys.

Nothing else is sent, and nothing is sent anywhere else. With the demo route
switched on, **nothing leaves the device at all**.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Routing and search server addresses | Even app per-app storage, on the phone | No |
| Saved places | same | Only the selected one, to the router |
| Saved routes (name, start place, stops, destination, way of travel, distance, time; for a route from a typed start also its thinned line) | same | Their places, to the router, when started |
| Whether a navigation is running and since when (to pick it up again after the phone ended the app) | same | No |
| Mode, glasses view and settings (incl. the street-map and speed-hint switches) | same | No |
| Peaks of up to four visited 5 km areas (name, height, position of each peak; cell id; when fetched) | Even app per-app storage, under `quietglass.openglance.peaks.v1` | No |
| Language choice (only if changed) | WebView local storage | No |

Written through `setLocalStorage()` under `quietglass.openglance.v1`.

Saved places are yours to add and remove. Removing one deletes its coordinates.

## Glucose in the driving HUD (private build only)

If, and only if, the build was made with `VITE_SUGAR_URL` (your own
Nightscout-compatible server) and the switch is on, OpenGlance reads the newest
glucose value from **that server** once a minute while you navigate by car
(`GET /api/v1/entries/sgv.json?count=3`, optionally with the token of your
build in the query). Glucose values are fetched from your own server only: no
third party sees them, nothing is sent to it except that request, and the value
is held in memory only (not stored, not logged). Without the address nothing is
read or shown. Information only, not medical advice.

## Today's appointments (private build only)

If, and only if, the build was made with `VITE_BRIEF_URL` and `VITE_BRIEF_TOKEN`
(your own Quiet Hub daemon) and the switch is on, OpenGlance asks **that
daemon** for today's appointments (`GET /brief/appointments`, with the build's
token) at start and every 5 minutes while the destination list is shown.
**Appointment data comes only from your own daemon**: titles, times and the
places' coordinates are held in memory only, never stored and never logged.
Nothing is sent to the daemon except that request. When you drive to an
appointment, only its place goes into the recent destinations (like any other
destination), not its title. To show when to leave, the place of each listed
appointment (at most three, at most once per 5 minutes each, only while the list
is open) goes to the routing server together with your position, as for any
route. Without the address or the token nothing is asked or shown.

## Choosing a routing server

A routing server necessarily learns where you are and where you are going.
The public default is run by FOSSGIS e.V. (see their privacy policy at
fossgis.de). If you would rather nobody else saw it, run your own — the README
shows how, and it needs no account or key.

If you use a public instance, that operator sees those coordinates. OpenGlance
cannot change that; it can only make sure the choice is yours and visible.

## What is not collected

- No analytics, telemetry or crash reporting.
- No account, login or device identifier.
- No advertising or third-party SDKs.
- No microphone, no camera.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Map data © OpenStreetMap contributors (ODbL), via the routing, search and
street servers. Street data is held in memory for the current route only and
never stored.
