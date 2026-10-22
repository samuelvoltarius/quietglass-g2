# babel-llm-proxy — translation for Babel Glass

Babel Glass translates through an **OpenAI-compatible LLM** (`/v1/chat/completions`). This small proxy
(Python standard library only, no `pip install`) sits in front of it and does what the glasses app needs:

- CORS (preflight 204 with no body),
- Streaming pass-through: if the app asks with `"stream": true` (from Babel Glass 0.3.2), the
  server-sent events go through line by line, unbuffered (text appears on the glasses while it is being written).
  Without `stream`, you get one whole JSON answer, as before.
- It turns off the "thinking" of Qwen models (`enable_thinking: false`). Otherwise a translation takes seconds.
- Optional sign-in (token or Tailscale login).
- **From Babel Glass 0.4.0: Babel's own memory** (see below).

| Local | Tailscale port (suggestion) | App field |
|---|---|---|
| `127.0.0.1:8121` | `8448` | "Translator" (Übersetzer) = `https://<your-machine>.<your-tailnet>.ts.net:8448/v1` |

Enter the **model** in the app (or as `VITE_BABEL_MODEL` in the private build) exactly as your LLM server names it
(for example `qwen`; see `curl http://127.0.0.1:8000/v1/models`).

## Requirement: an LLM server

vLLM (`vllm serve <model> --port 8000`), Ollama (`UPSTREAM=http://127.0.0.1:11434`) or a llama.cpp server.
Multilingual models work well (the Qwen family). For Belarusian/Russian → German, pick a larger model.
(Ollama ignores `chat_template_kwargs`. It is unchecked whether this has side effects there.)

## Own memory (from Babel Glass 0.4.0)

After each summary, Babel remembers the date, title, summary and agreements, plus notes from the phone. It keeps
them in **one JSON file next to the proxy** (`babel-memory.json`, changeable with `BABEL_MEMORY_FILE`, gitignored
in the repo). Writes are atomic (temp file + `os.replace`), with mode 600, and there are at most `BABEL_MEMORY_CAP`
(500) entries. The oldest ones drop out. **Nothing else** is read or written.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/memory` | Append an entry `{type:"session"|"note", title, summary, agreements[], date?}` |
| `GET` | `/memory?limit=N` | Newest first |
| `DELETE` | `/memory/<id>` | Delete one entry |
| `DELETE` | `/memory` | Delete everything |
| `POST` | `/memory/search` | `{query, limit}` → keyword search (BM25, light word forms) |

Also reachable under `/v1/memory…`. Same sign-in as `/v1/chat/completions` (an empty `TOKEN` = open inside the
tailnet). Every answer carries `"memory": true`, so the app can detect an old proxy.

Self-test (starts a proxy on a free port, without an LLM):

```bash
python3 babel_llm_proxy.py --selftest      # ends with "alles gruen" ("all green")
```

## Customer context from Shoot Day (optional)

If a **Shoot Day** server runs on the same machine, the proxy can pass its material about the current customer
into Babel's reply suggestions, word finder and summary. It never goes into the normal translation. It reads with
`GET /api/customers`, `/api/customers/<id>/brief`, `/api/projects/<id>`. The only writes are the talk note and the
talk feedback described below (they only append something to the customer's current project). It has no access to
other services.

| Variable | Meaning |
|---|---|
| `BABEL_SHOOT_URL` | For example `http://127.0.0.1:8899`. Empty = off (default) |
| `BABEL_SHOOT_TOKEN` | Bearer token of the Shoot Day server (its `TOKEN`), optional |
| `BABEL_SHOOT_TIMEOUT` | Seconds for all lookups together (default `2`) |
| `BABEL_SHOOT_FEEDBACK` | Write the talk feedback to Shoot Day: on by default (if `BABEL_SHOOT_URL` is set), `0` = off |
| `BABEL_SHOOT_TALKS` | Write the talk note (summary + tip cards) to Shoot Day: on by default (if `BABEL_SHOOT_URL` is set), `0` = off |
| `BABEL_SHOOT_FEEDBACK_MODEL` | Model for the analysis, optional (otherwise the summary's model, or the first one from `/v1/models`) |

- **Which customer:** by default, the customer of the active Shoot Day project (`activeCustomer`). "Ohne Zuordnung"
  (Unassigned) is skipped (then there is no context). You can override this per request with the body field
  `"customer"` or the header `X-Babel-Customer` (ID or name, also part of a name; `-` = no context).
  `"shoot_context": false` turns it off for one request. Both fields are removed before the LLM sees the request.
- **Content** (in German, at most 2,500 characters): customer/company, active or next project (name, date, place),
  customer note, open ideas with #tags, storyboard titles with one line per scene, overlays/slogans, and the first
  ~600 characters of the script (prompter). It is appended to the system prompt:
  "Gesprächskontext (Kunde): … Nutze ihn für passende Antwortvorschläge und Begriffe; erfinde nichts dazu."
  (Conversation context (customer): … Use it for fitting reply suggestions and terms; do not invent anything.)
- **Robust:** 60 s cache (errors: 15 s), time limit 2 s. If Shoot Day is slow or gone, only the context is missing.
  Babel keeps working normally.
- **Display:** `GET /context/customer` (also `/v1/context/customer`, same sign-in, optional `?customer=`)
  → `{"context": true, "enabled", "name", "project", "chars", "ideas", "storyboards"}`, without the text itself.
- **Another idea during the talk (live):** For reply suggestions, there is an extra instruction. If the customer
  rejects a prepared idea, doubts it, changes it or brings a new wish, exactly one clarifying question follows
  (goal, mood, where/when, who is in front of the camera). Only if it fits, a prepared idea is added. Nothing is
  invented.

### Talk note to Shoot Day (`BABEL_SHOOT_TALKS`)

After each summary, the proxy sends `POST /api/projects/<pid>/talks {at, summary, cues}` to the customer's current
project. This happens in the background; the answer to the glasses does not wait for it. The customer and project
are chosen as for the feedback below. `summary` = the text of the summary (`lang`, otherwise `kurz`, plus
"Abmachungen" (agreements)). `cues` = the tip cards that the app attaches to the request under "Tipp-Karten während
des Gesprächs" (tip cards during the talk) (`[{title, text, kind}]`). The same summary is stored only once within
30 min. If it fails, Babel keeps working normally. Shoot Day turns it into a comment in the Work Dashboard.
Nothing else is written.

### Talk feedback to Shoot Day (`BABEL_SHOOT_FEEDBACK`)

`POST /context/feedback` (also `/v1/context/feedback`, same sign-in as all proxy endpoints)
with `{"transcript": "…", "customer": "<ID or name, optional>"}` (the last 12,000 characters count):

1. The customer is chosen as for the context (active customer, or `customer`). "Ohne Zuordnung" (Unassigned) / no
   customer / no project → **nothing** is written (`reason` in the answer).
2. The same LLM (no thinking, temperature 0.1, JSON only) extracts: new or preferred ideas, rejected prepared ideas
   (with title + reason), changes/wishes, open questions. Each is one short German sentence with tags.
   Broken JSON → nothing is written.
3. `GET /api/projects/<pid>`, then `POST /api/projects/<pid>/ideas` with the **complete** list: all existing ideas
   unchanged (IDs, done status) + the new ones, for example `"14.10.: Barista erklärt …"` with the tags
   `gespraech` + `neu` | `abgelehnt` | `wunsch` | `frage`. Similar texts (ignoring case, date and punctuation) are
   skipped. Nothing is ever deleted or changed. Nothing else is written (not even to the Brain).

Answer: `{"added": ["14.10.: …"], "skipped": n, "customer", "project"}`. The same text within 30 min →
`{"duplicate": true}`. Errors → 502, switched off → 503.

**Automatic:** After each summary ("Du fasst ein mitgeschriebenes Gespräch …", "You summarize a transcribed
conversation …") with an active customer context, exactly this analysis runs in the background on the same talk
text. It starts only after the summary has been returned to Babel. At most once per talk text in 30 min. An error
there is only logged and never disturbs the summary.

**Tip cards (customer talk, read-only):** `POST /context/cue {"transcript": "<last ~3 min, max 6000 characters>",
"customer"?, "recent_titles": [...]}` asks the LLM (no thinking, temperature 0.3, max. 120 tokens), using the
customer context, for at most one short card for the wearer. Answer `{"cue": {"title" (≤ 40), "text" (≤ 140),
"kind": "tipp"|"begriff"|"fakt"|"achtung"}}` or `{"none": true}` (also for broken JSON or a repeat from
`recent_titles`). Time limit 6 s (`BABEL_CUE_TIMEOUT`) → 504 `{"none": true, "error": "timeout"}`; LLM error → 502.
If Babel attaches the cards to the summary ("Tipp-Karten während des Gesprächs …"), the proxy cuts them off
before the Shoot Day feedback.

Tests (fake Shoot Day server + fake LLM, 127.0.0.1 only): `python3 -m pytest test_shoot_context.py
test_shoot_feedback.py test_cue.py test_shoot_talks.py` (or `python3 -m unittest test_shoot_context test_shoot_feedback test_cue`).

## Install

```bash
mkdir -p ~/.config/quietglass ~/.config/systemd/user
cp .env.example ~/.config/quietglass/babel-llm-proxy.env && chmod 600 ~/.config/quietglass/babel-llm-proxy.env
$EDITOR ~/.config/quietglass/babel-llm-proxy.env        # UPSTREAM, optional TOKEN / TAILSCALE_USERS
cp babel-llm-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now babel-llm-proxy
loginctl enable-linger "$USER"
systemctl --user is-active babel-llm-proxy
curl -s http://127.0.0.1:8121/v1/models | head -c 200   # shows the models of the LLM server
```

The unit paths assume the repo is at `~/quietglass-g2`. Otherwise, adjust `ExecStart`.

## Publish with Tailscale (never `serve reset`)

```bash
tailscale serve --bg --https=8448 http://127.0.0.1:8121
tailscale serve status
```

## Update (existing installation)

```bash
cd ~/quietglass-g2 && git pull
python3 selfhost/services/babel-llm-proxy/babel_llm_proxy.py --selftest
systemctl --user restart babel-llm-proxy && systemctl --user is-active babel-llm-proxy
curl -s http://127.0.0.1:8121/memory?limit=1     # with TOKEN: -H "Authorization: Bearer …"  → {"memory": true, …}
```
