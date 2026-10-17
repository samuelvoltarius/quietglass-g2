# Quiet Hub — Privacy Policy

Last updated: 17 October 2026

## Short version

Quiet Hub has no vendor cloud, account, advertising, analytics, or tracking.
The app connects to the self-hosted Quiet Hub daemon whose address you enter.
You control that daemon and every service connected to it.

## Permissions

| Permission | Purpose |
|---|---|
| `network` | Connect to your Quiet Hub daemon. The broad `http://*` / `https://*` whitelist is necessary because every user chooses their own host. |
| `g2-microphone` | Record a voice question only while you hold the touchpad on an Agent page. The audio is sent to your daemon and then to the speech-to-text endpoint you configured. |
| `camera` | Open the phone camera only after you tap **Scan QR**, to read a Quiet Hub setup code. The image is used for decoding and is not stored or uploaded by the app. |
| `location` | Optionally obtain the phone position for Day Start weather. The position is rounded to roughly 1 km and sent to your daemon; the app does not store it. |

Declining microphone, camera, or location access leaves the other parts of the
app usable. Server entry is also available without the camera.

## Data flow

The phone app sends requests only to the Quiet Hub daemon configured by the
user. Depending on the daemon configuration, that daemon may contact services
you selected, including agent relays (Hermes, OpenClaw, Codex, or Claude Code),
Home Assistant, Klipper/Moonraker, calendar feeds, Open-Meteo, Nightscout, a car
bridge, status endpoints, and self-hosted STT/TTS or language-model endpoints.

No data is sent to Quietglass or its developer. If your daemon or one of its
configured services is remote, data travels to that host. Use HTTPS and access
controls such as Tailscale for connections outside a trusted local network.

## Stored data

The Even app's per-app storage keeps the daemon address, access token, language,
display/gesture preferences, saved voice questions, and optional speech
settings. Live agent output, microphone audio, Home Assistant state, printer
state, and weather data are held in memory by the app and disappear when it
closes.

The daemon stores its own configuration and may retain up to 50 completion
notifications. Retention by connected services is governed by their own
configuration and policies.

## Removing data

Clear the server and token in the phone settings, then uninstall Quiet Hub to
remove app-side data. Delete the daemon state/configuration files to remove its
saved notifications and credentials. Remove data retained by connected
services in those services.

## Third-party code

The app uses the official `@evenrealities/even_hub_sdk`. It contains no
advertising, analytics, or crash-reporting SDK.

---

## Kurzfassung (Deutsch)

Quiet Hub hat keine Hersteller-Cloud, kein Konto, keine Werbung, keine Analyse
und kein Tracking. Die App verbindet sich ausschließlich mit dem von dir
eingetragenen, selbst betriebenen Quiet-Hub-Daemon. Mikrofon, Kamera und
Standort werden nur für die oben beschriebenen, ausdrücklich ausgelösten
Funktionen verwendet. Daten gehen nicht an Quietglass oder den Entwickler.

Die Even-App speichert lokal Daemon-Adresse, Token, Sprache, Einstellungen und
gespeicherte Sprachfragen. Live-Inhalte und Audio hält die App nur im
Arbeitsspeicher. Zum Löschen entfernst du Adresse und Token, deinstallierst die
App und löschst bei Bedarf die Konfigurations- und Zustandsdateien des Daemons.
