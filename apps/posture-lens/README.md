# PostureLens

**Aigner Labs** · Neck angle over time, from the IMU.

> **Status: planned.** Not implemented yet. This file describes what it will
> be, so the intent is public before the code is. No release exists.

## The idea

The IMU sits on your head all day and almost nothing uses it. PostureLens watches how far forward your head is held and how long it stays there, and warns before the ache arrives — not after.

## Planned

- Head pitch sampled from `imuControl`, on-device only
- Warns on sustained forward tilt, not on a single glance down
- Daily summary: time in a good range vs. time slumped
- Nothing recorded, nothing uploaded

## Why it is worth building

A survey of ~150 community G2 projects found nothing covering this. See the
[workspace README](../../README.md) for how the set was chosen.

## License

MIT.
