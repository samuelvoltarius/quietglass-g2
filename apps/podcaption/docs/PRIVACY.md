# PodCaption — privacy

## Kurzfassung (Deutsch)

PodCaption öffnet Untertiteldateien oder eingefügten Text direkt auf deinem
Handy — dafür wird kein Netz gebraucht. Nur wenn du die optionale Feed-Bridge
nutzt, fragt die App deine eigene Bridge auf `127.0.0.1:8789` ab; die Bridge
lädt den von dir eingestellten Podcast-Feed und dessen Transkripte. Gespeichert
werden nur Bridge-Adresse und Sprache, die Untertitel nur im Arbeitsspeicher.
Kein Konto, kein Tracking, kein Mikrofon. Deinstallieren löscht alles.

## Short version

Opening a file needs no network. The optional feed path talks only to a bridge
you run yourself.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `network` (`http://127.0.0.1:8789`, `http://localhost:8789`) | Optional: read a podcast feed and its transcript through your own bridge | The whitelist allows no other host |

PodCaption does **not** use the microphone. It does not listen to the podcast;
captions come from a transcript file and follow its timestamps.

## Where your data goes

- **File or pasted text (default):** nowhere. The file is read on the phone
  through the system file picker.
- **Feed (optional):** the app asks your bridge (`examples/podcast-bridge.mjs`)
  for the feed and for one transcript. The bridge, running on your computer,
  downloads the feed URL you configured (`PODCAST_FEED_URL`) and only the
  transcript URLs listed in that feed. Those downloads reach the podcast's own
  host, whose privacy policy applies.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Bridge address | WebView storage of the Even app, on the phone | No |
| Display language | same | No |

Keys: `podcaption.bridge`, `quietglass.locale`. The opened transcript and the
playback position are held **in memory only** and are gone when the app closes.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login or device identifier.
- No advertising or third-party SDKs.
- No microphone, no camera, no location.

## Removing your data

Uninstalling removes everything. There is no listening history to delete.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle.
