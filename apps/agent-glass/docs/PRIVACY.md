# Agent Glass — privacy

## Kurzfassung (Deutsch)

Agent Glass spricht nur mit dem Agent-Server, den du selbst einträgst (Even
Terminal, Hermes oder OpenClaw — meist auf deinem eigenen Rechner). Es gibt
keinen Quietglass-Server, kein Konto, kein Tracking. Adresse, Token und
Spracheinstellungen liegen im App-Speicher auf deinem Handy; der Agent-Text
wird nur im Arbeitsspeicher gehalten. Die App nutzt kein Mikrofon, keine
Kamera und keinen Standort. Deinstallieren löscht alles.

## Short version

Agent Glass talks only to the agent server you enter. There is no vendor
service, no account and no telemetry.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `network` (`http`, `https`, `ws`, `wss`) | Reach the Even Terminal, Hermes or OpenClaw address you configure | No other host is contacted |

The whitelist is broad only because the address is yours to choose — a
loopback address, a LAN machine or a Tailscale address. The app never builds a
request to any host other than that one.

## Where your data goes

Exactly one place: the agent server you entered in the phone app. Prompts you
send, permission answers (allow/deny) and session requests go there; the agent
output and permission requests come back from it.

If that address is `127.0.0.1` or a machine on your own network, nothing
leaves your network. If you point it at a remote host, the agent's output and
your answers travel to that host — prefer `https://` / `wss://` then.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Backend type and server address | Even app per-app storage, on the phone | No |
| Access token | same | Only to that server |
| Last opened session id | same | No |
| Spoken-output settings (on/off, language, voice, speed) | same | No |

Written through `setLocalStorage()` under `quietglass.agentglass.v1`.

The agent's streamed text, tool names and pending decisions are held **in
memory only** and are gone when the app closes.

## Credentials

- The token is never logged, never shown in full on the phone and never
  rendered on the glasses.
- A `?token=` pasted as part of an address is moved into the token field.
- One unavoidable exception: the browser's `EventSource` cannot send an
  `Authorization` header, so the Even Terminal live stream carries the token in
  its query string. A proxy in front of Even Terminal may log it.

## Spoken output

Off by default. When you turn it on, finished sentences are read by the
phone's own speech engine (`speechSynthesis`). Agent Glass sends no text to any
speech service itself; whether a chosen system voice works on-device or online
is decided by your phone's settings. Code, URLs, commands and token-like values
are never read aloud.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login or device identifier.
- No advertising or third-party SDKs.
- No sensors: no microphone, no camera, no location.

## Removing your data

Clear the address and token in the phone app to forget the server.
Uninstalling removes everything.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle.
