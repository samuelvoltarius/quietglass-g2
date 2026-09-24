# FlowList — privacy

## Short version

FlowList contains no network code. It cannot send your checklists anywhere,
because it has nowhere to send them to.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Your checklists | Even app per-app storage, on your phone | No |
| Display settings | same | No |

Written through `setLocalStorage()` under the single key
`aignerlabs.flowlist.v1`.

Run progress is held in memory only. Closing the app discards it; FlowList does
not keep a record of what you did or when.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login or device identifier.
- No advertising or third-party SDKs.

## Sharing

Export writes a pack file through your phone's own share sheet. FlowList does
not upload it, does not see where it goes, and has no server component.

## Permissions

`app.json` requests **none**. FlowList does not use the microphone, the camera
or your location.

If voice commands ship later they will require the microphone. They will be
**off by default**, the permission will only be requested if you enable them,
and this document will state exactly where audio is processed.

## Removing your data

Uninstalling FlowList removes its per-app storage, and with it every checklist
and setting. Individual checklists can be removed in the phone companion.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK, which
communicates with the Even app on your phone. Build-time tools (Vite,
TypeScript, Vitest) ship no code into the bundle.
