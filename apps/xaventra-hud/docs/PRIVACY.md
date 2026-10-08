# Xaventra HUD — privacy

## Kurzfassung (Deutsch)

Xaventra HUD spricht nur mit dem Xaventra-Server, den du selbst einträgst und
betreibst. Fragen, Status und Antworten liegen dort, nicht bei uns. Das Mikrofon
läuft nur, solange du hältst, höchstens 15 Sekunden, mit der Anzeige **● MIC**;
die Aufnahme geht nur an deinen Server und wird von der App nicht gespeichert.
Adresse und Token bleiben auf deinem Handy. Kein Konto, kein Tracking.

## Short version

The app talks only to the Xaventra server you enter. Audio is recorded only
while you hold, goes only to that server, and is not stored by the app.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `network` (`http://*`, `https://*`) | Read the status feed and open questions from **your** Xaventra server, send your yes/no answers and your recordings to it | No other host is contacted. The wildcard exists only because the address is yours to choose. Without an address nothing is sent. |
| `g2-microphone` | Optional voice control | Only while you hold the temple pad, at most 15 s, always shown as **● MIC**. Never on launch, never in the background. |

## The microphone

- Opens only on your gesture: hold. Release (or tap) ends it.
- Closes automatically after 15 seconds, and when you leave the app.
- While open, the glasses show **● MIC**; this cannot be switched off.
- The recording is held in memory, sent once to your server's `/hud/voice`, and
  dropped. A cancelled recording (double tap) is never sent.
- Your Xaventra server transcribes it with its own speech recognition and may
  hand the text to its agent; what it keeps is governed by your Xaventra
  installation, not by this app.

## What is stored on the phone

| Data | Key | Leaves the device |
|---|---|---|
| Server address, swipe direction | `quietglass.xaventrahud.v1` | No |
| Token | same | Only to your server, as an `Authorization` header — never in a URL, never logged, never shown in full |
| Language choice | `quietglass.locale` (browser storage) | No |

## What is stored on your server

Whatever Xaventra records about the questions you answer and the messages you
speak — that is Xaventra's own memory and ledger, on your machine.

## Transport

The app runs over HTTPS inside the Even app, so the server must be reachable
over HTTPS as well (for example with `tailscale serve`). The Xaventra endpoint
binds to `127.0.0.1` only and requires the bearer token for every request.

## What is not collected

- No analytics, telemetry or crash reporting.
- No account, login or device identifier.
- No advertising or third-party SDKs.
- No location, no camera.

## Removing your data

Clear the address and token on the phone and uninstall the app to remove
everything stored on the phone. What Xaventra stores is removed in Xaventra.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle.
