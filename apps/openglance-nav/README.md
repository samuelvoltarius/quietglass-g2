# OpenGlance Navigation

**Quietglass** · Turn-by-turn navigation on OpenStreetMap data. No Mapbox, no API key.

Every navigation app found for the Even G2 routes through Mapbox or another
proprietary service — an account, a key, a quota. OpenGlance targets
**Valhalla** on OpenStreetMap data, which you can host yourself.

---

![On the glasses](docs/screenshot.png)

*Captured from the Even Hub simulator at the real 576 × 288.*

## Driving mode is the whole design

A navigation display in a car competes with the road. So in driving mode the
glasses show exactly three things:

```
↱  250 m

Example Road
```

The arrow. The distance. The road name. **No arrival time, no progress bar, no
decoration** — there is a test asserting the footer is empty in driving mode,
so it cannot creep back in.

Walking and cycling add the remaining distance and arrival time, because
glancing at them on foot is safe.

## Rerouting is automatic

A driver should not have to ask. Three consecutive fixes more than 40 m from
the route trigger a new one.

The count matters: a single noisy GPS fix must not throw away a valid route, so
one stray reading is ignored and the counter resets the moment you are back on
course. Both behaviours are pinned by tests.

## What it uses

| | |
|---|---|
| **Position** | `getAppLocation` / `onAppLocationChanged` from the phone, with a 5 m distance filter so a stationary phone does not drain itself |
| **Routing** | Valhalla `/route`, costing `auto` · `bicycle` · `pedestrian` |
| **Geometry** | Encoded polyline at **precision 6** |

> The precision-6 detail is worth stating: Valhalla encodes at 6, while Google
> and OSRM use 5. Getting it wrong misplaces the entire route by a factor of
> ten with no error raised anywhere. There is a test asserting the ratio.

## Progress is measured along the route

Advancing to the next manoeuvre is based on how far along the route you are,
not on how close you are to the turn. On a road that doubles back on itself,
proximity alone announces the wrong turn.

Positions are projected onto the route line, and both the distance to the next
manoeuvre and the distance remaining are measured along that line.

## Setting up a router

Any Valhalla instance works. Self-hosted, using a community image:

```bash
docker run -p 8002:8002 -v "$(pwd)/custom_files:/custom_files" \
  ghcr.io/gis-ops/docker-valhalla/valhalla:latest
```

Then enter `http://your-host:8002` in the phone app. No key, no account.

Leave the URL empty and a **mock router** runs: a fixed demonstration route that
exercises the whole pipeline, labelled `MOCK` on the glasses so it can never be
mistaken for real navigation.

## Destinations

Coordinates or saved places — not a search box. Geocoding would mean relying on
a third service, and the point of OpenGlance is that every piece can be yours.
Copy coordinates from any map, or save your current position with one button.

## Controls

| Gesture | Effect |
|---|---|
| **Tap** | Start navigating · retry after an error · reroute when off route |
| **Hold** | Stop navigating |
| **Double tap** | Leave OpenGlance |

## Install

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5199
npm run build      # typecheck + production bundle
npm test           # 68 unit tests
npm run sim        # Even Hub simulator pointed at the dev server
```

## Privacy

Your position is used to route and **is never stored**. No position history is
written anywhere — where a person has been is among the most sensitive data a
device holds, and this app has no reason to keep it.

Coordinates are sent only to the routing server **you** configure. With the
mock router, nothing leaves the device at all.

See [docs/PRIVACY.md](docs/PRIVACY.md).

## Known limitations

| Limitation | Detail |
|---|---|
| **No map** | Text and an arrow only. The G2 renders 576 × 288 monochrome; a legible map is not possible, and a glanceable instruction is more useful anyway. |
| No geocoding | Destinations are coordinates or saved places, by design. |
| Valhalla only | OSRM and GraphHopper fit the provider interface but are not implemented in 0.1.0. |
| No lane guidance | Valhalla supplies some; it is not displayed yet. |
| No speed or speed limits | Not shown. |
| **Not verified on hardware** | Built and tested against SDK 0.0.16. The simulator supplies no GPS, so the position pipeline is covered by unit tests with synthetic fixes rather than by a real drive. |

**Do not rely on this as your only navigation.** It has not been road-tested.

## Roadmap

- OSRM and GraphHopper providers.
- Lane guidance where the router supplies it.
- Waypoints.
- Offline route caching for a planned trip.

## License

MIT — see [LICENSE](LICENSE).
