# Status Glass — privacy

## Kurzfassung (Deutsch)

Status Glass fragt nur die Statusquellen ab, die du selbst einträgst. Es gibt
keinen Quietglass-Server, kein Konto und kein Tracking. Gespeichert sind nur
Quellen-Adressen, Tokens und das Abfrageintervall; Messwerte nur im
Arbeitsspeicher. Kein Mikrofon, keine Kamera, kein Standort. Deinstallieren
löscht alles.

## Short version

Status Glass talks only to the servers you configure. There is no vendor
service, no account and no telemetry.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `network` (`http`, `https`) | Poll the status sources you add | No other host is contacted |

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Source names and URLs | Even app per-app storage, on the phone | No |
| Bearer tokens | same | Only to that source, as a header |
| Poll interval | same | No |

Written through `setLocalStorage()` under `quietglass.statusglass.v1`.

Metric readings are held in memory only. No history is written.

**Home network watch (optional, server side).** When you run the reference
server with `STATUS_NETWATCH=1`, *your* server keeps a list of the devices on
your home network (MAC, IP, DNS name, first/last seen) in a file only its
owner can read, and sends it to the app with the status. The app shows it and
keeps it in memory only; "mark as known" goes to that server alone. Nothing is
sent anywhere else, and the watch only reads the machine's own neighbour table
unless you also switch on the ping refresh of your own private /24.

## Credentials

- Tokens are sent in an `Authorization` header, **never in the URL**, because
  URLs are logged by proxies and servers.
- Tokens are **never logged** by the app.
- The phone UI shows only that a token is set and how long it is — never its
  value. Shoulder-surfing the settings screen does not reveal it.
- Error messages shown on the glasses are shortened and never include the URL
  or headers.

## Transport

Prefer `https://`. Plain `http://` is allowed, because homelab services
routinely lack certificates and refusing it would only push people to disable
protections elsewhere — but the phone app marks such sources as unencrypted,
and anything sent over them travels in the clear.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login or device identifier.
- No advertising or third-party SDKs.
- No sensors: no microphone, no camera, no location.

## Removing your data

Removing a source deletes its URL and token. Uninstalling removes everything.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle.
