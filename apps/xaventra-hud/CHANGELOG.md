# Changelog

## [0.3.0] — 2026-10-13

### Changed — answering "no"

- **A double tap no longer answers "Nein".** It is the exit again, on every screen with cards too (Even rule: the double tap on the root leaves the app), and a stray double tap can no longer refuse a request. While speaking it still cancels the recording, and it closes a voice reply.
- "Nein" now takes two deliberate gestures: **swipe to "Nein", then tap**. Swiping walks Ja → Nein of each card and then on to the next card; the card shows `● Ja   ○ Nein   (Halten = sprechen)`, the footer says what a tap sends ("Tippen = Nein · Wischen = weiter · 2× = Ende"). A "Nein" choice belongs to its card and is dropped when that card goes away, so it can never land on another card. "Ja" on a card that acts outside still needs the second tap within 4 s.

### Fixed

- Gestures are wired before the first page and the feed poll, so a slow page creation can no longer swallow the double tap.
- A reconnect during a running draw could be undone by that draw; the rebuild request now survives it.
- Leaving through the system (another app, the system menu) cancels a recording, stops the long poll and drawing; coming back rebuilds the page and polls again. A system exit or crash stops everything.

## [0.2.1] — 2026-10-13

### Fixed

- Page set-up on the glasses: the first page of a session goes out as one `rebuildPageContainer` followed by exactly one `createStartUpPageContainer`; every later page is a rebuild, never a second create. (Taps and exit work on real glasses only with this order.)

## [0.2.0] — 2026-10-13

### Added

- A face in the top-right corner of the header (64 x 30 image) that shows Xaventra's mood: it blinks when all is quiet, writes in a notebook while Xaventra works on a status, opens its eyes wide while a card waits for your yes or no, listens while you speak, shows a cross when the server answers with a problem and sleeps when it cannot be reached. The header text now ends 64 px before the right edge.
- The face and the clock redraw twice a second; pictures are sent to the glasses only when they change, text containers only when their text changed.
- `?demo=1&scene=idle|working|error|offline` shows the other moods in the simulator.

## [0.1.4] — 2026-10-13

### Changed

- German gesture hints no longer mix in English ("Tap Ja · 2x Tap Nein" is now "Tippen = Ja · 2× = Nein · Halten = sprechen"); English hints follow the same pattern.
- Glasses rows use the full display width (56 instead of 46 characters); card title and text that do not fit end in an ellipsis instead of being cut silently.

## [0.1.3] — 2026-10-13

### Fixed

- Start language: an explicit choice is kept in the Even SDK store (the WebView's localStorage may not survive a relaunch); without one, a German-speaking Even account country (AT/DE/CH/LI/LU) starts the app in German, even when the WebView reports English.

## [0.1.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

All notable changes to Xaventra HUD are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-10-08

First Quietglass release. The HUD started as a minimal app inside the Xaventra
repository (`apps/even-g2`); it now lives here and is built to Quietglass
conventions.

### Added
- Status feed and question cards from the Xaventra Even G2 endpoint (long poll).
- Tap = yes, double tap = no, swipe = next card; cards that act outside need a
  second tap within 4 seconds.
- Voice control: hold to speak (at most 15 s, shown as ● MIC), release sends the
  recording to `POST /hud/voice` on your own Xaventra server. Yes/no answers the
  open card, anything else goes to the agent and the reply is shown on the
  glasses. A spoken yes never confirms an action that acts outside.
- Double tap with no open question asks the system to quit; cancelling keeps
  the app running.
- German and English, following the phone language, with a picker on the phone
  page. Glasses text stays within seven rows of 46 characters.
- Phone page: endpoint address and token (write-only, never shown), https and
  mixed-content hints, controls, connection status.
- `?demo=1` sample mode.
- Tests for the feed, answers, the confirming tap, voice (mocked endpoint and
  bridge), exit, errors, timeouts and translations.

### Changed
- Requires Xaventra with `POST /hud/voice` for voice; everything else works with
  the original endpoint.
- SDK 0.0.16, Vite 8, Vitest 5, display layout and gestures shared with the
  other Quietglass apps.
