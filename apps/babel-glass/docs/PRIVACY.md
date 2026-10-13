# Babel Glass — privacy

## Kurzfassung (Deutsch)

Babel Glass hört nur zu, wenn du auf der Brille tippst; solange das Mikrofon
offen ist, zeigt die Brille **● MIC**. Der Ton geht ausschließlich an den
Spracherkennungs-Server, den du selbst einträgst, fertige Sätze an den
Übersetzungs-Server deiner Wahl. Ohne Server läuft ein Demo-Modus, bei dem kein
Ton das Handy verlässt. Ton und Mitschrift werden nie gespeichert; gespeichert
sind nur deine Einstellungen. Kein Konto, kein Tracking. Deinstallieren löscht
alles.

## Short version

Audio goes only to the server you configure. Nothing is stored.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `g2-microphone` | Hear speech while captions are switched on | Never on launch, never in the background; always shown as **● MIC** |
| `network` (`http`, `https`, `ws`, `wss`) | Reach the speech and translation servers you enter | No other host is contacted |

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
not something this app keeps unless you ask for it.

**Opt-in, off by default:** "Keep the last transcript on this phone" stores the
last conversation (at most 300 lines) and its summary in the Even app's
per-app storage on the phone, so it survives the phone lock and a restart of
the app. It never leaves the phone. Switching the option off deletes the stored
copy.

Holding the temple pad twice (the second hold within 4 seconds) clears the
transcript, including a stored copy; so does "Clear transcript" on the phone.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Server URLs, LLM model name | Even app per-app storage, on the phone | No |
| Tokens / API keys | same | Only to that server |
| Languages, mode, display options | same | No |
| Last transcript and summary — only with "keep the last transcript" on | same, under `quietglass.babelglass.conversation.v1` | No |

Finished captions are sent to the translation server you select
(LibreTranslate-compatible or an OpenAI-compatible LLM server) and nowhere
else.

Written through `setLocalStorage()` under `quietglass.babelglass.v1`.

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

## Removing your data

Clear the server addresses and tokens in the phone app to forget them. The
transcript is only stored if you switched "keep the last transcript" on;
"Clear transcript" or switching the option off deletes it. Uninstalling
removes everything.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
