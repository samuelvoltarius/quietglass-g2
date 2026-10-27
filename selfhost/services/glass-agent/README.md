# Glasses agent (glass-agent)

Turns your own AI agent, for example [Hermes](https://github.com/NousResearch/hermes-agent) with its
OpenAI-compatible API server, into the "Even AI" of the Even Realities G2.

In the Even app, under **Settings → Add agent** (name, URL, key), you can enter your own
agent. The app then sends every question as an OpenAI chat request: `"model":"openclaw"`, only the
last sentence, no history, no system text, no streaming. The glasses show about 400–500 characters.
This small service sits in between and

- remembers the running conversation for a few minutes (follow-up questions such as "und morgen?" ("and tomorrow?")
  work; "Neues Gespräch" ("new conversation") starts from scratch),
- tells the agent that the answer goes to glasses (short, no emojis/formatting),
- cleans up the answer and shortens it at the end of a sentence (default 350 characters),
- keeps the agent's key away from the phone (the Even app only knows `GLASS_AGENT_TOKEN`),
- does not log any content, only length and duration,
- switches automatically when a model fails or its quota is empty
  (`GLASS_AGENT_FALLBACKS`, for example first a subscription model, then another, and last your own vLLM).
  A route with an empty quota is skipped for 15 minutes. It switches **only on real errors**
  (HTTP errors, connection refused, quota/429), not because the agent is slow,
- lets a slow agent keep working in the background (see below),
- can ask you on the glasses to confirm Hermes actions beforehand (approval levels, see below).

Python standard library only. Self-test: `python3 glass_agent.py --selftest`.

## Set-up

```bash
mkdir -p ~/glass-agent && cp glass_agent.py ~/glass-agent/
cat > ~/glass-agent/.env <<'EOF'
GLASS_AGENT_TOKEN=<long-random-token>
GLASS_AGENT_UPSTREAM_URL=http://<agent-host>:8642/v1/chat/completions
GLASS_AGENT_UPSTREAM_KEY=<API_SERVER_KEY of the agent>
EOF
chmod 600 ~/glass-agent/.env
cp glass-agent.service ~/.config/systemd/user/ && systemctl --user enable --now glass-agent
tailscale serve --bg --https=8657 http://127.0.0.1:8657
```

In the Even app: **URL** `https://<your-machine>.<your-tailnet>.ts.net:8657/v1/chat/completions` (complete, because
the app appends nothing), **Key** = `GLASS_AGENT_TOKEN`. The phone must be in the tailnet.

Further settings (character budget, history duration, extra system text, model name) are at the top of
`glass_agent.py`.

## Routing by kind of question

Since Even app 2.4.0 the app gives up after about 9 s, so not every question should go through the full agent.
The service sorts each question with fixed rules (no extra model call) and picks the way:

| Kind | Examples | Way |
|---|---|---|
| `jetzt` | "Wie spät ist es?", "Welcher Tag ist heute?" | answered by the service itself (time zone `GLASS_AGENT_TZ`, default Europe/Vienna) |
| `wissen` | "Wer bin ich?", general knowledge, explaining, translating | `GLASS_AGENT_FAST_URL` directly (no agent, no tools), with a short profile from `GLASS_AGENT_PROFILE_FILE`; if it fails, the normal ways |
| `server` | "Läuft ns1?", "Laufen alle Server?", "Wie ist die Auslastung vom Pi?" | the status servers of `GLASS_AGENT_STATUS_SOURCES` (`reference-server.mjs`, `GET /status`) directly: values, warnings, unreachable hosts (about 1 s) |
| `nachschauen` | appointments, dashboard, weather, servers, messages - and everything no rule matches | the agent as before |
| `tun` | "Schreib …", "Erinner mich …", "Mach … aus" | the agent with `GLASS_AGENT_TASK_MODEL`, approval at least `GLASS_AGENT_TASK_APPROVAL` (default `mixed`) |

```bash
GLASS_AGENT_FAST_URL=https://<openai-compatible-endpoint>/v1/chat/completions
GLASS_AGENT_FAST_KEY=<key of that endpoint>
GLASS_AGENT_FAST_MODEL=<fast model without reasoning>
GLASS_AGENT_TASK_MODEL=<stronger model for actions>
GLASS_AGENT_PROFILE_FILE=~/.hermes/memories/USER.md
GLASS_AGENT_STATUS_SOURCES="Pi5,pi,raspberry|https://<pi>:8451/status;ns1,mail|https://<ns1>:8451/status"
```

Without `GLASS_AGENT_FAST_URL` and `GLASS_AGENT_TASK_MODEL` only `jetzt` changes anything; `GLASS_AGENT_ROUTING=0`
turns routing off. The log shows the kind next to the way, for example `via schnell:… (wissen)`.

## Slow answers

The Even app waits only ~30 s. The service waits `GLASS_AGENT_BUDGET` seconds (default 24) for the
agent. If it takes longer (for example because it uses tools), it keeps working in the background, and the
glasses show "Ich bin noch dran – frag gleich mit „und?“ nach." ("I'm still on it; ask again in a moment with
"und?" ("and?")."). The result is remembered
(`GLASS_AGENT_STATE`, 10 minutes) and delivered with your next utterance:

| Next utterance | Glasses show |
|---|---|
| "und?", "Ergebnis?", "fertig?", "weiter" ("and?", "result?", "done?", "continue") | only the result (if it is not there yet, it waits again up to the budget) |
| any other question | "Vorhin: ‹short result› Jetzt: ‹answer to the new question›" ("Earlier: ... Now: ...") |

The finished question/answer goes into the history. There is only one open job. If the new question also goes
to the background, the older, not yet finished result is dropped. A hanging route counts as failed only
after `GLASS_AGENT_TIMEOUT` (default 120 s). Direct routes (for example your own vLLM) are told
that they have no tools and no live data, and are supposed to say so honestly.

## Approval levels (`GLASS_AGENT_APPROVAL`)

| Level | Route to Hermes | Behavior |
|---|---|---|
| `auto` (default) | `/v1/chat/completions` | As before, no question on the glasses |
| `mixed` | `/v1/runs` | The service itself approves actions that are recognizably **read-only**, and asks about everything else |
| `ask` | `/v1/runs` | Every Hermes approval is asked on the glasses |

Switch by voice (it is saved): "Freigabe auf auto", "Freigabe gemischt",
"Freigabe immer fragen" ("approval to auto", "approval mixed", "always ask for approval").

Flow with `mixed`/`ask`: the service starts a run (`POST /v1/runs`) and polls the status
(`GET /v1/runs/{id}`). When Hermes stops (`waiting_for_approval`), the glasses show, for example,
"Hermes will an Maria schreiben: 'Komme 10 min später.' Sag ja oder nein." ("Hermes wants to write to Maria: 'I'll be
10 min late.' Say yes or no."). The open question is valid for
`GLASS_AGENT_APPROVAL_TTL` seconds (default 90) and survives a restart.

- "ja", "ok", "mach", "bestätigt", "yes" ("yes", "ok", "do it", "confirmed", "yes") → `POST /v1/runs/{id}/approval {"choice":"once"}`, then it waits for
  the result (otherwise "noch dran" (still on it) as above).
- "nein", "stopp", "abbrechen", "no" ("no", "stop", "cancel", "no") → `choice: "deny"` and `POST /v1/runs/{id}/stop`.
- Any other utterance is a new question. The open approval is denied and the run is stopped
  (silence is not consent). This also applies after the 90 s have passed.

If the agent does not know `/v1/runs` (404), the request goes through chat completions without a question.
Direct fallback routes (vLLM) have no tools and therefore no approvals.

**Important:** Hermes only stops if `approvals.mode` is not `off` in Hermes (`manual` or
`smart`). Hermes does not ask before every tool. It asks for dangerous shell commands,
`execute_code` and tools for which a plugin sets an approval rule (for example sending
messages). `ask` cannot ask for more than Hermes asks.

**Classification with `mixed`** (conservative, anything unknown is asked), from the fields of the
approval event (`command`, `description`, `pattern_key`, `smart_denied`):

- Always ask: `smart_denied`; a description with risk words (delete, write, send, kill,
  install, sudo, secret, token ...); code execution (`execute_code`/scripts); unknown tools.
- Approved automatically (`once`): plugin tools from a fixed read list (`read_file`, `search_files`,
  `web_search`, `web_extract`, `session_search`, `vision_analyze`, `browser_snapshot`, `skills_list`,
  `skill_view`); shell commands where every part (separated at `|`, `&&`, `;`) starts with a pure
  read command (`ls`, `cat`, `grep`, `df`, `ps`, `find`, `git status/log/diff/show` ...) and which
  contain no redirect `>`, no command substitution, no `sudo`/`tee`/`xargs`, and no `-delete`/`-exec`/`-o`.

Tool restriction per request: Hermes' API has no field for it (the tools come from the
Hermes configuration for the platform `api_server`), so there is no setting for it here.
