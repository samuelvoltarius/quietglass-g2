#!/usr/bin/env python3
"""
Babel Glass translation server — LibreTranslate-compatible, on Meta NLLB-200.

For language pairs LibreTranslate (Argos) does not have — above all
Belarusian, which NLLB-200 supports (bel_Cyrl), as well as Russian (rus_Cyrl)
and Ukrainian (ukr_Cyrl) straight into German (deu_Latn) without pivoting
through English.

    pip install transformers torch sentencepiece
    python translate-server.py                  # http://0.0.0.0:5000/translate
    MODEL=facebook/nllb-200-distilled-1.3B DEVICE=cuda python translate-server.py

In Babel Glass choose "LibreTranslate-compatible" and enter
http://your-host:5000/translate.

Licence note: the NLLB-200 weights are CC-BY-NC-4.0 (non-commercial use).

Request:  POST /translate {"q":"...","source":"be","target":"de","format":"text"}
Reply:    {"translatedText":"..."}
"""
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

MODEL_NAME = os.environ.get("MODEL", "facebook/nllb-200-distilled-600M")
DEVICE = os.environ.get("DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "5000"))
API_KEY = os.environ.get("API_KEY", "")
# The phone app runs in a WebView on another origin, so CORS must allow it.
CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "*")

# ISO 639-1 (what Babel Glass and Whisper use) -> NLLB-200 (FLORES-200) codes.
NLLB = {
    "ru": "rus_Cyrl", "be": "bel_Cyrl", "uk": "ukr_Cyrl", "de": "deu_Latn",
    "en": "eng_Latn", "pl": "pol_Latn", "cs": "ces_Latn", "fr": "fra_Latn",
    "es": "spa_Latn", "it": "ita_Latn", "pt": "por_Latn", "nl": "nld_Latn",
    "tr": "tur_Latn", "ar": "arb_Arab", "zh": "zho_Hans", "ja": "jpn_Jpan",
}

print(f"loading {MODEL_NAME} on {DEVICE}…")
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_NAME).to(DEVICE).eval()
print(f"Babel Glass translation server on http://{HOST}:{PORT}/translate")
# tokenizer.src_lang is shared state: one translation at a time.
lock = threading.Lock()


def guess_cyrillic(text):
    """For source "auto": ў is only Belarusian; ї/є/ґ only Ukrainian;
    і without и is Belarusian. Other Cyrillic is read as Russian."""
    t = text.lower()
    if not re.search("[Ѐ-ӿ]", t):
        return None
    if "ў" in t:
        return "be"
    if re.search("[їєґ]", t):
        return "uk"
    if "і" in t:
        return "uk" if "и" in t else "be"
    return "ru"


def nllb_code(code, text=""):
    code = (code or "").strip().lower().replace("_", "-").split("-")[0]
    if code in ("", "auto"):
        code = guess_cyrillic(text)
    return NLLB.get(code or "")


def translate(text, source, target):
    with lock, torch.inference_mode():
        tokenizer.src_lang = source
        inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=512).to(DEVICE)
        out = model.generate(
            **inputs,
            forced_bos_token_id=tokenizer.convert_tokens_to_ids(target),
            max_new_tokens=256,
            num_beams=2,
        )
    return tokenizer.batch_decode(out, skip_special_tokens=True)[0]


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.reply(200, {})

    def do_GET(self):
        if self.path.rstrip("/") == "/languages":
            codes = sorted(NLLB)
            return self.reply(200, [{"code": c, "name": NLLB[c], "targets": codes} for c in codes])
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/translate":
            return self.reply(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.reply(400, {"error": "invalid JSON"})
        if API_KEY and body.get("api_key") != API_KEY:
            return self.reply(403, {"error": "invalid api_key"})

        text = body.get("q", "")
        if not isinstance(text, str) or not text.strip():
            return self.reply(400, {"error": "q must be a non-empty string"})
        source = nllb_code(body.get("source"), text)
        target = nllb_code(body.get("target"))
        if not source or not target:
            return self.reply(400, {"error": "unsupported or undetectable language; set source explicitly"})
        if source == target:
            return self.reply(200, {"translatedText": text})
        self.reply(200, {"translatedText": translate(text, source, target)})

    def log_message(self, fmt, *args):
        pass  # never log caption text


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
