# Changelog

## [0.1.0] — 2026-10-13

### Added

- First version: glucose from your own Nightscout on the Even G2.
- Glucose page: the value in large pixel digits with trend arrow (Nightscout `direction`), change per 5 min, minutes since the reading, and the last 3 hours as a dot curve with the target band (70–180 by default) and the urgent-low line.
- Alerts, worst first, pulsing in the header and as a label on the value: very low (< 54), low (< 70), high (> 250), no current value (> 15 min), falling fast (double arrow or ≤ −15 mg/dL in 5 min).
- Pump page: SmartGuard mode (when reported), insulin on board, reservoir, pump and phone battery, sensor time left and state, last meal and bolus.
- Phone page: mg/dL ↔ mmol/L, target range, alert limits, server address, optional token; notice "for information only".
- `examples/sugar-bridge.mjs`: read-only proxy in front of Nightscout with a Tailscale login allow-list; it adds a "readable" token server-side so the app needs none.
- Private builds: `VITE_NS_URL` sets the address (never a token).
- Demo mode `?demo=1` with `&scene=normal|low|urgent|high|stale|falling`, `&page=2` for the pump.
