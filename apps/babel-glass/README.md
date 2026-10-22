# Babel Glass

**Quietglass** · Live captions and translation — on your own server.

Speech appears as text in your field of view, optionally translated. The
difference from everything else on the G2: **the recogniser is yours.**

## In short

> **Auf Deutsch, kurz:** Babel Glass zeigt, was um dich herum gesprochen wird, als Untertitel auf der Even G2 – auf Wunsch gleich übersetzt (z. B. Russisch oder Belarussisch → Deutsch). Die Spracherkennung läuft auf deinem eigenen Server, nicht in einer fremden Cloud. Es gibt die Modi Übersetzen, Englisch sprechen und Gespräch (mit Wortfinder, Antwort-Vorschlägen und eigenem Gedächtnis). Ohne Server zeigt die App feste Demo-Sätze.

Babel Glass shows you what is being said around you as captions on
the glasses — translated right away if you like (e.g. Russian or Belarusian →
German). Speech recognition runs on **your own** server, not in
someone else's cloud. Without a server, the app shows fixed demo sentences.

**How it works (from 1.0.0):** The glasses have three entries: **Translate**
(captions plus translation into the language set on the phone), **Speak English**
(you practise English: captions of what was said, the word finder is always on,
the other person is translated into German if you like) and **Conversation** (transcript,
speakers, summary on stop, info popups and reply suggestions; customers from
the local list are recognised). Once captions are running, the top shows "Mode · ● live" and the bottom a hint line; a tap prepares
the stop, and a second tap within 4 s stops. Swipe scrolls back through the
history. **2×** first closes a popup, then stops and goes back to the start; only
2× on the start screen opens the exit dialog. Hold never reaches the app on the
glasses, so nothing depends on it. Learning/deleting your voice, people, languages,
server and "My words" are on the phone (three tabs: **Now**, **My words**,
**Settings**). You clear the transcript only on the phone. While the microphone is open,
a **●** is shown in the glasses' header.

**Word finder:** If you get stuck (a sentence breaks off, "um", "how do you say", in an English
conversation a German word), Babel looks for the word by itself. If your voice has been learned,
only your own finished lines ("Me:") count, never a provisional line from
a stranger.

**Reply suggestions (from 0.5.0, on):** When the other person finishes a question
or a sentence that you should answer, your language model suggests **one**
short sentence (at most 12 words) — in the conversation language, so that you can
read it out; for a foreign language with a short German translation in
brackets. Context: the last minute plus the best-matching entries from your
own memory. At most every 15 s, never while you are speaking yourself, and
only when it fits (otherwise the model answers "-" and nothing appears).
Popups never stack: word finder/own sentence before reply suggestion
before explanation; whatever is waiting follows as long as it is still current.

**Translate my sentences (from 0.5.0, off):** Normally Babel translates what the
other person says (spoken language → "Translate into", e.g. Russian →
German). Switched on, **your own** sentences go the other way
(German → conversation language) and appear large as "→ …" in the captions, to
read out. Babel recognises your sentences by the speaker letter ("I am speaker"
A/B) or — without a speaker or with "automatic" — by your language;
leave "Spoken language" on automatic for that. If recognition does not work:
**swiping to the newest again, while already at the newest,** translates your last sentence
on demand (popup "→ …"). Both also appear in the transcript on the phone
(marked "Reply:" and "→ … to read out").

**Conversation companion (from 0.3.0):** With a server that can do streaming
(reference: `selfhost/services/whisper/`), provisional lines (with
"…") appear while speech is still going on, and final lines get speaker letters
("A:", "B:"). The phone page writes down the whole conversation. If a
factual question or a technical term comes up, your own language model explains it briefly as a
popup on the glasses. When you stop, there is a summary — short on the
glasses, detailed on the phone. Nothing is searched on the internet.

**Word finder (from 0.4.0):** If you are missing a word in the middle of a conversation, hold the
temple pressed. Your language model gets the last ~20 seconds and suggests
the word you were probably looking for plus 2–3 alternatives — one line on
the glasses, e.g. "Kostenvoranschlag · Angebot · Offerte", and, if a
translation is set, below it the word in the target language. After 8 s at most,
"no suggestion" appears. Under "I am speaker" (Settings → More options) you choose your
letter; "automatic" takes whoever spoke last.

**Own memory (from 0.4.0):** After every summary, Babel remembers
date, title, summary and agreements — on your own server, in the
babel-llm-proxy (`selfhost/services/babel-llm-proxy/`, endpoints `/memory`).
In a conversation, the explanation popups get the three best-matching earlier entries
as "notes of the user" and only remind you of them when it is concretely relevant. On the
phone (Settings → **Memory**) you view, delete, add (notes) and export
everything. Babel uses only this own memory. An older proxy
without `/memory` → "not available", otherwise nothing changes.

The app is available in German and English; it follows the language of your
phone. You can switch it at the top of the phone page under "Language" —
the glasses switch immediately. You enter the servers on the phone page
under "Server".

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
| **Swipe** (start screen) | Move the cursor: Translate · Speak English · Conversation (customers under it) |
| **Tap** (start screen) | Start the picked mode |
| **Tap** (running) | Arms the stop; a second tap within 4 s stops. Also closes a popup |
| **Swipe** (running) | Scroll back through what was said |
| **Swipe towards the newest** (live edge, *Translate* only) | Translate *my last sentence* into the conversation language |
| **Double tap** | Close a popup, then stop and return to the start screen; on the start screen: the exit dialog |

The glasses never send a hold to the app (the system menu opens instead), so no
function depends on it. Voice, people, languages, the server and "My words" live
on the phone.

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

**Streaming (optional, since 0.3.0).** The app adds `"stream": true` to the
start frame and sends `{"type":"stop"}` before it closes. A server that
supports streaming re-transcribes the current utterance about every 0.8 s and
replies with

```json
{"type":"partial","text":"guten Tag ich","stable":"guten Tag","final":false}
{"type":"final","text":"Guten Tag, ich komme morgen.","final":true,"language":"de","speaker":"A"}
```

`stable` is the prefix two consecutive hypotheses agreed on; `speaker` is an
optional single capital letter. Servers that ignore `stream` keep working.
The reference implementation is `selfhost/services/whisper/babel_stream.py`.

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

Since 0.3.2 translation, summary and explanations ask the LLM for
`"stream": true` (server-sent events). The glasses show the text while it is
written (redrawn at most every 300 ms): a caption's translation fills in step
by step, a summary or explanation grows. A server or proxy that answers with
plain JSON keeps working; a stream that fails before its first word is
retried once without streaming. `reasoning_content` and `<think>` blocks are
never shown. A long summary is paged on the glasses (swipe), never cut.

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

### Word finder and own memory (0.4.0)

**Word finder.** When you get stuck (automatic since 0.9.0; a hold only where the glasses deliver it) the app sends the last
~20 s of the transcript (with "I am speaker: A/B" chosen, mostly your own
lines; "auto" = whoever spoke last) plus the provisional line to the LLM with a
tight prompt: the likely word and 2–3 alternatives, only the words, separated
by ` · `. Request: `max_tokens` 40, temperature 0.1,
`chat_template_kwargs.enable_thinking=false`, 8 s timeout. The answer pops up
as one line of at most 40 characters (plus the word in the translation target,
if one is set); on a timeout the glasses say "kein Vorschlag"/"no suggestion".

**Own memory.** The [babel-llm-proxy](../../selfhost/services/babel-llm-proxy/)
keeps a small memory of the app's own, next to the LLM (`/memory`, same
host and auth as `/v1`):

```
POST   /memory          {"type":"session|note","title":"…","summary":"…","agreements":["…"],"date":"ISO"}
GET    /memory?limit=50 → {"memory":true,"entries":[…]}   newest first
DELETE /memory/<id>     DELETE /memory  (everything)
POST   /memory/search   {"query":"…","limit":3} → keyword (BM25) hits
```

After each summary the app stores date, title, summary and agreements
("Abmachungen"); notes typed on the phone are stored as `note`. The live
explanation prompt receives the top three hits for the newest lines as
"Notizen des Nutzers" and may remind you of one only when it fits concretely —
otherwise the model answers exactly `-` and nothing is shown. The phone tab
"Memory" lists, deletes, adds notes and exports everything as text. Against a
server without `/memory` the app says "not available" and otherwise behaves
as before. Babel Glass reads and writes no other memory store.

### Overview, reply ideas and own sentences (0.5.0)

**Header and popups (1.0.0).** While listening the glasses header holds only the
mode and the state (`Translate · ● live`, `● connecting …`, `● offline`, plus
`‖ history` when scrolled back; the demo marker, a translation error and the armed
`stop?` stay). The microphone's `●` is always there. The old help screen and the
overview table are gone: the start screen explains itself with one hint row per
screen. Every popup is labelled by its kind — `Info:`, `Reply:`/`Antwort:`,
`Word:`/`Wort:`, `→` — on the glasses and in the phone transcript.

**Reply ideas** (on by default). After a final line of the *other* person
(speaker letter ≠ "I am speaker"; with "auto" or speakers off: a line not in
your own language) that is a question or a real statement, the app waits
1.2 s and asks the LLM for exactly one sentence of at most 12 words in the
conversation language (with a translation target set: the foreign language,
plus a short gloss in brackets in yours), with the last ~60 s and the top
three memory hits as context. `max_tokens` 64, temperature 0.3,
`chat_template_kwargs.enable_thinking=false`, 8 s. The model answers exactly
`-` when no reply is needed. At most one shown suggestion per 15 s (a `-` does
not count), never while you speak, and a late answer is dropped once you have
said something. Popups never stack: word finder / own sentence > reply idea >
explanation; a lower one waits briefly and is dropped when stale.

**Own sentences** (off by default). Babel's normal direction is spoken
language → "Translate into" (your language). With "Translate my sentences" on,
your own final lines (speaker letter, or with speakers off/"auto" the lines
detected in your language) are translated the other way, into the
conversation language (the fixed spoken language, or the last detected
foreign one), and shown as `→ …` in place of the caption's translation. Leave
the spoken language on "auto" so your own speech is recognised as yours. On
demand, a swipe towards the newest while already at the live edge (and not the
tail of the swipe that got there) translates your last sentence and shows it
as a `→` popup.

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
- **Own memory (0.4.0, switchable):** summaries, agreements and your notes are
  kept on **your** server (babel-llm-proxy, file mode 600) and can be deleted
  from the phone. Nothing else is read or written.
- Tokens are never logged and never shown in full.

Captioning a conversation captures other people's speech; local law varies and
is your responsibility. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Install

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5197
npm run build      # typecheck + production bundle
npm test           # 284 unit tests
npm run sim        # Even Hub simulator pointed at the dev server
```

## Known limitations

| Limitation | Detail |
|---|---|
| Latency depends on your server | The glasses add little; the model dominates. The streaming reference server shows a provisional line about every 0.8 s. |
| Speaker labels are rough | The reference server tells voices apart by pitch and timbre only (no neural speaker model): clearly different voices work, similar voices may share a letter. |
| Summary and explanations need a language model | Any OpenAI-compatible server (vLLM, Ollama …). No web search. |
| Not verified on hardware | Built and tested against SDK 0.0.16; the simulator provides no meaningful speech. |
| Cyrillic on the G2 font | Renders in the simulator; unverified on hardware. Use "Show original as Latin transliteration" if it does not render. |
| Belarusian auto-detection | Whisper tends to report Belarusian as Russian; set the spoken language explicitly. |

## Roadmap

- Neural speaker embeddings (e.g. ECAPA) in the reference server.
- On-device language detection display.
- Optional saving of a session transcript, explicitly opt-in.

## License

MIT — see [LICENSE](LICENSE).
