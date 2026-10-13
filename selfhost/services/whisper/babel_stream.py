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

Speaker labels come from a deliberately light, CPU-only change detector
(MFCC statistics + median pitch, online clustering). It tells clearly different
voices apart (e.g. a low and a high voice); two similar voices may share a label.
Set SPEAKERS=0 to switch it off.
"""
import os, json, asyncio, re
import numpy as np

SR = 16000
STEP = float(os.environ.get("STREAM_STEP", "0.8"))          # seconds of new audio between decodes
SIL_END = float(os.environ.get("STREAM_SILENCE", "0.7"))    # pause that ends an utterance
MAX_SEC = float(os.environ.get("STREAM_MAX", "12.0"))       # longest utterance before a forced cut
SPEAKERS = os.environ.get("SPEAKERS", "1") != "0"
SPK_THRESH = float(os.environ.get("SPK_THRESH", "5.0"))
MAX_SPEAKERS = int(os.environ.get("MAX_SPEAKERS", "4"))
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


class SpeakerTracker:
    """Online clustering of short voice fingerprints. Never raises: returns None on any problem."""

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
            return self.last
        if vec is None:
            return self.last
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
