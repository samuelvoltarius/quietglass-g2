# Babel Glass

**Quietglass** · Live captions and translation — on your own server.

Speech appears as text in your field of view, optionally translated. The
difference from everything else on the G2: **the recogniser is yours.**

## Kurz auf Deutsch

Babel Glass zeigt dir, was um dich herum gesprochen wird, als Untertitel auf
der Brille — auf Wunsch gleich übersetzt (z. B. Russisch oder Belarussisch →
Deutsch). Die Spracherkennung läuft auf **deinem eigenen** Server, nicht in
einer fremden Cloud. Ohne Server zeigt die App feste Demo-Sätze.

**So geht's:** Einmal auf den Bügel tippen startet die Untertitel, nochmal
tippen stoppt sie. Wischen blättert zurück, Halten löscht die Mitschrift,
Doppeltippen beendet die App. Solange das Mikrofon offen ist, steht
**● MIKRO** auf der Brille.

Die App gibt es auf Deutsch und Englisch; sie folgt der Sprache deines
Handys. Umstellen kannst du das oben auf der Handy-Seite unter „Sprache“ —
die Brille wechselt sofort mit. Die Server trägst du auf der Handy-Seite
unter „Erweitert: Server“ ein.

The app is available in German and English: it follows the phone language
and can be switched at the top of the phone page.

---

![On the glasses](docs/screenshot.png)

*Captured from the Even Hub simulator at the real 576 × 288.*

## Why this exists

Every captioning app found for the Even G2 routes your audio through a paid
cloud service — Soniox, Deepgram, AssemblyAI. That means an account, a bill,
and your conversations on someone else's machine.

Babel Glass points at **your** `faster-whisper` instead. Speech recognition and
translation are separate, swappable providers, so you can self-host one, both,
or neither.

A complete reference speech server is included:
[`examples/whisper-server.py`](examples/whisper-server.py) — about 130
lines on top of `faster-whisper` — plus a LibreTranslate-compatible NLLB-200
translation server, [`examples/translate-server.py`](examples/translate-server.py),
for pairs LibreTranslate lacks (Belarusian).

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

Two kinds of translation server can be selected in the phone app:

**LibreTranslate-compatible** — LibreTranslate itself, or the NLLB-200 server
in [`examples/translate-server.py`](examples/translate-server.py):

```json
POST /translate  {"q":"good morning","source":"en","target":"de","format":"text"}
```

**OpenAI-compatible LLM** — any server with `/v1/chat/completions`: vLLM,
Ollama, LM Studio, llama.cpp server. Enter the base URL (`http://host:11434/v1`)
and the model name; a bearer token is optional. Babel Glass sends a strict
"translate from X to Y, output only the translation" prompt at temperature
0.1 (15 s timeout) and strips quotes, preambles and `<think>` blocks from the
answer. With the spoken language on "auto", the language Whisper detected is
put into the prompt instead of "auto". LibreTranslate keeps receiving
`source: "auto"` exactly as before.

Leave the selected provider unconfigured to caption without translating. A
failing translation server shows `translate: <reason>` on the glasses
instead of failing silently.

The phone app calls these servers from a WebView, so the server must allow
cross-origin requests. Ollama only allows `127.0.0.1`/`0.0.0.0` origins by
default — start it with `OLLAMA_ORIGINS="*"`; in LM Studio enable CORS;
`translate-server.py` sends `Access-Control-Allow-Origin: *` itself.

## Russian / Belarusian → German

Everything below runs on your own machine. No cloud account and no API key is
needed.

**Why not just LibreTranslate:** LibreTranslate translates with Argos models,
and the Argos package index has **no Belarusian model** (checked 2026-10-06
against `argosopentech/argospm-index` `index.json`: 100 packages, none with
`be`). Russian→German exists there only by pivoting through English
(`ru→en`, `en→de`). For Belarusian use option 2a or 2b below.

**1. Speech server** — a large multilingual Whisper model:

```bash
pip install faster-whisper websockets
MODEL=large-v3 DEVICE=cuda COMPUTE=float16 python examples/whisper-server.py
# CPU only (slow): MODEL=large-v3 COMPUTE=int8 python examples/whisper-server.py
```

`base`, the script's default, is too small for Belarusian. `distil-*` models
are English-only. `large-v3-turbo` is faster; its Belarusian accuracy has not
been measured here. The `language` from the app's start frame is passed to
Whisper (`be`, `ru`; region tags like `be-BY` are reduced to `be`).

**2a. Translation with a local LLM** (OpenAI-compatible):

```bash
OLLAMA_ORIGINS="*" ollama serve
ollama pull qwen2.5:7b-instruct          # or any instruct model you trust
# or: vllm serve Qwen/Qwen2.5-7B-Instruct --port 8000
```

**2b. Translation with NLLB-200** (dedicated MT model, direct
`bel_Cyrl`/`rus_Cyrl` → `deu_Latn`, LibreTranslate-compatible):

```bash
pip install transformers torch sentencepiece
python examples/translate-server.py      # http://0.0.0.0:5000/translate
MODEL=facebook/nllb-200-distilled-1.3B DEVICE=cuda python examples/translate-server.py
```

The NLLB-200 weights are licensed **CC-BY-NC-4.0** (non-commercial use).

**3. Phone app settings:**

| Setting | Value |
|---|---|
| Speech server | `ws://your-host:9000` |
| Spoken language | **Belarusian** or **Russian**, set explicitly — on "auto" Whisper often reports Belarusian as Russian |
| Translation server | *OpenAI-compatible LLM*: base URL `http://your-host:11434/v1` (Ollama) or `http://your-host:8000/v1` (vLLM), model `qwen2.5:7b-instruct` — or *LibreTranslate-compatible*: `http://your-host:5000/translate` (NLLB) |
| Translate into | **German** |
| Mode | Conversation (German on top, original below) |
| Show original as Latin transliteration | off — the simulator draws Cyrillic; turn on only if the hardware does not |

With the spoken language fixed to `be`, Whisper transcribes as Belarusian and
the translator receives `be`; the detection is not consulted.

**Simulator check (2026-10-06):** the Even Hub simulator (0.9.5) draws
Russian, Belarusian (incl. `ў`, `і`, `ё`) and Ukrainian Cyrillic, German
`ä ö ü ß`, and `€ ° · … → ● – „“` with the G2 text container — see
[docs/cyrillic-simulator.png](docs/cyrillic-simulator.png).

**Not yet verified:** Babel Glass has not run on G2 hardware, and the simulator
font may differ from the firmware font. If the glasses drop Cyrillic, the
transliteration switch shows the original line as ASCII (`Dobry dzen', yak
spravy?`) while leaving the German translation, ä/ö/ü/ß included, untouched. No
servers were run for this change: translation quality of any particular LLM or
NLLB size for Belarusian has not been measured here. Wrapping counts
characters; the simulator capture shows a 40-character Cyrillic line using
about three quarters of the 576 px width.

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
npm test           # 142 unit tests
npm run sim        # Even Hub simulator pointed at the dev server
```

## Known limitations

| Limitation | Detail |
|---|---|
| Latency depends on your server | The glasses add little; the model and window size dominate. The reference server transcribes in 2-second windows. |
| No speaker separation | Who said what is not distinguished. |
| Partial results depend on the server | The reference server sends finals only; the app supports partials if yours emits them. |
| Not verified on hardware | Built and tested against SDK 0.0.16; the simulator provides no meaningful speech. |
| Cyrillic on the G2 font | Renders in the simulator; unverified on hardware. Use "Show original as Latin transliteration" if it does not render. |
| Belarusian auto-detection | Whisper tends to report Belarusian as Russian; set the spoken language explicitly. |

## Roadmap

- Speaker labels where the backend supplies them.
- On-device language detection display.
- Optional saving of a session transcript, explicitly opt-in.

## License

MIT — see [LICENSE](LICENSE).
