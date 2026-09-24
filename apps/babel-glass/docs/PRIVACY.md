# Babel Glass — privacy

## Short version

Audio goes only to the server you configure. Nothing is stored.

## The microphone

Babel Glass opens the microphone **only when you tap to start**. Never on
launch, never on a schedule.

While it is open, the glasses display **● MIC**. The indicator is not
configurable and there is no code path that captures without it.

## Where audio goes

Raw PCM is streamed to the speech recognition server **you** configure. If you
configure none, the built-in mock runs and **no audio leaves the device at
all** — the mock ignores the audio entirely and emits fixed placeholder text,
with `MOCK` shown on the glasses so it can never be mistaken for real
transcription.

Audio is never written to storage, on the phone or anywhere else.

## The transcript

Captions live **in memory only**, bounded to the most recent lines, and are
discarded when the app closes. A record of everything said around a person is
not something this app is willing to keep.

Holding the temple pad clears the transcript immediately.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Server URLs | Even app per-app storage, on the phone | No |
| Tokens / API keys | same | Only to that server |
| Languages and mode | same | No |

Written through `setLocalStorage()` under `aignerlabs.babelglass.v1`.

Secrets are never logged and are never shown in full in the phone app — only
"set (24 chars)".

## Transport

Prefer `wss://` and `https://`. Plain `ws://` and `http://` are permitted for
servers on your own LAN, but the phone app marks them: over an unencrypted
connection, **your audio travels in the clear**.

## Other people

Captioning a conversation captures other people's speech. Local law on
recording others varies and is your responsibility. Babel Glass reduces the
risk by never storing audio, never storing the transcript beyond the session,
and always showing a visible indicator that the microphone is live.

## What is not collected

- No analytics, telemetry or crash reporting.
- No account, login or device identifier.
- No advertising or third-party SDKs.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
