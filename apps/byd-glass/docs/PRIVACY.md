# BYD Glass — Privacy

**Short version:** BYD Glass talks only to the byd-bridge address you enter (or that your private build carries).
No account, no analytics, no tracking, no other server.

## What the app sends

* `GET /state` (long-poll) to your bridge — no data from you, only a revision number.
* `POST /command` to your bridge — only after you confirmed a command on the glasses (climate on with a
  temperature, climate off, lock, unlock).

Authentication is done by `tailscale serve` in front of the bridge (your Tailscale login); the app stores no token.

## What the app stores

In the Even app's per-app storage on your phone: the bridge address, the swipe direction and your language.

## What the bridge sees

The bridge (`selfhost/services/byd-bridge`) runs on your own server. It keeps the car's latest telemetry in memory,
does **not** pass the car's location or VIN to the glasses, and writes one log line per command
(time, action, value, result, Tailscale login) to a file on that server.

## Deutsch, kurz

BYD Glass spricht nur mit deiner eigenen byd-bridge. Kein Konto, kein Tracking. Gespeichert wird am Handy nur die
Bridge-Adresse, die Wischrichtung und die Sprache. Standort und VIN gibt die Bridge nicht an die Brille weiter;
jeder Befehl wird auf deinem Server protokolliert.
