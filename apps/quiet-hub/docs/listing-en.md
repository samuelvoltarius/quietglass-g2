# Quiet Hub — store listing copy (EN)

## Tagline (recommended)

Agent alerts, home & printer on one screen.

Alternatives:
- Your assistant, your home, your printer — one glance.
- Three glances in one. No cloud, no keys, no setup.

## Short description

One glance app for your AI assistant, your Home Assistant devices and your
Klipper printer — self-hosted, no cloud, no API keys on the device.

## Full description

Quiet Hub merges five glances into one. Completion alerts from Hermes, Claude,
Codex and OpenClaw, your Home Assistant devices and your Klipper printer share a
single screen — because switching apps on smart glasses costs far more than it
does on a phone.

ASK — pick a saved question with a swipe, tap to send it to your own
assistant, or hold the temple to speak and release to send. The voice note is
transcribed by your own Whisper, and the answer lands back on the display.

ALERTS — a persistent pixel check, exclamation mark or cross tells you when an
agent finished, needs input or failed. If the display was asleep, the unread
event is still there when Quiet Hub returns.

HOME — lights, heating, blinds and plugs as one glanceable list with live
state. Anything that changes the world outside needs a confirming second tap
within four seconds; a stray single tap can never switch a light.

PRINTER — job name, progress bar, layer, temperatures and time left, with
pause, resume and cancel behind the same two-tap safety.

Everything runs through one small self-hosted daemon on your own machine. The
glasses never see an API key and never talk to three different protocols;
nothing leaves your network. German and English included.

The overview follows the Even lifecycle contract: double-tap opens the native
system exit dialog. Internal actions stay on their own pages and every external
change keeps its confirmation step.

Built in the open: MIT licensed, 30 tests, rendered in the official Even Hub
simulator at the native 576 × 288 resolution. Physical G2 validation pending —
stated honestly, like everything in this repo.

## Files

- Icon: docs/icon-1024.png (also icon-512.png)
- Screenshots (simulator, native 576 × 288):
  - docs/s0_overview.png — selectable root overview
  - docs/s1_agent_v2.png — agent page with pixel icon
  - docs/s4_alerts.png — persistent completion alert
  - docs/phone-settings.png — QR and manual phone setup
