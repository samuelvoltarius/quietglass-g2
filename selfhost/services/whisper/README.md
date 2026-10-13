# whisper — Spracherkennung / speech to text

**Für:** NextStop (Ziel per Sprache), Shoot Day (Sprachbefehle), Quiet Hub (Sprachnachrichten),
Babel Glass (Live-Untertitel), FieldLog (Diktat). **Braucht:** Linux-Rechner mit NVIDIA-GPU (CUDA), ~6 GB VRAM.

Ein Prozess, ein Modell (`whisper-large-v3-turbo`, fp16):

| Schnittstelle | lokal | Tailscale-Port (Vorschlag) | Genutzt von |
|---|---|---|---|
| HTTP `POST /v1/audio/transcriptions` (OpenAI-Stil), `GET /health` | `127.0.0.1:8017` | `8457` | NextStop, Shoot Day, Quiet Hub, FieldLog |
| WebSocket (Babel-Protokoll) | `127.0.0.1:8120` | `8449` | Babel Glass |

## Installieren

```bash
sudo apt install ffmpeg python3-venv
python3 -m venv ~/whisper-venv
# torch passend zu deiner CUDA-Version von https://pytorch.org/get-started/ installieren, dann:
~/whisper-venv/bin/pip install -r requirements.txt

# Konfig
mkdir -p ~/.config/quietglass ~/.config/systemd/user/whisper-unified.service.d
cp .env.example ~/.config/quietglass/whisper.env && chmod 600 ~/.config/quietglass/whisper.env
cp whisper-unified.service ~/.config/systemd/user/
cp restart.conf ~/.config/systemd/user/whisper-unified.service.d/   # ExecStartPre-Zeile nur auf GB10/Jetson behalten

# Erster Start lädt das Modell (~1,6 GB): einmal mit Internet
HF_HUB_OFFLINE=0 ~/whisper-venv/bin/python server.py      # warten bis "whisper-unified ready", dann Strg+C

systemctl --user daemon-reload
systemctl --user enable --now whisper-unified
loginctl enable-linger "$USER"                            # läuft auch ohne Login
curl -s http://127.0.0.1:8017/health                      # {"status":"ok",...}
```

## Per Tailscale freigeben (nie `serve reset`)

```bash
tailscale serve --bg --https=8457 http://127.0.0.1:8017   # HTTP
tailscale serve --bg --https=8449 http://127.0.0.1:8120   # Babel-WebSocket (wss://)
tailscale serve status                                     # zurücklesen
```

In den Apps: `https://<server>.<tailnet>.ts.net:8457/v1/audio/transcriptions` bzw. `wss://<server>.<tailnet>.ts.net:8449`.

## Hinweise

- Die **HTTP-Schnittstelle hat keine eigene Anmeldung**: Sie ist nur im Tailnet erreichbar (Tailscale-ACLs
  können Geräte einschränken). Die **WebSocket**-Seite prüft `TOKEN` bzw. `TAILSCALE_USERS` (Tailscale-Login),
  wenn eines gesetzt ist.
- CORS ist eingebaut (Preflight 204 ohne Body, Origin wird gespiegelt) – die Brille braucht nichts weiter.
- Kürzere/ältere Variante für Babel Glass allein: `apps/babel-glass/examples/whisper-server.py` (faster-whisper, auch CPU).
- `WHISPER_PROMPT="Name1, Name2"` verbessert deutsche Eigennamen.
- **Streaming für Babel Glass ≥ 0.3.0** (`babel_stream.py`, liegt neben `server.py`): schickt der Client
  `"stream": true` im Start-Frame, wird alle ~0,8 s das laufende Stück neu erkannt → vorläufige Zeilen
  (`partial` mit stabilem Präfix) und feste Zeilen (`final`) nach einer Pause von 0,7 s bzw. spätestens nach 12 s.
  Alte Clients ohne das Feld bekommen weiter die 3-s-Fenster. Einstellbar: `STREAM_STEP`, `STREAM_SILENCE`,
  `STREAM_MAX`.
- **Sprecher-Buchstaben** (`"speaker":"A"`) im Streaming: grobe Erkennung über Tonhöhe + Klangfarbe (MFCC) auf
  der CPU, braucht `librosa`. Deutlich verschiedene Stimmen klappen, ähnliche können denselben Buchstaben
  bekommen. `SPEAKERS=0` schaltet ab, `SPK_THRESH` (Standard 5.0) stellt die Empfindlichkeit ein.

## English

One process serving both an OpenAI-style HTTP endpoint (port 8017) and the Babel Glass WebSocket (port
8120) from a single `whisper-large-v3-turbo` on an NVIDIA GPU. Install ffmpeg + a venv, `pip install -r
requirements.txt` (torch matching your CUDA), copy `.env.example`, the unit and `restart.conf` as shown above,
download the model once with `HF_HUB_OFFLINE=0`, then publish both loopback ports with `tailscale serve`
(never `serve reset`). The HTTP side has no login of its own (tailnet only); the WebSocket checks `TOKEN` /
`TAILSCALE_USERS` when set. Without an NVIDIA GPU use `apps/babel-glass/examples/whisper-server.py`
(faster-whisper) instead. Streaming for Babel Glass ≥ 0.3.0 lives in `babel_stream.py` (opt-in per start frame
`"stream": true`; partial + final lines, rough CPU speaker labels via `librosa`, `SPEAKERS=0` to disable).
