"""Streaming mode for the Babel WebSocket (opt-in, old clients are unaffected).

A client asks for it with `{"type":"start", ..., "stream": true}` (or `?stream=1`
in the URL). Instead of cutting rigid 3-second windows, the server then keeps the
current utterance in a growing buffer and re-transcribes it every STEP seconds:

  {"type":"partial", "text": "...", "stable": "...", "final": false, "language": "de"}
      the whole utterance so far; `stable` is the word prefix two consecutive
      hypotheses agreed on (LocalAgreement-2), i.e. text that will not change.
  {"type":"final", "text": "...", "final": true, "language": "de", "speaker": "A"}
      sent when the speaker pauses (SIL_END) or the utterance gets too long
      (MAX_SEC, cut at the quietest moment). `text` may be "" (clears the partial).

Speaker labels ("A", "B", ...) come from ECAPA-TDNN speaker embeddings
(speechbrain/spkrec-ecapa-voxceleb exported to ONNX by export_ecapa_onnx.py, 192 dims,
onnxruntime on the CPU so the GPU stays free; no torch/torchaudio needed at runtime):
one embedding per final line, online clustering by cosine similarity against a
running mean per speaker (threshold adapts per session, see tracker). Lines with less than SPK_MIN_SEC of voice never
open a new speaker; they go to the most similar known speaker or stay with the
previous one. If the model is missing or fails to load, the old light detector
(MFCC + pitch, librosa) takes over automatically. SPEAKERS=0 switches labels off.
"""
import os, json, asyncio, re
import numpy as np

SR = 16000
STEP = float(os.environ.get("STREAM_STEP", "0.8"))          # seconds of new audio between decodes
SIL_END = float(os.environ.get("STREAM_SILENCE", "0.7"))    # pause that ends an utterance
MAX_SEC = float(os.environ.get("STREAM_MAX", "12.0"))       # longest utterance before a forced cut
SPEAKERS = os.environ.get("SPEAKERS", "1") != "0"
SPK_THRESH = float(os.environ.get("SPK_THRESH", "5.0"))           # light fallback: L2 distance
MAX_SPEAKERS = int(os.environ.get("MAX_SPEAKERS", "6"))
SPK_MODEL = os.environ.get("SPK_MODEL", "ecapa").strip().lower()  # "ecapa" (default) or "light"
SPK_ECAPA_DIR = os.environ.get("SPK_ECAPA_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "models", "spkrec-ecapa-voxceleb")
SPK_COS = float(os.environ.get("SPK_COS", "0.60"))         # start: same speaker if cosine to centroid >= this
SPK_ADAPT = os.environ.get("SPK_ADAPT", "1") != "0"         # adapt the threshold to the room (see tracker)
SPK_MARGIN = float(os.environ.get("SPK_MARGIN", "0.20"))
SPK_COS_MIN = float(os.environ.get("SPK_COS_MIN", "0.42"))
SPK_COS_MAX = float(os.environ.get("SPK_COS_MAX", "0.65"))
SPK_MIN_SEC = float(os.environ.get("SPK_MIN_SEC", "1.0"))  # less voice than this never opens a speaker
SPK_MAX_SEC = float(os.environ.get("SPK_MAX_SEC", "6.0"))  # embed at most this much (keeps CPU time low)
SPK_THREADS = int(os.environ.get("SPK_THREADS", "4"))      # CPU threads for the embedding
FRAME = 480                                                  # 30 ms energy frames
LABELS = "ABCDEFGH"


def _norm_word(w):
    return re.sub(r"[^\w]", "", w.lower())


def agreed_prefix(prev, cur):
    """Words both hypotheses start with (compared without case and punctuation)."""
    out = []
    for a, b in zip(prev, cur):
        if _norm_word(a) != _norm_word(b):
            break
        out.append(b)
    return out


def first_pause(voiced, need):
    """Frame index where the first run of >= need unvoiced frames after speech starts, else None."""
    run = 0
    seen = False
    for i, v in enumerate(voiced):
        if v:
            seen = True
            run = 0
        else:
            run += 1
            if seen and run >= need:
                return i - run + 1
    return None


class LightSpeakerTracker:
    """Fallback: online clustering of MFCC/pitch fingerprints. Never raises: returns None on any problem."""

    def __init__(self, threshold=SPK_THRESH, max_speakers=MAX_SPEAKERS):
        self.threshold = threshold
        self.max_speakers = max_speakers
        self.centroids = []   # [vec, count]
        self.last = None

    @staticmethod
    def fingerprint(audio):
        import librosa
        a = np.asarray(audio, dtype=np.float32)
        if len(a) < SR // 2:
            return None
        hop = 160
        e = librosa.feature.rms(y=a, frame_length=512, hop_length=hop)[0]
        loud = e > max(0.006, float(np.percentile(e, 45)))
        if loud.sum() < 40:            # < 0.4 s of voiced audio: too little to judge
            return None
        mf = librosa.feature.mfcc(y=a, sr=SR, n_mfcc=20, n_fft=512, hop_length=hop)
        k = min(mf.shape[1], len(loud))
        mf = mf[:, :k][:, loud[:k]]
        f0 = librosa.yin(a, fmin=60, fmax=400, sr=SR, frame_length=1024, hop_length=hop)
        k = min(len(f0), len(loud))
        f0v = f0[:k][loud[:k]]
        pitch = float(np.median(f0v)) if len(f0v) else 150.0
        # Scaled so that each part contributes roughly 1.0 for a clearly different voice.
        timbre = mf[1:13].mean(axis=1) / 12.0
        spread = mf[1:13].std(axis=1) / 12.0
        return np.concatenate([timbre, spread * 0.5, [np.log2(pitch / 150.0) * 2.0]])

    def assign(self, audio):
        try:
            vec = self.fingerprint(audio)
        except Exception as e:  # librosa missing or odd audio
            print("[babel-stream] speaker off: %s" % e, flush=True)
            return LABELS[self.last] if self.last is not None else None
        if vec is None:
            return LABELS[self.last] if self.last is not None else None
        if not self.centroids:
            self.centroids.append([vec, 1]); self.last = 0
            return LABELS[0]
        dists = [float(np.linalg.norm(vec - c[0])) for c in self.centroids]
        best = int(np.argmin(dists))
        if dists[best] > self.threshold and len(self.centroids) < self.max_speakers:
            self.centroids.append([vec, 1]); best = len(self.centroids) - 1
        else:
            c = self.centroids[best]
            n = min(c[1], 20)
            c[0] = (c[0] * n + vec) / (n + 1); c[1] += 1
        self.last = best
        return LABELS[best]

    def distances(self, audio):
        """Debug helper for tuning SPK_THRESH."""
        vec = self.fingerprint(audio)
        return None if vec is None else [round(float(np.linalg.norm(vec - c[0])), 3) for c in self.centroids]


# ---------------------------------------------------------------- ECAPA speaker embeddings
import threading, time

_ECAPA = None            # onnxruntime session once loaded, False after a failed load
_ECAPA_LOCK = threading.Lock()
_STATS = {"n": 0, "ms": 0.0}
_MEL = None


def _mel_matrix(n_fft=400, n_mels=80, sr=SR):
    """Triangular mel filters exactly as speechbrain's Filterbank builds them (HTK mel scale)."""
    to_mel = lambda hz: 2595.0 * np.log10(1.0 + hz / 700.0)
    mel = np.linspace(to_mel(0.0), to_mel(sr / 2), n_mels + 2)
    hz = 700.0 * (10 ** (mel / 2595.0) - 1.0)
    band = (hz[1:] - hz[:-1])[:-1]
    fc = hz[1:-1]
    freqs = np.linspace(0, sr // 2, n_fft // 2 + 1)
    slope = (freqs[None, :] - fc[:, None]) / band[:, None]
    return np.maximum(0.0, np.minimum(slope + 1.0, 1.0 - slope)).T.astype(np.float32)   # (201, 80)


def fbank(audio):
    """80-dim log-mel features like speechbrain Fbank(n_mels=80): 25 ms Hamming, 10 ms hop, centred."""
    global _MEL
    if _MEL is None:
        _MEL = _mel_matrix()
    n_fft, hop = 400, 160
    x = np.pad(np.asarray(audio, dtype=np.float32), (n_fft // 2, n_fft // 2))
    nfr = 1 + (len(x) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(nfr)[:, None]
    win = (0.54 - 0.46 * np.cos(2 * np.pi * np.arange(n_fft) / n_fft)).astype(np.float32)
    spec = np.abs(np.fft.rfft(x[idx] * win, n=n_fft)) ** 2
    db = 10.0 * np.log10(np.maximum(spec.astype(np.float32) @ _MEL, 1e-10))
    return np.maximum(db, db.max() - 80.0).astype(np.float32)          # (frames, 80)


def load_ecapa():
    """Loads the ECAPA encoder (ONNX, CPU) once. Returns None if unavailable. Never raises."""
    global _ECAPA
    if _ECAPA is not None:
        return _ECAPA or None
    with _ECAPA_LOCK:
        if _ECAPA is not None:
            return _ECAPA or None
        try:
            import onnxruntime as ort
            t = time.time()
            so = ort.SessionOptions()
            if SPK_THREADS > 0:
                so.intra_op_num_threads = SPK_THREADS
                so.inter_op_num_threads = 1
            sess = ort.InferenceSession(os.path.join(SPK_ECAPA_DIR, "ecapa.onnx"), so,
                                        providers=["CPUExecutionProvider"])
            sess.run(None, {"feats": fbank(np.zeros(SR, dtype=np.float32))[None]})   # warm-up
            _ECAPA = sess
            print("[babel-stream] ECAPA speaker model loaded (onnx, cpu, %.1f s): %s"
                  % (time.time() - t, os.path.basename(SPK_ECAPA_DIR)), flush=True)
        except Exception as e:
            _ECAPA = False
            print("[babel-stream] ECAPA unavailable, using light speaker labels: %s" % e, flush=True)
    return _ECAPA or None


def voiced_span(audio, min_rms=0.006):
    """Audio without leading/trailing silence, cut to the middle SPK_MAX_SEC; plus voiced seconds."""
    a = np.asarray(audio, dtype=np.float32)
    nf = len(a) // FRAME
    if nf == 0:
        return a, 0.0
    rms = np.sqrt(np.mean(a[: nf * FRAME].reshape(nf, FRAME) ** 2, axis=1))
    # Above the fixed floor AND clearly above this line's own noise floor (noisy rooms
    # otherwise count every frame as voice and a short "ja" looks long enough to open a speaker).
    gate = max(min_rms, 2.5 * float(np.percentile(rms, 15)))
    voiced = float((rms > gate).sum() * FRAME / SR)
    on = np.nonzero(rms > gate)[0]
    if len(on) == 0:
        return a[:0], 0.0
    a = a[on[0] * FRAME: (on[-1] + 1) * FRAME]
    cap = int(SPK_MAX_SEC * SR)
    if len(a) > cap:
        off = (len(a) - cap) // 2
        a = a[off: off + cap]
    return a, voiced


def ecapa_embed(audio):
    """Unit-length 192-dim embedding of 16 kHz float audio, or None."""
    sess = load_ecapa()
    if sess is None or len(audio) < SR // 4:
        return None
    t = time.time()
    feats = fbank(audio)[None]
    e = sess.run(None, {"feats": feats})[0].reshape(-1).astype(np.float32)
    ms = (time.time() - t) * 1000.0
    _STATS["n"] += 1
    _STATS["ms"] += ms
    if _STATS["n"] <= 3 or _STATS["n"] % 25 == 0:
        print("[babel-stream] ECAPA embedding %.0f ms (%.1f s audio, avg %.0f ms over %d)"
              % (ms, len(audio) / SR, _STATS["ms"] / _STATS["n"], _STATS["n"]), flush=True)
    n = float(np.linalg.norm(e))
    return e / n if n > 0 else None


class EcapaSpeakerTracker:
    """Online clustering of ECAPA embeddings (cosine to a running mean per speaker).

    - the first line opens A; a line opens a new speaker only if it has at least SPK_MIN_SEC
      of voice, its best cosine is below the threshold and fewer than MAX_SPEAKERS exist;
    - the threshold adapts to the session: it starts at SPK_COS and, once a few lines were matched,
      becomes (median same-speaker cosine - SPK_MARGIN), kept within [SPK_COS_MIN, SPK_COS_MAX].
      Noisy rooms lower every cosine; a fixed value would then split one person into several letters;
    - two speakers whose running means grow alike are merged (later lines get the older letter);
    - short lines go to the most similar speaker, or stay with the previous one if nothing is close,
      and never change a centroid;
    - falls back to the light tracker whenever the model is unavailable. Never raises.
    """

    def __init__(self, threshold=None, max_speakers=None, min_sec=None, adapt=None):
        self.start = SPK_COS if threshold is None else threshold
        self.adapt = SPK_ADAPT if adapt is None else adapt
        self.max_speakers = min(MAX_SPEAKERS if max_speakers is None else max_speakers, len(LABELS))
        self.min_sec = SPK_MIN_SEC if min_sec is None else min_sec
        self.centroids = []   # [mean unit vector, count, alias index or None]
        self.matched = []     # cosine of recent lines to the speaker they were given (same-speaker scores)
        self.last = None
        self.light = None
        self.last_scores = []

    @property
    def threshold(self):
        if not self.adapt or len(self.matched) < 3:
            return self.start
        return float(min(SPK_COS_MAX, max(SPK_COS_MIN, float(np.median(self.matched)) - SPK_MARGIN)))

    def _fallback(self, audio):
        if self.light is None:
            self.light = LightSpeakerTracker(max_speakers=self.max_speakers)
        return self.light.assign(audio)

    def _keep(self):
        return LABELS[self.last] if self.last is not None else None

    def assign(self, audio):
        try:
            if load_ecapa() is None:
                return self._fallback(audio)
            seg, voiced = voiced_span(audio)
            if voiced < 0.3 or len(seg) < SR // 3:
                return self._keep()
            vec = ecapa_embed(seg)
            if vec is None:
                return self._keep()
            return LABELS[self.place(vec, voiced)]
        except Exception as e:
            print("[babel-stream] ECAPA speaker failed: %s" % e, flush=True)
            return self._keep()

    @staticmethod
    def _unit(v):
        return v / (np.linalg.norm(v) or 1.0)

    def _active(self):
        return [i for i, c in enumerate(self.centroids) if c[2] is None]

    def _merge(self, thr):
        """Folds speakers whose means became alike into the older one."""
        act = self._active()
        for x in range(len(act)):
            for y in range(x + 1, len(act)):
                i, j = act[x], act[y]
                ci, cj = self.centroids[i], self.centroids[j]
                if float(self._unit(ci[0]) @ self._unit(cj[0])) >= thr + 0.1:
                    w = ci[1] + cj[1]
                    ci[0] = self._unit(self._unit(ci[0]) * ci[1] + self._unit(cj[0]) * cj[1])
                    ci[1] = w
                    cj[2] = i
                    if self.last == j:
                        self.last = i
                    return True
        return False

    def place(self, vec, voiced):
        """Speaker index for a unit embedding with `voiced` seconds of voice; updates the clusters."""
        if not self.centroids:
            self.centroids.append([vec.copy(), 1, None])
            self.last, self.last_scores = 0, [1.0]
            return 0
        thr = self.threshold
        act = self._active()
        scores = [float(vec @ self._unit(self.centroids[i][0])) for i in act]
        self.last_scores = scores
        k = int(np.argmax(scores))
        best, score = act[k], scores[k]
        if voiced < self.min_sec:
            if score < thr - 0.15 and self.last is not None:
                best = self.last
            self.last = best
            return best
        if score < thr and len(act) < self.max_speakers and len(self.centroids) < len(LABELS):
            self.centroids.append([vec.copy(), 1, None])
            best = len(self.centroids) - 1
        elif score >= thr - 0.1:
            c = self.centroids[best]
            n = min(c[1], 30)
            c[0] = self._unit(self._unit(c[0]) * n + vec)
            c[1] += 1
            if score >= thr:
                self.matched = (self.matched + [score])[-40:]
            if self._merge(thr):
                while self.centroids[best][2] is not None:
                    best = self.centroids[best][2]
        self.last = best
        return best


def SpeakerTracker():
    """Tracker for one session: ECAPA (falls back by itself) unless SPK_MODEL=light."""
    if SPK_MODEL == "light":
        return LightSpeakerTracker()
    return EcapaSpeakerTracker()


def preload():
    """Optional: load the speaker model in a background thread at server start."""
    if SPEAKERS and SPK_MODEL != "light":
        threading.Thread(target=load_ecapa, daemon=True).start()


class StreamSession:
    """One streaming connection. `transcribe(audio) -> (text, detected_lang)` runs in a thread."""

    def __init__(self, ws, lang, transcribe, bad=(), min_rms=0.006):
        self.ws = ws
        self.lang = lang
        self.transcribe = transcribe
        self.bad = tuple(b.lower() for b in bad)
        self.min_rms = min_rms
        self.audio = np.zeros(0, dtype=np.float32)
        self.carry = b""
        self.fresh = 0
        self.prev_words = []
        self.last_partial = ""
        self.partial_open = False
        self.speakers = SpeakerTracker() if SPEAKERS else None
        self.wake = asyncio.Event()
        self.lock = asyncio.Lock()   # a decode step and a client "stop" flush must not cut the same audio twice
        self.closed = False
        self.task = None

    def start(self):
        self.task = asyncio.create_task(self._run())
        return self

    def feed(self, chunk):
        data = self.carry + bytes(chunk)
        if len(data) % 2:
            self.carry, data = data[-1:], data[:-1]
        else:
            self.carry = b""
        if not data:
            return
        a = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        self.audio = np.concatenate([self.audio, a])
        self.fresh += len(a)
        if self.fresh >= int(STEP * SR):
            self.wake.set()

    async def close(self, flush=True):
        if self.closed:
            return
        self.closed = True
        self.wake.set()
        if self.task:
            try:
                await self.task
            except Exception:
                pass
        if flush:
            await self._flush_all()

    async def flush(self):
        """Client said stop: commit what is left, keep the session open."""
        await self._flush_all()

    # ------------------------------------------------------------------
    async def _send(self, payload):
        try:
            await self.ws.send(json.dumps(payload, ensure_ascii=False))
        except Exception:
            pass

    def _clean(self, text):
        t = (text or "").strip()
        if not t or any(b in t.lower() for b in self.bad):
            return ""
        return t

    async def _decode(self, audio):
        text, det = await asyncio.to_thread(self.transcribe, audio)
        return self._clean(text), (self.lang or det or "auto")

    async def _run(self):
        while not self.closed:
            await self.wake.wait()
            self.wake.clear()
            while not self.closed and self.fresh >= int(STEP * SR):
                self.fresh = 0
                try:
                    async with self.lock:
                        await self._step()
                except Exception as e:
                    print("[babel-stream] step failed: %s" % e, flush=True)

    def _frames(self, a):
        nf = len(a) // FRAME
        if nf == 0:
            return np.zeros(0)
        return np.sqrt(np.mean(a[: nf * FRAME].reshape(nf, FRAME) ** 2, axis=1))

    def _drop(self, n):
        """Removes the first n samples (audio may have grown meanwhile)."""
        self.audio = self.audio[n:]

    async def _final(self, seg):
        text, lang = await self._decode(seg) if len(seg) >= SR // 4 else ("", self.lang or "auto")
        speaker = None
        if text and self.speakers is not None:
            speaker = await asyncio.to_thread(self.speakers.assign, seg)
        msg = {"type": "final", "text": text, "final": True, "language": lang}
        if speaker:
            msg["speaker"] = speaker
        if text or self.partial_open:
            await self._send(msg)
        self.partial_open = False
        self.prev_words = []
        self.last_partial = ""

    async def _step(self):
        a = self.audio
        n = len(a)
        rms = self._frames(a)
        voiced = np.nonzero(rms > self.min_rms)[0]
        if len(voiced) == 0:
            if self.partial_open:
                await self._final(np.zeros(0, dtype=np.float32))
            keep = int(0.4 * SR)
            if n > keep:
                self._drop(n - keep)
            return
        # The first pause of SIL_END after some speech ends the utterance. Searched in the
        # whole buffer, not only at its end: decodes run every STEP seconds, so a short
        # pause between two speakers can lie between two decode points.
        pause = first_pause(rms > self.min_rms, int(SIL_END * SR / FRAME))
        if pause is not None:
            cut = min(n, pause * FRAME + int(0.25 * SR))
            await self._final(a[:cut])
            self._drop(cut)
            return
        if n / SR >= MAX_SEC:
            nf = len(rms)
            lo = max(1, nf - int(4 * SR / FRAME))
            hi = max(lo + 1, nf - int(0.5 * SR / FRAME))
            cut = int((lo + int(np.argmin(rms[lo:hi]))) * FRAME + FRAME // 2)
            await self._final(a[:cut])
            self._drop(cut)
            return
        if len(voiced) * FRAME / SR < 0.3:
            return
        text, lang = await self._decode(a)
        if not text or text == self.last_partial:
            return
        words = text.split()
        stable = agreed_prefix(self.prev_words, words)
        self.prev_words = words
        self.last_partial = text
        self.partial_open = True
        await self._send({"type": "partial", "text": text, "stable": " ".join(stable),
                          "final": False, "language": lang})

    async def _flush_all(self):
        async with self.lock:
            await self._flush_locked()

    async def _flush_locked(self):
        a = self.audio
        self.audio = np.zeros(0, dtype=np.float32)
        self.fresh = 0
        rms = self._frames(a)
        if len(rms) and (rms > self.min_rms).sum() * FRAME / SR >= 0.3:
            await self._final(a)
        elif self.partial_open:
            await self._final(np.zeros(0, dtype=np.float32))


def wants_stream(start_frame, path=""):
    return bool(start_frame.get("stream")) or start_frame.get("mode") == "stream" or "stream=1" in (path or "")
