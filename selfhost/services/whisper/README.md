# whisper — speech recognition (speech to text)

**For:** NextStop (destination by voice), Shoot Day (voice commands), Quiet Hub (voice messages),
Babel Glass (live subtitles), FieldLog (dictation). **Needs:** a Linux computer with an NVIDIA GPU (CUDA), ~6 GB VRAM.

One process, one model (`whisper-large-v3-turbo`, fp16):

| Interface | Local | Tailscale port (suggestion) | Used by |
|---|---|---|---|
| HTTP `POST /v1/audio/transcriptions` (OpenAI style), `GET /health` | `127.0.0.1:8017` | `8457` | NextStop, Shoot Day, Quiet Hub, FieldLog |
| WebSocket (Babel protocol) | `127.0.0.1:8120` | `8449` | Babel Glass |

## Install

```bash
sudo apt install ffmpeg python3-venv
python3 -m venv ~/whisper-venv
# install torch matching your CUDA version from https://pytorch.org/get-started/, then:
~/whisper-venv/bin/pip install -r requirements.txt

# config
mkdir -p ~/.config/quietglass ~/.config/systemd/user/whisper-unified.service.d
cp .env.example ~/.config/quietglass/whisper.env && chmod 600 ~/.config/quietglass/whisper.env
cp whisper-unified.service ~/.config/systemd/user/
cp restart.conf ~/.config/systemd/user/whisper-unified.service.d/   # keep the ExecStartPre line only on GB10/Jetson

# the first start downloads the model (~1.6 GB): needs the internet once
HF_HUB_OFFLINE=0 ~/whisper-venv/bin/python server.py      # wait for "whisper-unified ready", then Ctrl+C

systemctl --user daemon-reload
systemctl --user enable --now whisper-unified
loginctl enable-linger "$USER"                            # also runs without a login
curl -s http://127.0.0.1:8017/health                      # {"status":"ok",...}
```

## Publish with Tailscale (never `serve reset`)

```bash
tailscale serve --bg --https=8457 http://127.0.0.1:8017   # HTTP
tailscale serve --bg --https=8449 http://127.0.0.1:8120   # Babel WebSocket (wss://)
tailscale serve status                                     # read it back
```

In the apps: `https://<your-machine>.<your-tailnet>.ts.net:8457/v1/audio/transcriptions` or `wss://<your-machine>.<your-tailnet>.ts.net:8449`.

## Notes

- The **HTTP interface has no sign-in of its own**: it is reachable only inside the tailnet (Tailscale ACLs can
  restrict devices). The **WebSocket** side checks `TOKEN` or `TAILSCALE_USERS` (Tailscale login)
  when one of them is set.
- CORS is built in (preflight 204 with no body, the origin is mirrored). The glasses need nothing more.
- Shorter/older variant for Babel Glass alone: `apps/babel-glass/examples/whisper-server.py` (faster-whisper, also CPU).
  Use it if you have no NVIDIA GPU.
- `WHISPER_PROMPT="Name1, Name2"` improves German proper names.
- **Streaming for Babel Glass ≥ 0.3.0** (`babel_stream.py`, next to `server.py`): if the client sends
  `"stream": true` in the start frame, the running piece is recognized again about every 0.8 s → provisional lines
  (`partial` with a stable prefix) and fixed lines (`final`) after a pause of 0.7 s, or after 12 s at the latest.
  Old clients without the field keep getting the 3 s windows. Adjustable: `STREAM_STEP`, `STREAM_SILENCE`,
  `STREAM_MAX`.
- **Speaker letters** (`"speaker":"A"`, `"B"` ...) in streaming: for each fixed line, one ECAPA speaker embedding
  (`speechbrain/spkrec-ecapa-voxceleb`, 192 values, as ONNX on the **CPU**, so GPU memory stays free,
  ~15–110 ms per line, at most 6 s of audio are analyzed). Online clustering by cosine similarity with a
  running mean per speaker, up to 6 speakers. The threshold starts at `SPK_COS` (0.60) and, after a few lines,
  adapts to the room (median of the same-speaker values minus `SPK_MARGIN` 0.20, limited to
  `SPK_COS_MIN` 0.42 … `SPK_COS_MAX` 0.65; `SPK_ADAPT=0` = fixed threshold). Lines with less than `SPK_MIN_SEC`
  (1 s) of voice never create a new speaker. They go to the most similar one or stay with the previous one. If two
  speaker means become very similar, they are merged (the oldest letter stays).
  If the model is missing, the old coarse detection takes over automatically (pitch + timbre, `librosa`,
  `SPK_THRESH`). `SPK_MODEL=light` forces the old one, `SPEAKERS=0` turns letters off.

### Set up the speaker model (one time, ~80 MB download, ~160 MB on disk)

```bash
# in any Python with torch (it does NOT have to be the service's Python):
pip install torch speechbrain huggingface_hub onnx onnxruntime
python export_ecapa_onnx.py models/spkrec-ecapa-voxceleb   # downloads the model, writes models/.../ecapa.onnx
systemctl --user restart whisper-unified
journalctl --user -u whisper-unified | grep ECAPA          # "ECAPA speaker model loaded (onnx, cpu ...)"
```

The service itself needs only `onnxruntime` + numpy (no torchaudio, which avoids version conflicts with the
torch that Whisper uses on the GPU). Different location: `SPK_ECAPA_DIR=/path/to/folder`. License of the model:
Apache-2.0 (see the README in the model folder).

Measured with Piper voices (Thorsten, Kerstin) in streaming over the WebSocket: man/woman, man/deeper man
(−2 semitones) and three people were separated without errors. Thorsten "emotional" (the same person) correctly stayed
"A". Limit: a copy of the same voice shifted by only +1…+2 semitones, in a clean recording, ends up
in the same letter. Real rooms/microphones differ. Adjust `SPK_COS`/`SPK_MARGIN` if needed.
