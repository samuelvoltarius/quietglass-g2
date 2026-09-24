# OpenGlance Navigation

**Aigner Labs** · Turn-by-turn on OpenStreetMap data.

> **Status: planned.** Not implemented yet. This file describes what it will
> be, so the intent is public before the code is. No release exists.

## The idea

Every G2 navigation app found so far routes through Mapbox or a proprietary service. OpenGlance uses OpenStreetMap data through Valhalla, which you can host yourself.

## Planned

- Valhalla first, with a provider abstraction for OSRM and GraphHopper
- Walking, cycling and driving modes; driving is deliberately sparse
- Position, speed and heading from `getAppLocation`
- Point it at your own routing server

## Why it is worth building

A survey of ~150 community G2 projects found nothing covering this. See the
[workspace README](../../README.md) for how the set was chosen.

## License

MIT.
