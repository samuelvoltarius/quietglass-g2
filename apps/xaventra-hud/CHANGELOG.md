# Changelog

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
