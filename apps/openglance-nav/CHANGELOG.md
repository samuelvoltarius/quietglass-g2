# Changelog

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
