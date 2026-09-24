# PromptFlow — privacy

## Short version

PromptFlow contains no network code. It cannot send your scripts anywhere,
because it has nowhere to send them to.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Your scripts (title + text) | Even app per-app storage, on your phone | No |
| Reading settings | same | No |

Written through `setLocalStorage()` under the single key
`aignerlabs.promptflow.v1`.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login or device identifier.
- No advertising or third-party SDKs.

## Permissions

`app.json` requests **none** — including no microphone. PromptFlow 0.1.0 does
not listen, so it does not ask.

When voice-follow ships it will require the microphone. It will be **off by
default**, the permission will only be requested if you enable it, and the
README and this document will state exactly where audio is sent for recognition.

## Network

There is no configurable endpoint and no outbound request in the source. The
only network activity is loading the app itself.

## Removing your data

Uninstalling PromptFlow removes its per-app storage, and with it every script
and setting. Individual scripts can be removed in the phone companion.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK, which
communicates with the Even app on your phone. Build-time tools (Vite, TypeScript,
Vitest) ship no code into the bundle beyond the compiled application.
