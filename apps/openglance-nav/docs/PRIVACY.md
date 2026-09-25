# OpenGlance — privacy

## Short version

Your position routes you and is never stored. No location history exists.

## Location

OpenGlance reads your position through the SDK's `getAppLocation` and
`onAppLocationChanged`, supplied by the phone.

It is used for exactly two things: routing from where you are, and working out
how far the next turn is. It is held in memory for the current fix and replaced
by the next one.

**No position history is written to storage.** Not a track, not a breadcrumb
trail, not a "last known location". Where a person has been is among the most
revealing data a device can hold, and there is no file here recording it.

Location updates stop when you stop navigating and when you leave the app.

## What leaves the device

Your current coordinates and your destination are sent to the **routing server
you configure**, because that is what routing requires. Nothing else is sent,
and nothing is sent anywhere else.

With no server configured, the mock router runs and **nothing leaves the device
at all**.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Routing server URL | Even app per-app storage, on the phone | No |
| Saved places | same | Only the selected one, to the router |
| Mode and settings | same | No |

Written through `setLocalStorage()` under `quietglass.openglance.v1`.

Saved places are yours to add and remove. Removing one deletes its coordinates.

## Choosing a routing server

A routing server necessarily learns where you are and where you are going.
That is a good reason to run your own — the README shows how, and it needs no
account or key.

If you use a public instance, that operator sees those coordinates. OpenGlance
cannot change that; it can only make sure the choice is yours and visible.

## What is not collected

- No analytics, telemetry or crash reporting.
- No account, login or device identifier.
- No advertising or third-party SDKs.
- No microphone, no camera.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Map data comes from OpenStreetMap contributors via your routing server.
