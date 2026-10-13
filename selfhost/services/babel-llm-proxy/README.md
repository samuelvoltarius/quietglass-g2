# babel-llm-proxy — Übersetzung für Babel Glass

Babel Glass übersetzt über ein **OpenAI-kompatibles LLM** (`/v1/chat/completions`). Dieser kleine Proxy
(nur Python-Standardbibliothek, kein `pip install`) sitzt davor und erledigt, was die Brillen-App braucht:

- CORS (Preflight 204 ohne Body),
- keine Streaming-Antworten (die Brille braucht den ganzen Satz),
- schaltet das „Denken“ von Qwen-Modellen aus (`enable_thinking: false`) – sonst dauert die Übersetzung Sekunden,
- optional Anmeldung (Token oder Tailscale-Login).

| lokal | Tailscale-Port (Vorschlag) | App-Feld |
|---|---|---|
| `127.0.0.1:8121` | `8448` | „Übersetzer“ = `https://<server>.<tailnet>.ts.net:8448/v1` |

Das **Modell** trägst du in der App (bzw. `VITE_BABEL_MODEL` im privaten Build) so ein, wie dein LLM-Server es
nennt (z. B. `qwen`, siehe `curl http://127.0.0.1:8000/v1/models`).

## Voraussetzung: ein LLM-Server

vLLM (`vllm serve <modell> --port 8000`), Ollama (`UPSTREAM=http://127.0.0.1:11434`) oder llama.cpp-Server.
Gut geeignet sind mehrsprachige Modelle (Qwen-Familie); für Weißrussisch/Russisch → Deutsch ein größeres Modell
wählen. (Ollama ignoriert `chat_template_kwargs` – ungeprüft, ob das dort Nebenwirkungen hat.)

## Installieren

```bash
mkdir -p ~/.config/quietglass ~/.config/systemd/user
cp .env.example ~/.config/quietglass/babel-llm-proxy.env && chmod 600 ~/.config/quietglass/babel-llm-proxy.env
$EDITOR ~/.config/quietglass/babel-llm-proxy.env        # UPSTREAM, optional TOKEN / TAILSCALE_USERS
cp babel-llm-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now babel-llm-proxy
loginctl enable-linger "$USER"
systemctl --user is-active babel-llm-proxy
curl -s http://127.0.0.1:8121/v1/models | head -c 200   # zeigt die Modelle des LLM-Servers
```

Unit-Pfade gehen davon aus, dass das Repo unter `~/quietglass-g2` liegt – sonst `ExecStart` anpassen.

## Per Tailscale freigeben (nie `serve reset`)

```bash
tailscale serve --bg --https=8448 http://127.0.0.1:8121
tailscale serve status
```

## English

A tiny stdlib-only Python proxy in front of any OpenAI-compatible LLM server (vLLM, Ollama, llama.cpp): adds
CORS (204 preflight, no body), forces non-streaming, disables Qwen "thinking", and optionally checks a Bearer
token or a Tailscale login. Set `UPSTREAM` in the env file, install the user unit, publish `127.0.0.1:8121`
with `tailscale serve --bg --https=8448 http://127.0.0.1:8121`, and enter `https://<server>.<tailnet>.ts.net:8448/v1`
plus your model name in Babel Glass.
