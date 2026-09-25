# FieldLog — privacy

## Short version

Audio goes only to the server you configure and is never stored. Entries and
photos stay on your phone until you export them.

## The microphone

FieldLog opens the microphone **only when you tap to dictate**. Never on
launch, never continuously. While it is open the glasses show **● MIC**, and
that indicator is not configurable.

Recording stops as soon as the transcript arrives — the microphone is open for
the length of one spoken entry, not for the length of the walk.

## The camera

The glasses have no camera. Photos come from the phone's own camera through the
SDK's picker, which you trigger by holding the temple pad. Nothing is captured
without that action.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Inspections, entries, photos | Even app per-app storage, on the phone | No |
| Speech server URL and token | same | Token only to that server |

Written through `setLocalStorage()` under `quietglass.fieldlog.v1`.

Audio is **never** stored — it is streamed to your recogniser and discarded.

## Export

Export hands a file to your phone's own share sheet. FieldLog does not upload
it and has no server component.

## Other people's property

An inspection often documents somewhere that is not yours, and photographs may
include people. The obligations that come with that are yours. FieldLog is
built so that what you record stays under your control: no cloud, no account,
no automatic sync.

## What is not collected

- No analytics, telemetry or crash reporting.
- No account, login or device identifier.
- No advertising or third-party SDKs.
- No location in 0.1.0.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
