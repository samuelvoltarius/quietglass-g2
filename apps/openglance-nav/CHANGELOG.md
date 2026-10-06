# Changelog

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
