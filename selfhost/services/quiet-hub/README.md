# quiet-hub — Daemon + Relay für Quiet Hub

Ein **Daemon** (die Brille spricht nur mit ihm; alle Tokens bleiben dort) und je Rechner mit Agenten ein **Relay**,
das **ausgehend** zum Daemon verbindet. **Der Code liegt im Repo und wird nicht kopiert:**
[`apps/quiet-hub/examples/`](../../../apps/quiet-hub/examples) (`quiet-hub-daemon.mjs`, `quiet-hub-relay.mjs`,
`relay.example.json`; Node ≥ 18). Alle Daemon-Optionen: [`apps/quiet-hub/.env-hub.example`](../../../apps/quiet-hub/.env-hub.example),
Details: [`apps/quiet-hub/README.md`](../../../apps/quiet-hub/README.md).

| Teil | lokal | Tailscale-Port (Vorschlag) | App-Feld / Build |
|---|---|---|---|
| Daemon | `127.0.0.1:8787` | `8443` | „Hub-Adresse“ = `https://<server>.<tailnet>.ts.net:8443` |
| Relay | – (verbindet nach außen) | – | `QUIET_HUB_URL` in `quiet-hub-relay.env` |

Optional braucht der Daemon: [whisper](../whisper) (Sprache), einen OpenAI-kompatiblen LLM-Server (Antwortvorschläge),
Home Assistant, Moonraker. Der Daemon startet auf Wunsch ein lokales Hermes (`hermes chat`); ohne Hermes setze
`LOCAL_AGENT=off` in der Env-Datei und nutze nur Relays.

## Daemon installieren

```bash
git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2     # falls noch nicht da
mkdir -p ~/.config/quietglass ~/.config/systemd/user
cp daemon.env.example ~/.config/quietglass/quiet-hub-daemon.env && chmod 600 ~/.config/quietglass/quiet-hub-daemon.env
$EDITOR ~/.config/quietglass/quiet-hub-daemon.env     # HUB_TAILSCALE_USERS = dein Login, HUB_TOKEN für Relays
cp quiet-hub-daemon.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now quiet-hub-daemon
loginctl enable-linger "$USER"
systemctl --user is-active quiet-hub-daemon
tailscale serve --bg --https=8443 http://127.0.0.1:8787      # nie "serve reset"
tailscale serve status
```

## Relay installieren (auf jedem Rechner mit Agenten, auch auf dem Daemon-Rechner selbst)

```bash
mkdir -p ~/.config/quietglass ~/.config/quiet-hub ~/.config/systemd/user
cp ~/quietglass-g2/apps/quiet-hub/examples/relay.example.json ~/.config/quiet-hub/relay.json   # Agenten eintragen
cp relay.env.example ~/.config/quietglass/quiet-hub-relay.env && chmod 600 ~/.config/quietglass/quiet-hub-relay.env
$EDITOR ~/.config/quietglass/quiet-hub-relay.env     # QUIET_HUB_URL, HUB_TOKEN (= Token des Daemons)
cp quiet-hub-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now quiet-hub-relay
```

Die Brille meldet sich mit deinem Tailscale-Login an (kein Token tippen); der Token gilt für Relays und als
Alternative. Unter Windows/macOS läuft derselbe Node-Code ohne systemd (Aufgabenplanung / launchd).

## English

Daemon (the only thing the glasses talk to) plus one outbound relay per machine with agents. Code stays in
`apps/quiet-hub/examples/`. Install the daemon unit with `daemon.env.example` (your login in `HUB_TAILSCALE_USERS`,
`HUB_TOKEN` for relays), publish `127.0.0.1:8787` via `tailscale serve --bg --https=8443 http://127.0.0.1:8787`;
on each agent machine install the relay unit with `relay.env.example` and `relay.json`.
