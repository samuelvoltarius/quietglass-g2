#!/usr/bin/env python3
"""
Babel Glass speech server — reference implementation.

Speaks the Babel Glass wire format on top of faster-whisper. Deliberately
short: the whole point of the protocol is that self-hosting should be an
afternoon, not a project.

    pip install faster-whisper websockets
    python whisper-server.py                    # ws://0.0.0.0:9000
    MODEL=small DEVICE=cuda python whisper-server.py

Russian / Belarusian: use a large multilingual model and set the language in
the app ("be" or "ru") rather than "auto" — auto-detection often reports
Belarusian speech as Russian.

    MODEL=large-v3 DEVICE=cuda COMPUTE=float16 python whisper-server.py

(`distil-*` models are English-only; do not use them for Russian/Belarusian.)

Wire format
-----------
Client sends one JSON frame:   {"type":"start","language":"auto",
                                "sampleRate":16000,"encoding":"s16le"}
then binary frames of raw 16 kHz signed 16-bit mono PCM.

Server replies with JSON:      {"text":"...","final":true|false,"language":"en"}

`language` in the reply is the language the text was transcribed as: the
requested one when it was fixed, otherwise Whisper's detection.

Partial results (final=false) may be revised; Babel Glass replaces the pending
line rather than appending, so sending them freely is safe.
"""
import asyncio
import json
import os
import numpy as np
import websockets
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("MODEL", "base")
DEVICE = os.environ.get("DEVICE", "cpu")
COMPUTE = os.environ.get("COMPUTE", "int8")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "9000"))
TOKEN = os.environ.get("TOKEN", "")

# Transcribe once this much audio has arrived. Shorter is more responsive and
# less accurate; 2 s is a reasonable compromise for conversation.
WINDOW_SECONDS = float(os.environ.get("WINDOW", "2.0"))
SAMPLE_RATE = 16000

print(f"loading {MODEL_NAME} on {DEVICE} ({COMPUTE})…")
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
SUPPORTED = set(getattr(model, "supported_languages", None) or [])
print(f"Babel Glass speech server on ws://{HOST}:{PORT}")
if not TOKEN:
    print("No TOKEN set: this server is unauthenticated.")


def whisper_language(requested):
    """Maps the app's language to a Whisper code, or None for auto-detect.

    The app sends BCP-47 ("be", "de-AT"); Whisper wants the bare ISO 639-1
    code. An unknown code would make transcribe() raise and drop the
    connection, so it falls back to auto-detection with a warning instead.
    """
    if not isinstance(requested, str) or requested.strip().lower() in ("", "auto"):
        return None
    code = requested.strip().lower().replace("_", "-").split("-")[0]
    if SUPPORTED and code not in SUPPORTED:
        print(f"language {requested!r} is not supported by {MODEL_NAME}; auto-detecting")
        return None
    return code


async def handle(websocket):
    language = None
    buffer = bytearray()
    window_bytes = int(WINDOW_SECONDS * SAMPLE_RATE * 2)

    try:
        async for message in websocket:
            if isinstance(message, str):
                try:
                    frame = json.loads(message)
                except ValueError:
                    continue
                if isinstance(frame, dict) and frame.get("type") == "start":
                    if TOKEN and frame.get("token") != TOKEN:
                        await websocket.close(code=1008, reason="unauthorized")
                        return
                    language = whisper_language(frame.get("language", "auto"))
                    print(f"client started, language={language or 'auto'}")
                continue

            buffer.extend(message)
            if len(buffer) < window_bytes:
                continue

            chunk = bytes(buffer)
            buffer.clear()

            # s16le -> float32 in [-1, 1], which is what the model expects.
            audio = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0

            def run(audio=audio, language=language):
                segments, info = model.transcribe(audio, language=language, vad_filter=True)
                # segments is a lazy generator: consume it here, in the worker
                # thread, not on the event loop.
                return " ".join(s.text.strip() for s in segments).strip(), info

            text, info = await asyncio.to_thread(run)
            if not text:
                continue

            await websocket.send(json.dumps({
                "text": text,
                "final": True,
                "language": language or getattr(info, "language", None) or "auto",
            }, ensure_ascii=False))
    except websockets.ConnectionClosed:
        pass


async def main():
    async with websockets.serve(handle, HOST, PORT, max_size=None):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
