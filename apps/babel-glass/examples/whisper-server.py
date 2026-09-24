#!/usr/bin/env python3
"""
Babel Glass speech server — reference implementation.

Speaks the Babel Glass wire format on top of faster-whisper. Deliberately
short: the whole point of the protocol is that self-hosting should be an
afternoon, not a project.

    pip install faster-whisper websockets
    python whisper-server.py                    # ws://0.0.0.0:9000
    MODEL=small DEVICE=cuda python whisper-server.py

Wire format
-----------
Client sends one JSON frame:   {"type":"start","language":"auto",
                                "sampleRate":16000,"encoding":"s16le"}
then binary frames of raw 16 kHz signed 16-bit mono PCM.

Server replies with JSON:      {"text":"...","final":true|false,"language":"en"}

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
print(f"Babel Glass speech server on ws://{HOST}:{PORT}")
if not TOKEN:
    print("No TOKEN set: this server is unauthenticated.")


async def handle(websocket):
    language = None
    buffer = bytearray()
    window_bytes = int(WINDOW_SECONDS * SAMPLE_RATE * 2)

    try:
        async for message in websocket:
            if isinstance(message, str):
                frame = json.loads(message)
                if frame.get("type") == "start":
                    if TOKEN and frame.get("token") != TOKEN:
                        await websocket.close(code=1008, reason="unauthorized")
                        return
                    requested = frame.get("language", "auto")
                    language = None if requested in ("auto", "", None) else requested
                continue

            buffer.extend(message)
            if len(buffer) < window_bytes:
                continue

            chunk = bytes(buffer)
            buffer.clear()

            # s16le -> float32 in [-1, 1], which is what the model expects.
            audio = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0

            segments, info = await asyncio.to_thread(
                lambda: model.transcribe(audio, language=language, vad_filter=True)
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
            if not text:
                continue

            await websocket.send(json.dumps({
                "text": text,
                "final": True,
                "language": getattr(info, "language", None) or language or "auto",
            }))
    except websockets.ConnectionClosed:
        pass


async def main():
    async with websockets.serve(handle, HOST, PORT, max_size=None):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
