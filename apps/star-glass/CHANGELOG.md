# Changelog

## [0.1.1] — 2026-10-13

### Fixed

- The page on the glasses survives a restart of the app.
- A command without an answer says "Ergebnis unklar – Status wird geprüft" and checks N.I.N.A. at once.
- Leaving through the system stops polling and the animation; coming back rebuilds the page.

### Changed

- Footer counts the real number of pages and names the swipe: `1/4 · Wischen = Seite · Tippen = steuern · 2× = Ende`.

## [0.1.0] — 2026-10-13

### Added

- First version: N.I.N.A. imaging status on the Even G2 through the Star Glass bridge (`examples/star-bridge.mjs`, Node, no dependencies) and the Advanced API plugin.
- Four pages by swiping: overview (exposure ring with countdown, target, filter, frame n/m), guiding & focus (RMS and HFR as large numbers with history), equipment (camera cooling, mount tracking/alt/az, meridian flip and pier side, focuser, filter, guider), last frame (288 × 144 grayscale preview).
- Alerts in the header: sequence finished, guiding lost, cooling off or drifting, meridian flip soon/now, camera or mount disconnected, N.I.N.A. errors.
- Animated telescope sign in the top-right corner (exposing / idle / problem / offline).
- Optional stop / resume of the sequence, only with `STAR_ALLOW_CONTROL=1` and a login on the bridge, and only after a second tap.
- Bridge: Tailscale login allow-list (`STAR_TAILSCALE_USERS`) or token, CORS preflight 204 without body, no site coordinates or file paths in the status, optional websocket for faster updates.
- Private builds: `VITE_STAR_URL` sets the bridge address; an empty field uses it.
- Demo mode `?demo=1` with scenes `flip`, `lost`, `warm`, `done`; `&page=n` opens a page.
