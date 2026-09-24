# Status Glass — privacy

## Short version

Status Glass talks only to the servers you configure. There is no vendor
service, no account and no telemetry.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Source names and URLs | Even app per-app storage, on the phone | No |
| Bearer tokens | same | Only to that source, as a header |
| Poll interval | same | No |

Written through `setLocalStorage()` under `aignerlabs.statusglass.v1`.

Metric readings are held in memory only. No history is written.

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
