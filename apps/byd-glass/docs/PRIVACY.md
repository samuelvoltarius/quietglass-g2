# BYD Glass — Privacy

**Short version:** BYD Glass talks only to the byd-bridge address you enter (or that your private build carries).
No account, no analytics, no tracking, no other server.

## What the app sends

* `GET /state` (long-poll) to your bridge — no data from you, only a revision number.
* Only on the control page, and only if your bridge has control switched on: `POST /command` with the chosen command
  (lock, unlock or preheat with its duration) and, for the second tap, the one-time value the bridge handed out.

Nothing else. The app never talks to the car or to BYD itself; your bridge decides and passes the command on.

Authentication is done by `tailscale serve` in front of the bridge (your Tailscale login); the app stores no token.

## What the app stores

In the Even app's per-app storage on your phone: the bridge address, the swipe direction and your language.

## What the bridge sees

The bridge (`selfhost/services/byd-bridge`) runs on your own server. It keeps the car's latest telemetry in memory,
and does **not** pass the car's location or VIN to the glasses. Its command endpoint is switched off by default.
When switched on, every command and every refusal is logged as one line (time, command, result, reason) in a file on
that server, and every unlock is reported to you via your own Telegram bot.

## Deutsch, kurz

BYD Glass spricht nur mit deiner eigenen byd-bridge. Kein Konto, kein Tracking. Gespeichert wird am Handy nur die
Bridge-Adresse, die Wischrichtung und die Sprache. Standort und VIN gibt die Bridge nicht an die Brille weiter.
Befehle (Zusperren, Aufsperren, Vorheizen) gehen nur an deine Bridge und nur, wenn sie dort freigeschaltet sind.
