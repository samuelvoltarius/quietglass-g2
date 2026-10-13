# shoot-day — Backend für Shoot Day

Speichert Projekte (Shotlist, Takes, Skript/Teleprompter, Tagesplan, Packliste), liefert ein **Web-Terminal** zum
Bearbeiten am Rechner und schickt Sprachbefehle an Whisper. **Der Code liegt im Repo und wird nicht kopiert:**
[`apps/shoot-day/examples/shoot-day-server.mjs`](../../../apps/shoot-day/examples/shoot-day-server.mjs)
(Node ≥ 18, keine Abhängigkeiten) samt `shoot-day-terminal.html`. Optional ein MCP-Server für Agenten:
[`dreh_mcp.py`](../../../apps/shoot-day/examples/dreh_mcp.py).

| lokal | Tailscale-Port (Vorschlag) | App-Feld / Build |
|---|---|---|
| `127.0.0.1:8896` | `8445` | „Serveradresse“ = `https://<server>.<tailnet>.ts.net:8445` |

Das Web-Terminal erreichst du im Browser unter derselben Adresse (im Tailnet). Sprachbefehle brauchen den
[whisper](../whisper)-Dienst (`WHISPER_URL`), sonst ist Sprache aus.

## Installieren

```bash
git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2     # falls noch nicht da
mkdir -p ~/.config/quietglass ~/.local/state/quietglass/shoot-day ~/.config/systemd/user
cp .env.example ~/.config/quietglass/shoot-day.env && chmod 600 ~/.config/quietglass/shoot-day.env
$EDITOR ~/.config/quietglass/shoot-day.env    # DATA_FILE mit vollem Pfad, SD_TAILSCALE_USERS = dein Login
cp shoot-day.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now shoot-day
loginctl enable-linger "$USER"
systemctl --user is-active shoot-day
tailscale serve --bg --https=8445 http://127.0.0.1:8896      # nie "serve reset"
tailscale serve status
```

## English

Backend for the Shoot Day app (projects, takes, schedule, packing list, web terminal, voice via Whisper). Code stays
in `apps/shoot-day/examples/`. Env file with a full `DATA_FILE` path and your Tailscale login in
`SD_TAILSCALE_USERS`; install the user unit; publish `127.0.0.1:8896` with
`tailscale serve --bg --https=8445 http://127.0.0.1:8896`.
