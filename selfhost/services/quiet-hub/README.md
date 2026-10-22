# quiet-hub — daemon + relay for Quiet Hub

One **daemon** (the glasses talk only to it; all tokens stay there) and, on each machine with agents, one **relay**
that connects **outbound** to the daemon. **The code is in the repo and is not copied:**
[`apps/quiet-hub/examples/`](../../../apps/quiet-hub/examples) (`quiet-hub-daemon.mjs`, `quiet-hub-relay.mjs`,
`relay.example.json`; Node ≥ 18). All daemon options: [`apps/quiet-hub/.env-hub.example`](../../../apps/quiet-hub/.env-hub.example),
details: [`apps/quiet-hub/README.md`](../../../apps/quiet-hub/README.md).

| Part | Local | Tailscale port (suggestion) | App field / build |
|---|---|---|---|
| Daemon | `127.0.0.1:8787` | `8443` | "Hub address" (Hub-Adresse) = `https://<your-machine>.<your-tailnet>.ts.net:8443` |
| Relay | – (connects outward) | – | `QUIET_HUB_URL` in `quiet-hub-relay.env` |

Optionally, the daemon needs: [whisper](../whisper) (speech), an OpenAI-compatible LLM server (reply suggestions),
Home Assistant, Moonraker. On request, the daemon starts a local Hermes (`hermes chat`). Without Hermes, set
`LOCAL_AGENT=off` in the env file and use only relays.

## Install the daemon

```bash
git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2     # if not there yet
mkdir -p ~/.config/quietglass ~/.config/systemd/user
cp daemon.env.example ~/.config/quietglass/quiet-hub-daemon.env && chmod 600 ~/.config/quietglass/quiet-hub-daemon.env
$EDITOR ~/.config/quietglass/quiet-hub-daemon.env     # HUB_TAILSCALE_USERS = your login, HUB_TOKEN for relays
cp quiet-hub-daemon.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now quiet-hub-daemon
loginctl enable-linger "$USER"
systemctl --user is-active quiet-hub-daemon
tailscale serve --bg --https=8443 http://127.0.0.1:8787      # never "serve reset"
tailscale serve status
```

## Install the relay (on every machine with agents, also on the daemon machine itself)

```bash
mkdir -p ~/.config/quietglass ~/.config/quiet-hub ~/.config/systemd/user
cp ~/quietglass-g2/apps/quiet-hub/examples/relay.example.json ~/.config/quiet-hub/relay.json   # enter agents
cp relay.env.example ~/.config/quietglass/quiet-hub-relay.env && chmod 600 ~/.config/quietglass/quiet-hub-relay.env
$EDITOR ~/.config/quietglass/quiet-hub-relay.env     # QUIET_HUB_URL, HUB_TOKEN (= the daemon's token)
cp quiet-hub-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now quiet-hub-relay
```

The glasses sign in with your Tailscale login (no token to type). The token is for relays and works as an
alternative. On Windows/macOS, the same Node code runs without systemd (Task Scheduler / launchd).
