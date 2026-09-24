# ShiftClock — privacy

## Short version

ShiftClock has no network code and no account. Your hours stay on your phone.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Project names | Even app per-app storage, on the phone | No |
| Time entries | same | No |
| The currently open entry | same | No |

Written through `setLocalStorage()` under the single key
`aignerlabs.shiftclock.v1`. The log is bounded to the most recent 2000 entries.

The open entry is written as it happens rather than on exit, so a crash or a
dropped connection cannot lose tracked time.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login, sync or device identifier.
- No advertising or third-party SDKs.

## Sensors

ShiftClock uses **no sensors**: no microphone, no camera, no location.
`app.json` requests no permissions.

Working hours can reveal a great deal about a person — where they were, when,
and for whom. That is exactly why this app has nowhere to send them.

## Export

CSV export hands the file to your phone's own share sheet. ShiftClock does not
upload it and has no server component.

## Removing your data

"Clear log" in the phone companion erases all entries. Uninstalling removes
everything, including project names.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle.
