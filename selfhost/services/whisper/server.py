#!/usr/bin/env python3
"""whisper-unified: one process, one model (whisper-large-v3-turbo, fp16, NVIDIA GPU).
 - HTTP  127.0.0.1:8017  OpenAI-style POST /v1/audio/transcriptions + GET /health
 - WS    127.0.0.1:8120  Babel Glass protocol
All GPU calls go through ONE threading.Lock. Both ports are meant to be published
only through `tailscale serve` (see README.md next to this file)."""
import os, re, json, asyncio, tempfile, threading
os.environ.setdefault("PYTHONWARNINGS", "ignore")
import numpy as np, torch, websockets, uvicorn
import babel_stream  # streaming mode (partial/final lines, speaker labels)
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse, PlainTextResponse
from transformers import WhisperForConditionalGeneration, WhisperProcessor, pipeline

MID = os.environ.get("MODEL", "openai/whisper-large-v3-turbo")
HTTP_HOST = os.environ.get("HTTP_HOST", "127.0.0.1"); HTTP_PORT = int(os.environ.get("WHISPER_GPU_PORT", "8017"))
WS_HOST = os.environ.get("WS_HOST", "127.0.0.1"); WS_PORT = int(os.environ.get("WS_PORT", "8120"))
TOKEN = os.environ.get("TOKEN", ""); WINDOW = float(os.environ.get("WINDOW", "3.0"))
MIN_RMS = float(os.environ.get("MIN_RMS", "0.006"))
MIN_BYTES = int(os.environ.get("WHISPER_MIN_BYTES", "12000"))
SR = 16000
# Tailscale login auth: `tailscale serve` connects from loopback and sets Tailscale-User-Login.
# TOKEN empty = the Babel WebSocket needs no login (tailnet only); set TOKEN and/or TAILSCALE_USERS to require one.
TS_USERS = [u.strip().lower() for u in os.environ.get("TAILSCALE_USERS", "").split(",") if u.strip()]

def ts_user_ok(ws):
    try:
        peer = str((ws.remote_address or ("",))[0]).replace("::ffff:", "")
        if peer not in ("127.0.0.1", "::1"): return False
        return (ws.request.headers.get("Tailscale-User-Login") or "").strip().lower() in TS_USERS
    except Exception:
        return False
# Optional vocabulary hint (names, jargon) that makes German transcription better, e.g.
# WHISPER_PROMPT="Quietglass, Tailscale, Valhalla, Hermes". Empty = no hint.
PROMPT = os.environ.get("WHISPER_PROMPT", "").strip()
BAD = ("продолжение следует", "субтитры", "редактор субтитров", "корректор", "thanks for watching", "untertitel", "dimatorzok", "падпісвайцеся")

GPU_LOCK = threading.Lock()
proc = WhisperProcessor.from_pretrained(MID)
model = WhisperForConditionalGeneration.from_pretrained(MID, torch_dtype=torch.float16, low_cpu_mem_usage=True).to("cuda").eval()
pipe = pipeline("automatic-speech-recognition", model=model, tokenizer=proc.tokenizer,
                feature_extractor=proc.feature_extractor, torch_dtype=torch.float16, device="cuda")
try:
    PROMPT_IDS = proc.get_prompt_ids(PROMPT, return_tensors="pt").to("cuda") if PROMPT else None
except Exception as e:
    print("[whisper-unified] prompt_ids off: %s" % e, flush=True); PROMPT_IDS = None

# ---------------- HTTP (whisper-gpu-kompatibel) ----------------
def _http_lang(v):
    v = (v or "").strip().lower()
    if v in ("auto",): return None
    return v or "de"

def _gen(audio, lang, use_prompt):
    feats = proc(audio, sampling_rate=SR, return_tensors="pt").input_features.to("cuda", torch.float16)
    kw = dict(task="transcribe", max_new_tokens=300)
    if lang: kw["language"] = lang
    if use_prompt and PROMPT_IDS is not None and lang == "de": kw["prompt_ids"] = PROMPT_IDS
    with GPU_LOCK, torch.inference_mode():
        out = model.generate(feats, **kw)
    return proc.tokenizer.batch_decode(out, skip_special_tokens=True)[0].strip()

def _http_run(path, lang):
    # Decode via ffmpeg; the language really is forced. Audio > 30 s is split into 30 s pieces.
    from transformers.pipelines.audio_utils import ffmpeg_read
    with open(path, "rb") as fh: audio = ffmpeg_read(fh.read(), SR)
    step = 30 * SR; parts = []
    for i in range(0, len(audio), step):
        chunk = audio[i:i + step]
        if len(chunk) < SR // 4: break
        try: t = _gen(chunk, lang, True)
        except Exception: t = _gen(chunk, lang, False)
        if t: parts.append(t)
    return {"text": " ".join(parts)}

app = FastAPI()

from starlette.requests import Request as _Req
from starlette.responses import Response as _Resp

@app.middleware("http")
async def _cors_api(request: _Req, call_next):
    # CORS for glasses apps (Even G2 WebView). Preflight = 204 WITHOUT a body, otherwise
    # iOS/WebKit drops the answer. Reachable only on loopback / through `tailscale serve`.
    origin = request.headers.get("origin")
    resp = _Resp(status_code=204) if request.method == "OPTIONS" else await call_next(request)
    if origin:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        resp.headers["Access-Control-Max-Age"] = "600"
    return resp

@app.get("/health")
def health():
    return {"status": "ok", "model": MID, "device": "cuda"}

@app.post("/v1/audio/transcriptions")
async def transcribe_http(file: UploadFile = File(...), language: str = Form(default="de"), model: str = Form(default=""), response_format: str = Form(default="json")):
    data = await file.read()
    if len(data) < MIN_BYTES:
        return PlainTextResponse("") if (response_format or "json").strip().lower() == "text" else JSONResponse({"text": ""})
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data); path = tmp.name
    try:
        out = await asyncio.to_thread(_http_run, path, _http_lang(language))
        text = (out.get("text") or "").strip()
    except Exception as e:
        return JSONResponse({"text": "", "error": str(e)[:120]}, status_code=500)
    finally:
        try: os.unlink(path)
        except Exception: pass
    if (response_format or "json").strip().lower() == "text":
        return PlainTextResponse(text)
    return JSONResponse({"text": text})

# ---------------- Babel WS ----------------
def lang_code(v):
    if not isinstance(v, str) or v.strip().lower() in ("", "auto"): return None
    return v.strip().lower().replace("_", "-").split("-")[0]

def fix_lang(text, det):
    if det == "ru" and (re.search("[ўЎ]", text) or (re.search("[іІ]", text) and re.search("[Ѐ-ӿ]", text))):
        return "be"
    return det

def ws_transcribe(audio, lang):
    feats = proc(audio, sampling_rate=SR, return_tensors="pt").input_features.to("cuda", torch.float16)
    kw = dict(task="transcribe", return_dict_in_generate=True, max_new_tokens=160, no_repeat_ngram_size=0)
    if lang: kw["language"] = lang
    with GPU_LOCK, torch.inference_mode():
        out = model.generate(feats, **kw)
    seq = out.sequences[0].tolist()
    text = proc.tokenizer.decode(seq, skip_special_tokens=True).strip()
    det = None
    for t in proc.tokenizer.convert_ids_to_tokens(seq[:4]):
        if t.startswith("<|") and t.endswith("|>") and 2 <= len(t) - 4 <= 3 and t[2:-2].isalpha() and t[2:-2] not in ("transcribe",):
            det = t[2:-2]; break
    if not lang: det = fix_lang(text, det)
    return text, det

async def ws_handle(ws):
    lang = None; buf = bytearray(); need = int(WINDOW * SR * 2)
    sess = None  # streaming session (opt-in, see babel_stream.py); None = old 3-s windows
    try:
        async for m in ws:
            if isinstance(m, str):
                try: f = json.loads(m)
                except ValueError: continue
                if isinstance(f, dict) and f.get("type") == "start":
                    if TOKEN and f.get("token") != TOKEN and not ts_user_ok(ws):
                        await ws.close(code=1008, reason="unauthorized"); return
                    lang = lang_code(f.get("language", "auto"))
                    path = getattr(getattr(ws, "request", None), "path", "") or ""
                    if sess is None and babel_stream.wants_stream(f, path):
                        sess = babel_stream.StreamSession(ws, lang, (lambda a, _l=lang: ws_transcribe(a, _l)), BAD, MIN_RMS).start()
                    print("start lang=", lang or "auto", "stream" if sess else "windows", flush=True)
                elif isinstance(f, dict) and f.get("type") == "stop" and sess is not None:
                    await sess.flush()
                continue
            if sess is not None:
                sess.feed(m); continue
            buf.extend(m)
            if len(buf) < need: continue
            a = np.frombuffer(bytes(buf), dtype=np.int16).astype(np.float32) / 32768.0; buf.clear()
            if float(np.sqrt(np.mean(a * a))) < MIN_RMS: continue
            text, det = await asyncio.to_thread(ws_transcribe, a, lang)
            if not text or any(b in text.lower() for b in BAD): continue
            await ws.send(json.dumps({"text": text, "final": True, "language": lang or det or "auto"}, ensure_ascii=False))
    except websockets.ConnectionClosed:
        pass
    finally:
        if sess is not None:
            await sess.close(flush=False)

async def main():
    # Warm-up run so the first real request does not pay for compilation
    try:
        import soundfile as sf
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False); tmp.close()
        sf.write(tmp.name, np.zeros(16000, dtype="float32"), 16000)
        await asyncio.to_thread(_http_run, tmp.name, "de"); os.unlink(tmp.name)
    except Exception as e:
        print("[whisper-unified] warmup: %s" % e, flush=True)
    babel_stream.preload()  # speaker model (ECAPA, CPU) loads in the background
    cfg = uvicorn.Config(app, host=HTTP_HOST, port=HTTP_PORT, log_level="warning")
    srv = uvicorn.Server(cfg); srv.install_signal_handlers = lambda: None
    print(f"whisper-unified ready: {MID} http://{HTTP_HOST}:{HTTP_PORT} ws://{WS_HOST}:{WS_PORT}", flush=True)
    async with websockets.serve(ws_handle, WS_HOST, WS_PORT, max_size=None):
        await srv.serve()

asyncio.run(main())
