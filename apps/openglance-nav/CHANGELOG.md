# Changelog

## [0.6.0] — 2026-10-13

Destinations are chosen on the glasses, and can be spoken (user feedback from the
real glasses, beta 0.5.5: "only shows the route to Tamsweg, does not let me pick
another one or start it, no voice input").

### Added

- **Destination list as the start page**: saved places, then the last five
  destinations ("zuletzt"), at most five visible around the cursor; the active
  destination is marked `●`, the cursor `→`. Swipe chooses, tap starts navigation
  and makes it the active destination. The footer names the gestures.
- **Travel mode on the glasses**: the last row of the list ("Unterwegs: Auto"),
  tap switches car → bike → on foot.
- **Speaking a destination**: hold on the list records from the glasses
  microphone until release (hard stop after 8 s), the recording goes as WAV to the
  own Whisper server (`VITE_STT_URL`, form post without extra headers, so no CORS
  preflight), the words are looked up with Photon; up to three places, swipe
  chooses, tap navigates, hold saves as a favourite. Without a speech server, too
  short, nothing understood, server or place search unreachable: each says so on
  the glasses with what to do. The microphone is always switched off again
  (release, double tap back, exit, timeout).
- Spoken destinations that were not saved are kept as recent ones (`recent` in the
  stored data, at most five, same place within ~30 m replaced).
- Development only (vite dev server): `?at=lat,lon` position, `?to=lat,lon,Name`
  destination, `?heard=Text` instead of the transcription, for the simulator.

### Changed

- **A start always shows what it is doing**: "Suche Standort…" while waiting for
  the GPS (only when no fix younger than 2 min is known; before, every start
  waited up to 12 s for a new fix with nothing changing on the glasses),
  "Route wird berechnet…" while routing. Hold cancels.
- **Errors in plain words with the way out**, two lines: "Kein GPS-Standort. /
  Standort für Even am Handy erlauben.", "Routing-Server nicht erreichbar. /
  Tailscale / Internet am Handy an?", "Routing-Server antwortet nicht.", "Keine
  Verbindung. / Das Handy ist offline."; footer "Tippen = nochmal · Halten =
  Zielliste".
- Hold while navigating stops and goes back to the destination list; on arrival
  the footer says so.
- Private build: the speech server origin is whitelisted and the `g2-microphone`
  permission declared.

### Findings (start problem)

- The own Valhalla answered every route the glasses asked for on 13.10. (log on
  the server: four requests from the phone's GPS position to Tamsweg - car, on
  foot, bike, car - all HTTP 200 in 0.05–0.5 s), and in the simulator with the real
  servers tapping started navigation. The start itself worked; what was missing
  was a way to choose another destination on the glasses (a tap while navigating
  did nothing, hold only went back to "Ziel: Tamsweg") and any sign of progress
  while the GPS was being asked.


## [0.5.3] — 2026-10-13

Street names on the map (user feedback from the real glasses: "the overview needs
street names").

### Added

- **Street labels on the map**: bold capitals, 14 px tall, own pixel font, in a
  black box with a 1 px border. Shown: the street of the next turn, the street the
  car is on, and up to three more big streets in view. Horizontal whatever way the
  map is turned, never overlapping each other, the car, the turn ring, the
  destination, the compass or the text plate; at most 16 characters
  ("Straße" becomes "Str.", longer names are cut with a dot).
- Overpass query now asks for `tags` of roads (footpaths without); `name`, else the
  first `ref`, is read from the answer.
- The text line top left adds the street: "→ 300 m · Linzer Gasse" (shortened to
  fit, or left out).
- Demo (`?demo=1&scene=map`) draws named example streets.

### Changed

- The very first page per bridge is preceded by one ignored `rebuildPageContainer`
  (measured on real glasses: otherwise taps may not arrive); then `create` exactly
  once, afterwards only rebuilds.
- The mock route uses German street names (Rainerstraße, Linzer Gasse, Hellbrunner Allee).

## [0.5.0] — 2026-10-13

Readable at a glance while driving (user feedback: "map too small ... impossible
while driving").

### Changed

- **Turn view**: a big arrow (144 x 144, 32 px strokes) on the left; the distance
  to the turn in huge pixel digits (70 px tall, twice the old height, rounded:
  "950 m", "150 m", "1,2 km") on the right with a thick eight-block approach bar
  beneath; the road name in bold type across the full width (drawn as an image
  in two 288 x 56 halves, because the glasses text is too small); a footer with
  remaining distance and arrival time, also while driving. Within 200 m of the
  turn the footer goes: only arrow, distance and road remain.
- **Map**: fills the whole display (four 288 x 144 images), heading-up when a
  direction is known (route ahead, GPS heading off route), north-up otherwise;
  thick route, the car as a large chevron low on the picture, ring on the next
  turn, destination square, compass; zoom in steps so the next turn is always
  visible. One short line of text on a plate top left: the next turn,
  "-> 960 m". It is sent only when the route, streets, turn or zoom step change,
  and otherwise at most every 4 s after 12 m of travel or 12 degrees of turn;
  tiles that look the same are not resent.
- Distances on the big card are rounded calmly: 50 m steps from 200 m, 10 m below.
- Three glasses pages: turn view (4 images), map (4 images), plain text (none).
  At most four images per page, exactly one input-capturing container.

### Fixed

- **The map stayed empty** (most visibly in the demo): switching the view called
  `createStartUpPageContainer` a second time, which the glasses refuse as
  "invalid", so the map image was never sent. Pages after the first are now
  replaced with `rebuildPageContainer`.
- The demo route had no corners (a straight line); it now has a right turn, a
  bending road and a roundabout. Demo-only URL parameter `scene=far|near|map`
  starts on a given picture.

## [0.4.2] — 2026-10-13

### Fixed

- Start language: the Even app's WebView reports English even on a German phone.
  An explicit language choice is now kept in the SDK store; without one, a German-speaking
  Even account country (AT/DE/CH/LI/LU) starts the app in German.

## [0.4.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

## [Unreleased]

### Added
- Real streets on the overview map: OpenStreetMap data from the public
  Overpass API, one request per route (after 1.5 s on the overview), main
  roads bright, side streets dim, footpaths faint and only on foot; cut to the
  picture and capped. Falls back to the route alone on any failure. Switch
  under Advanced; attribution on the phone page; PRIVACY.md updated.
- Turn card: the distance to the turn in large pixel digits and an eight-block
  approach bar that fills as the turn comes closer.

### Changed
- Images are sent only when they change: the arrow on a new manoeuvre, the
  card when its digits or bar change (at most every 2 s while counting
  down), the overview marker after 6 px and 5 s. Previously the arrow went
  out with every text update and the overview with every ~11 m.
- The fake diagonal grid behind the overview route is gone.
- Double tap asks the glasses for the exit confirmation
  (`shutDownPageContainer(1)`); cancelling keeps navigating.
- Pixel arrow drawn larger (80 px); U-turn and roundabout patterns fixed to
  the 10 × 10 grid.

## [0.4.0] — 2026-10-06

Works right after install, for anyone. Map Glass is merged in.

### Added
- Routes through the free public OpenStreetMap routing server of FOSSGIS e.V.
  (`valhalla1.openstreetmap.de`) when no server is entered — nothing to host.
  Its terms are kept: at most one request per second, automatic reroutes at
  least 15 s apart, an `X-Client-Id`, attribution with a fix-the-map link.
- Place search by name or address via Photon (`photon.komoot.io`), on an
  explicit Search only, with a cache and a rounded position bias. "Go here"
  saves the result and selects it in one step.
- Overview map on the glasses, ported from Map Glass with its projection
  fixes (uniform scale, centring, antimeridian) and tests. Swipe switches
  between the turn arrow and the overview; the choice is remembered.
- German and English, following the device language, with real umlauts.
- Plain error messages: no GPS, no connection, server busy, no way found,
  too far for the chosen way of travel.
- First-run guidance on phone and glasses; travel choice as words and icons.

### Changed
- An empty router address now means the public server, not the mock. The
  demonstration route is a separate switch under Advanced and is labelled
  `DEMO` (was `MOCK`).
- Walking is the default way of travel.
- Server addresses, demo route, coordinates and swipe direction moved under
  "Advanced". `app.json` now declares the network and location permissions.

## [0.3.0] — 2026-10-05

- Replaced the ambiguous fixed pixel symbol with large manoeuvre-specific
  arrows for left, right, straight, U-turn, roundabout, and arrival.
- Kept the text arrow as a redundant fallback next to the distance.

All notable changes to OpenGlance Navigation are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-25

First release.

### Added
- Turn-by-turn navigation on OpenStreetMap data via Valhalla — no API key, no
  account, no quota, and self-hostable.
- Walking, cycling and driving modes. Driving deliberately shows only the
  arrow, the distance and the road name; a test asserts the footer stays empty
  so decoration cannot creep back in.
- Automatic rerouting after three consecutive fixes more than 40 m off route,
  with a single stray fix ignored so GPS noise cannot discard a valid route.
- Manoeuvre progress measured along the route rather than by proximity, so a
  road that doubles back does not announce the wrong turn.
- Polyline decoding at explicit precision, with a test pinning the
  factor-of-ten difference between Valhalla's precision 6 and the more common 5.
- Position projection onto the route, used for both off-route detection and
  remaining distance.
- Arrival detection that stays arrived even if a later fix drifts.
- Provider interface with a Valhalla implementation and a mock router for
  development without a server, labelled MOCK on the glasses.
- Valhalla manoeuvre types mapped to a normalised set, with unknown types
  defaulting to "straight" rather than inventing a turn.
- Saved places and coordinate entry; no geocoding, deliberately, so no third
  service is required.
- Location updates use a 5 m distance filter to spare battery while stationary,
  and stop when navigation stops.
- 68 unit tests covering geodesy, polyline decoding, projection, Valhalla
  parsing, manoeuvre advancement, reroute hysteresis, arrival and the display.

### Known limitations
- No map: text and an arrow only, which is what 576 x 288 monochrome allows.
- No geocoding, lane guidance, waypoints or speed display.
- Valhalla only; OSRM and GraphHopper fit the interface but are not implemented.
- **Not verified on physical hardware.** The simulator supplies no GPS, so the
  position pipeline is covered by unit tests with synthetic fixes rather than by
  a real journey. Do not rely on it as your only navigation.
