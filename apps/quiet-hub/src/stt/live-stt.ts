/**
 * Live speech-to-text while the wearer holds the touchpad.
 *
 * The PCM blocks of the glasses mic go to a streaming recogniser over a
 * WebSocket; its partial and final lines are shown on the glasses as they
 * come. On release the live transcript goes straight to the confirm step - no
 * WAV upload, no second Whisper pass. When the socket does not open within
 * ~3 s, drops mid-way or heard nothing, the recording is uploaded as WAV
 * exactly as before (the PCM is always kept), so nothing is lost.
 *
 * Client protocol adapted from apps/babel-glass/src/stt/provider.ts
 * (createWebSocketStt / parseTranscript, same repo): start frame, binary
 * 16 kHz s16le PCM, {"type":"stop"} and a short grace for the last final.
 * Unlike Babel Glass there is no reconnect: a voice note is short, the WAV
 * fallback is the safer recovery.
 */

export interface LiveLine {
  readonly text: string;
  readonly final: boolean;
}

/** Tolerates the common reply shapes ({type:"partial"|"final", text}, {transcript, is_final}). */
export function parseLiveMessage(raw: unknown): LiveLine | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const text = typeof value["text"] === "string" ? value["text"] : typeof value["transcript"] === "string" ? value["transcript"] : null;
    if (text === null) return null;
    const final = value["final"] === true || value["is_final"] === true || value["type"] === "final";
    return { text, final };
  } catch {
    return null;
  }
}

/** Finals so far plus the partial of the utterance being spoken. */
export interface LiveTranscript {
  readonly finals: readonly string[];
  readonly partial: string;
}

export const EMPTY_TRANSCRIPT: LiveTranscript = { finals: [], partial: "" };

/** A final commits the utterance (an empty final only clears the partial); a partial replaces the last one. */
export function applyLine(transcript: LiveTranscript, line: LiveLine): LiveTranscript {
  const text = line.text.replace(/\s+/g, " ").trim();
  if (line.final) return { finals: text === "" ? transcript.finals : [...transcript.finals, text], partial: "" };
  return { finals: transcript.finals, partial: text };
}

/** The whole transcript as one text: all finals joined, then the current partial. */
export function transcriptText(transcript: LiveTranscript): string {
  return [...transcript.finals, transcript.partial].filter((part) => part !== "").join(" ").trim();
}

export type LiveStatus = "off" | "connecting" | "open" | "failed";

/**
 * Which way the voice note goes on release. "live": the live transcript is
 * complete (socket stayed open to the end) and not empty. Anything else is
 * uploaded as WAV, the 0.6.7 path.
 */
export function chooseVoicePath(result: { readonly ok: boolean; readonly text: string }): "live" | "upload" {
  return result.ok && result.text.trim() !== "" ? "live" : "upload";
}

/** Private build: `VITE_LIVE_STT_URL=wss://… npm run build`; empty in the public build (WAV upload only). */
export function buildLiveSttUrl(): string {
  const value = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_LIVE_STT_URL;
  return typeof value === "string" ? value.trim() : "";
}

interface SocketLike {
  readyState: number;
  binaryType?: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export interface LiveSttOptions {
  readonly url: string;
  /** "de" / "en"; the recogniser's language. */
  readonly language: string;
  /** Called with the whole transcript whenever it changes. */
  readonly onText: (text: string) => void;
  readonly WS?: new (url: string) => SocketLike;
  readonly connectTimeoutMs?: number;
  /** After "stop": how long to wait for the last final. */
  readonly stopGraceMs?: number;
  /** PCM kept while the socket is still opening (default 30 s of audio). */
  readonly maxPendingBytes?: number;
}

export interface LiveSttSession {
  readonly status: LiveStatus;
  /** One PCM block exactly as the SDK delivered it. */
  send(pcm: Uint8Array): void;
  /** Release: commit the last words and close. ok = the socket was open the whole time. */
  finish(): Promise<{ readonly ok: boolean; readonly text: string }>;
  /** Discarded recording: close without waiting. */
  cancel(): void;
}

export const CONNECT_TIMEOUT_MS = 3000;
export const STOP_GRACE_MS = 900;

export function startLiveStt(options: LiveSttOptions): LiveSttSession {
  const WS = options.WS ?? (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  const maxPending = options.maxPendingBytes ?? 16_000 * 2 * 30;
  let status: LiveStatus = "connecting";
  let transcript = EMPTY_TRANSCRIPT;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let stopping = false;
  let onFinalAfterStop: (() => void) | null = null;
  let socket: SocketLike | null = null;

  const fail = (): void => {
    if (status === "failed") return;
    status = "failed";
    pending = [];
    pendingBytes = 0;
    try { socket?.close(); } catch { /* already closed */ }
    socket = null;
    onFinalAfterStop?.();
  };

  if (WS === undefined || options.url === "") {
    status = "failed";
  } else {
    try {
      socket = new WS(options.url);
      socket.binaryType = "arraybuffer";
    } catch {
      socket = null;
      status = "failed";
    }
  }
  const ws = socket;
  if (ws !== null) {
    // A handshake that never completes (blocked origin, unreachable host) must not hold the note.
    const connectTimer = setTimeout(() => { if (status === "connecting") fail(); }, options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(connectTimer);
      if (status !== "connecting") return;
      status = "open";
      try {
        ws.send(JSON.stringify({ type: "start", language: options.language, sampleRate: 16_000, encoding: "s16le", stream: true }));
        for (const block of pending) ws.send(block);
      } catch {
        fail();
      }
      pending = [];
      pendingBytes = 0;
    };
    ws.onmessage = (event) => {
      const line = parseLiveMessage(event.data);
      if (line === null) return;
      const before = transcriptText(transcript);
      transcript = applyLine(transcript, line);
      const after = transcriptText(transcript);
      if (after !== before) options.onText(after);
      if (line.final && stopping) onFinalAfterStop?.();
    };
    ws.onerror = () => { clearTimeout(connectTimer); if (!stopping) fail(); };
    // A drop while speaking: the live text is incomplete, the WAV upload takes over.
    ws.onclose = () => { clearTimeout(connectTimer); if (!stopping) fail(); else onFinalAfterStop?.(); };
  }

  return {
    get status() { return status; },
    send(pcm) {
      if (status === "open" && socket !== null) {
        try { socket.send(pcm); } catch { fail(); }
      } else if (status === "connecting") {
        if (pendingBytes + pcm.length > maxPending) return;
        pending.push(pcm);
        pendingBytes += pcm.length;
      }
    },
    async finish() {
      if (status !== "open" || socket === null) {
        const ok = false;
        const text = transcriptText(transcript);
        fail();
        return { ok, text };
      }
      stopping = true;
      const open = socket;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), options.stopGraceMs ?? STOP_GRACE_MS);
        onFinalAfterStop = () => { clearTimeout(timer); resolve(); };
        try { open.send(JSON.stringify({ type: "stop" })); } catch { clearTimeout(timer); resolve(); }
      });
      onFinalAfterStop = null;
      // Whatever is still provisional counts: the wearer stopped talking.
      const text = transcriptText(transcript);
      const ok = status === "open";
      try { open.close(); } catch { /* closing anyway */ }
      socket = null;
      status = "failed";
      return { ok, text };
    },
    cancel() {
      stopping = true;
      fail();
    },
  };
}
