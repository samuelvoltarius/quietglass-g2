# OpenGlance — privacy

## Short version

Your position routes you and is never stored. No location history exists.

## Permissions (as declared in `app.json`)

| Permission | Why | What it touches |
|---|---|---|
| `location` | Route from where you are; measure how far the next turn is | Position from the phone, held in memory only — see *Location* |
| `network` | Talk to the three map services below, or to your own servers instead | `valhalla1.openstreetmap.de` (routes, FOSSGIS e.V.), `photon.komoot.io` (place search, komoot), `overpass-api.de` with `overpass.private.coffee` as fallback (streets of the overview map, OpenStreetMap data). The `http://*` / `https://*` entries exist only so that servers *you* enter under Advanced can be reached. |

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

Nothing else is sent, and nothing is sent anywhere else. With the demo route
switched on, **nothing leaves the device at all**.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Routing and search server addresses | Even app per-app storage, on the phone | No |
| Saved places | same | Only the selected one, to the router |
| Mode, glasses view and settings (incl. the street-map switch) | same | No |
| Language choice (only if changed) | WebView local storage | No |

Written through `setLocalStorage()` under `quietglass.openglance.v1`.

Saved places are yours to add and remove. Removing one deletes its coordinates.

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
