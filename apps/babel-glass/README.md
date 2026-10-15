# Babel Glass

**Quietglass** · Live captions and translation — on your own server.

Speech appears as text in your field of view, optionally translated. The
difference from everything else on the G2: **the recogniser is yours.**

## Kurz auf Deutsch

Babel Glass zeigt dir, was um dich herum gesprochen wird, als Untertitel auf
der Brille — auf Wunsch gleich übersetzt (z. B. Russisch oder Belarussisch →
Deutsch). Die Spracherkennung läuft auf **deinem eigenen** Server, nicht in
einer fremden Cloud. Ohne Server zeigt die App feste Demo-Sätze.

**So geht's:** Einmal auf den Bügel tippen startet die Untertitel; laufen sie,
bereitet Tippen den Stopp vor und ein zweites Tippen innerhalb von 4 s stoppt.
Wischen blättert zurück, **Halten während der Untertitel startet den Wortfinder**.
Bei gestoppten Untertiteln öffnet Halten die Hilfe; Meine Stimme lernen/löschen und
Personen stehen am Ende der Kundenliste („Meine Stimme löschen“ braucht ein zweites
Tippen innerhalb von 4 s). Das Seitenmenü der Brille ist vorerst aus (seine Klicks
kommen auf der Brille nicht an). 2× im
Hauptbild öffnet den Beenden-Dialog; laufende Untertitel enden erst, wenn du das
Beenden bestätigst. Die Mitschrift löschst du nur am Handy. Solange das Mikrofon
offen ist, steht **● MIKRO** auf der Brille.

**Übersicht (ab 0.5.0):** Beim Zuhören zeigt die Kopfzeile kompakt, was gerade
läuft, z. B. „● MIKRO · RU→DE · A/B · Antworten · Gedächtnis“ (nur Aktives).
Jedes Popup beginnt mit seiner Art: „Info:“ (Erklärung), „Antwort:“
(Antwort-Vorschlag), „Wort:“ (Wortfinder), „→“ (dein Satz übersetzt). Die
**Hilfe** (Halten bei gestoppten Untertiteln) und ihre Übersicht-Seiten zeigen jede Funktion,
wie sie ausgelöst wird und ob sie gerade an ist (Tippen = schließen). Am Handy
steht oben im Tab Gespräch dieselbe Übersicht als Tabelle mit Schaltern und
Live-Status (Server live/Demo, Gedächtnis verbunden/nicht verfügbar) und einem
Knopf „Hilfe auf der Brille zeigen“.

**Antwort-Vorschläge (ab 0.5.0, an):** Beendet dein Gegenüber eine Frage oder
einen Satz, auf den du antworten solltest, schlägt dein Sprachmodell **einen**
kurzen Satz vor (höchstens 12 Wörter) – in der Gesprächssprache, damit du ihn
vorlesen kannst; bei einer Fremdsprache mit kurzer deutscher Übersetzung in
Klammern. Kontext: die letzte Minute plus die passendsten Einträge aus dem
eigenen Gedächtnis. Höchstens alle 15 s, nie während du selbst sprichst, und
nur wenn es passt (sonst antwortet das Modell „-“ und es erscheint nichts).
Popups kommen nie übereinander: Wortfinder/eigener Satz vor Antwort-Vorschlag
vor Erklärung; Wartendes folgt, solange es noch aktuell ist.

**Meine Sätze übersetzen (ab 0.5.0, aus):** Normal übersetzt Babel, was das
Gegenüber sagt (gesprochene Sprache → „Übersetzen in“, z. B. Russisch →
Deutsch). Eingeschaltet gehen **deine eigenen** Sätze in die andere Richtung
(Deutsch → Gesprächssprache) und stehen groß als „→ …“ in den Untertiteln, zum
Vorlesen. Deine Sätze erkennt Babel am Sprecher-Buchstaben („Ich bin Sprecher“
A/B) oder – ohne Sprecher bzw. bei „automatisch“ – an deiner Sprache;
„Gesprochene Sprache“ dafür auf automatisch lassen. Klappt die Erkennung nicht:
**am neuesten Stand nochmal zum Neuesten wischen** übersetzt deinen letzten Satz
auf Abruf (Popup „→ …“). Beides erscheint auch in der Mitschrift am Handy
(markiert „Antwort:“ bzw. „→ … zum Vorlesen“).

**Gesprächs-Begleiter (ab 0.3.0):** Mit einem Server, der Streaming kann
(Referenz: `selfhost/services/whisper/`), erscheinen vorläufige Zeilen (mit
„…“) schon während gesprochen wird, feste Zeilen bekommen Sprecher-Buchstaben
(„A:“, „B:“). Die Handy-Seite schreibt das ganze Gespräch mit. Fällt eine
Sachfrage oder ein Fachbegriff, erklärt dein eigenes Sprachmodell ihn kurz als
Popup auf der Brille. Beim Stoppen gibt es eine Zusammenfassung – kurz auf der
Brille, ausführlich auf dem Handy. Gesucht wird dabei nichts im Internet.

**Wortfinder (ab 0.4.0):** Fehlt dir mitten im Gespräch ein Wort, halte den
Bügel gedrückt. Dein Sprachmodell bekommt die letzten ~20 Sekunden und schlägt
das wahrscheinlich gesuchte Wort plus 2–3 Ausweichwörter vor – eine Zeile auf
der Brille, z. B. „Kostenvoranschlag · Angebot · Offerte“, bei eingestellter
Übersetzung darunter das Wort in der Zielsprache. Nach spätestens 8 s steht
„kein Vorschlag“ da. Unter „Ich bin Sprecher“ (Tab Gespräch) wählst du deinen
Buchstaben; „automatisch“ nimmt, wer zuletzt gesprochen hat.

**Eigenes Gedächtnis (ab 0.4.0):** Nach jeder Zusammenfassung merkt sich Babel
Datum, Titel, Zusammenfassung und Abmachungen – auf deinem eigenen Server, im
babel-llm-proxy (`selfhost/services/babel-llm-proxy/`, Endpunkte `/memory`).
Im Gespräch bekommen die Erklär-Popups die drei passendsten früheren Einträge
als „Notizen des Nutzers“ und erinnern nur daran, wenn es konkret passt. Am
Handy (Tab **Gedächtnis**) siehst, löschst, ergänzt (Notizen) und exportierst du
alles. Babel nutzt ausschließlich dieses eigene Gedächtnis. Ein älterer Proxy
ohne `/memory` → „nicht verfügbar“, sonst ändert sich nichts.

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
| **Tap** | Start / stop captioning; closes the help screen or a popup first |
| **Swipe** | Scroll back through what was said |
| **Swipe towards the newest** (already at the live edge) | Translate *my last sentence* into the conversation language (0.5.0) |
| **Swipe** (captions off, no summary on screen) | Help screen: every helper, its trigger, on/off now (0.5.0); tap = back |
| **Hold** (captions on) | Word finder: suggests the word you are missing (0.4.0) |
| **Hold twice** (captions off) | Clear the transcript |
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

**Word finder.** Holding the temple pad while captions run sends the last
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

**Overview.** One source (`src/companion/overview.ts`) feeds three views that
therefore never disagree: the glasses header while listening (only what is
active, e.g. `● MIC · RU→DE · A/B · Replies · Memory`; least important parts
drop first so it always fits 46 characters, the microphone never), the glasses
help screen (swipe while stopped, or the phone button) and the phone table at
the top of the Talk tab (switch, trigger, live state). Every popup is labelled
by its kind — `Info:`, `Reply:`/`Antwort:`, `Word:`/`Wort:`, `→` — on the
glasses and in the phone transcript.

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
