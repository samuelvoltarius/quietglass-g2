# Babel Glass

**Aigner Labs** · Live captions and translation — on your own server.

Speech appears as text in your field of view, optionally translated. The
difference from everything else on the G2: **the recogniser is yours.**

---

## Why this exists

Every captioning app found for the Even G2 routes your audio through a paid
cloud service — Soniox, Deepgram, AssemblyAI. That means an account, a bill,
and your conversations on someone else's machine.

Babel Glass points at **your** `faster-whisper` instead. Speech recognition and
translation are separate, swappable providers, so you can self-host one, both,
or neither.

A complete reference speech server is included:
[`examples/whisper-server.py`](examples/whisper-server.py) — about eighty lines
on top of `faster-whisper`.

## Modes

| Mode | Rows | Shows | For |
|---|---|---|---|
| **Conversation** | 4 | translation + original | Back and forth, where checking one word matters |
| **Lecture** | 6 | translation only | One speaker at length |
| **Travel** | 3 | translation + original | Short exchanges, larger text |
| **Caption only** | 6 | original only | Accessibility captions in one language |

## The hard part: revisions

Recognisers revise their output. Append every partial result and the display
stutters and repeats — which on a small screen makes captions unreadable.

Babel Glass keeps exactly **one in-progress line**. Partial results replace it;
only a final result is committed to history. There are tests feeding in a
typical revision sequence (`the qui` → `the quick bro` → `the quick brown fox`)
asserting that history stays empty until the recogniser is done.

## Controls

| Gesture | Effect |
|---|---|
| **Tap** | Start / stop captioning |
| **Swipe** | Scroll back through what was said |
| **Hold** | Clear the transcript |
| **Double tap** | Leave — stops the microphone |

New speech pulls the view back to the live edge automatically, because reading
history while someone is still talking is not what you meant to do.

## Setting up a speech server

```bash
pip install faster-whisper websockets
python examples/whisper-server.py
MODEL=small DEVICE=cuda TOKEN=secret python examples/whisper-server.py
```

Then enter `ws://your-host:9000` in the phone app.

### Wire format

The client sends one JSON frame, then raw audio:

```json
{"type":"start","language":"auto","sampleRate":16000,"encoding":"s16le"}
```

…followed by binary frames of **16 kHz signed 16-bit mono PCM** — exactly what
the glasses produce, unmodified.

The server replies with JSON:

```json
{"text":"good morning","final":true,"language":"en"}
```

`{"transcript":...}` and `{"is_final":true}` are accepted too, so several
existing servers work without changes.

### Translation

Any LibreTranslate-compatible endpoint:

```json
POST /translate  {"q":"good morning","source":"en","target":"de","format":"text"}
```

Leave it empty to caption without translating.

## Without a server

With no speech URL configured, Babel Glass runs a **mock** that emits fixed
placeholder text and displays `MOCK` on the glasses. It exists so the interface
can be tried and developed without infrastructure — it transcribes nothing, and
says so.

## Privacy

- The microphone opens **only on an explicit tap**, and `● MIC` is shown for as
  long as it is open. Not configurable.
- Audio goes **only to the server you configure**. With the mock, it goes
  nowhere at all.
- **No audio is ever stored.**
- **The transcript is memory-only** and is discarded when you close the app.
- Tokens are never logged and never shown in full.

Captioning a conversation captures other people's speech; local law varies and
is your responsibility. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Install

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5197
npm run build      # typecheck + production bundle
npm test           # 64 unit tests
npm run sim        # Even Hub simulator pointed at the dev server
```

## Known limitations

| Limitation | Detail |
|---|---|
| Latency depends on your server | The glasses add little; the model and window size dominate. The reference server transcribes in 2-second windows. |
| No speaker separation | Who said what is not distinguished. |
| Partial results depend on the server | The reference server sends finals only; the app supports partials if yours emits them. |
| Not verified on hardware | Built and tested against SDK 0.0.16; the simulator provides no meaningful speech. |

## Roadmap

- Speaker labels where the backend supplies them.
- On-device language detection display.
- Optional saving of a session transcript, explicitly opt-in.

## License

MIT — see [LICENSE](LICENSE).
