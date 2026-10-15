/**
 * Live speech recognition while the touchpad is held: the words appear on
 * the glasses as they are spoken, and on release the live text is used
 * straight away. The batch upload (stt.ts) stays as the fallback: when the
 * live server cannot be reached within a few seconds, drops, or heard
 * nothing, the buffered recording goes to VITE_STT_URL as before.
 *
 * Same module as in OpenGlance (apps/openglance-nav/src/voice/live-stt.ts).
 * WebSocket client adapted from Quietglass Babel Glass
 * (apps/babel-glass/src/stt/provider.ts, createWebSocketStt, MIT):
 * one connection per recording, no reconnects (a recording is short), PCM
 * buffered until the socket is open.
 *
 * Protocol: on open {"type":"start","language":"de","sampleRate":16000,
 * "encoding":"s16le","stream":true}; then binary 16 kHz s16le mono frames;
 * {"type":"stop"} at the end. The server answers {"type":"partial","text":
 * "whole utterance so far"} and {"type":"final","text":"…"} at pauses (an
 * empty final clears the partial). Authentication is the Tailscale login the
 * `tailscale serve` in front of it adds; nothing to send.
 */

/** Set at build time in a private build: `VITE_LIVE_STT_URL=wss://… npm run build`. Empty = batch only. */
const BUILD_LIVE_STT_URL: string | undefined = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_LIVE_STT_URL;

export function liveSttUrl(build: string | undefined = BUILD_LIVE_STT_URL): string {
  return (build ?? "").trim();
}

/** A connection that is not open after this long is given up: the batch path takes over. */
export const LIVE_CONNECT_TIMEOUT_MS = 3_000;
/** After "stop", how long to wait for the last final. */
export const LIVE_STOP_GRACE_MS = 900;
/** The glasses are redrawn with new words at most this often. */
export const LIVE_REDRAW_MS = 300;

export interface LiveMessage {
  readonly final: boolean;
  readonly text: string;
}

export function parseLiveMessage(raw: unknown): LiveMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const text = typeof value["text"] === "string" ? value["text"] : typeof value["transcript"] === "string" ? value["transcript"] : null;
    if (text === null) return null;
    return { final: value["final"] === true || value["is_final"] === true || value["type"] === "final", text };
  } catch {
    return null;
  }
}

export interface LiveTranscript {
  readonly finals: readonly string[];
  readonly partial: string;
}

export const EMPTY_TRANSCRIPT: LiveTranscript = { finals: [], partial: "" };

/** A partial replaces the provisional words; a final commits them (an empty final only clears). */
export function applyLive(state: LiveTranscript, message: LiveMessage): LiveTranscript {
  if (!message.final) return { ...state, partial: message.text };
  const text = message.text.trim();
  return { finals: text ? [...state.finals, text] : state.finals, partial: "" };
}

/** Everything said so far: the finals joined, then the current partial. */
export function transcriptText(state: LiveTranscript): string {
  return [...state.finals, state.partial].join(" ").replace(/\s+/g, " ").trim();
}

/**
 * The newest words for a small screen: wrapped at `width` characters, the
 * last `rows` lines (the start drops off the top while speaking).
 */
export function tailLines(text: string, width: number, rows: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const piece = word.length > width ? word.slice(word.length - width) : word;
    if (!line) line = piece;
    else if (line.length + 1 + piece.length <= width) line += " " + piece;
    else { lines.push(line); line = piece; }
  }
  if (line) lines.push(line);
  return lines.slice(-rows);
}

export interface LiveOutcome {
  /** The socket opened and stayed open to the end. */
  readonly ok: boolean;
  readonly text: string;
}

export type TranscriptChoice =
  | { readonly use: "live"; readonly text: string }
  | { readonly use: "batch" }
  | { readonly use: "none" };

/**
 * What to do on release: the live text when the connection held and heard
 * something; otherwise the batch upload when there is a server for it; the
 * live text of a dropped connection as the last resort; else nothing.
 */
export function chooseTranscript(live: LiveOutcome | null, canBatch: boolean): TranscriptChoice {
  const text = live?.text.trim() ?? "";
  if (live?.ok && text) return { use: "live", text };
  if (canBatch) return { use: "batch" };
  if (text) return { use: "live", text };
  return { use: "none" };
}

/** Throttle for the live redraw: only new text, and not more often than every `minMs`. */
export function shouldRedraw(text: string, shown: string, now: number, shownAt: number, minMs = LIVE_REDRAW_MS): boolean {
  return text !== shown && now - shownAt >= minMs;
}

export interface LiveSession {
  /** One PCM block as the glasses deliver it; buffered until the socket is open. */
  send(pcm: Uint8Array): void;
  /** Stops, waits briefly for the last words, closes. */
  finish(): Promise<LiveOutcome>;
  /** Closes at once, nothing more is reported. */
  abort(): void;
}

type SocketLike = Pick<WebSocket, "send" | "close" | "readyState"> & {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  binaryType?: string;
};

export interface LiveConfig {
  readonly url: string;
  readonly language: string;
  /** The whole text so far, after every message that changed it. */
  readonly onText: (text: string) => void;
  readonly WS?: new (url: string) => SocketLike;
  readonly connectTimeoutMs?: number;
  readonly graceMs?: number;
}

export function openLiveStt(config: LiveConfig): LiveSession {
  const WS = config.WS ?? (globalThis.WebSocket as unknown as new (url: string) => SocketLike);
  let transcript = EMPTY_TRANSCRIPT;
  let opened = false;
  let failed = false;
  let done = false;
  let stopping = false;
  let pending: Uint8Array[] = [];
  let socket: SocketLike | null = null;
  let finalSeen: (() => void) | null = null;

  const fail = (): void => {
    failed = true;
    pending = [];
    try { socket?.close(); } catch { /* already closed */ }
  };

  try {
    socket = new WS(config.url);
    socket.binaryType = "arraybuffer";
  } catch {
    socket = null;
    failed = true;
  }
  const connectTimer = socket ? setTimeout(() => { if (!opened) fail(); }, config.connectTimeoutMs ?? LIVE_CONNECT_TIMEOUT_MS) : null;

  if (socket) {
    const ws = socket;
    ws.onopen = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (failed || done) { try { ws.close(); } catch { /* closing anyway */ } return; }
      opened = true;
      ws.send(JSON.stringify({ type: "start", language: config.language, sampleRate: 16_000, encoding: "s16le", stream: true }));
      for (const chunk of pending) ws.send(chunk);
      pending = [];
    };
    ws.onmessage = (event: MessageEvent) => {
      if (done && !finalSeen) return;
      const message = parseLiveMessage(event.data);
      if (!message) return;
      const before = transcriptText(transcript);
      transcript = applyLive(transcript, message);
      const after = transcriptText(transcript);
      if (after !== before && !done) config.onText(after);
      if (message.final) finalSeen?.();
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (connectTimer) clearTimeout(connectTimer);
      // Closed by the server after "stop" is the normal end, not a drop.
      if (!done && !stopping) failed = true;
      finalSeen?.();
    };
  }

  return {
    send(pcm) {
      if (failed || done || !socket) return;
      if (opened && socket.readyState === 1) socket.send(pcm);
      else if (!opened) pending.push(pcm);
    },
    async finish() {
      if (connectTimer) clearTimeout(connectTimer);
      const ok = opened && !failed && socket !== null && socket.readyState === 1;
      if (ok && socket) {
        const ws = socket;
        // "stop" makes the server commit the last words now; they arrive as a final.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, config.graceMs ?? LIVE_STOP_GRACE_MS);
          finalSeen = () => { clearTimeout(timer); resolve(); };
          stopping = true;
          try { ws.send(JSON.stringify({ type: "stop" })); } catch { clearTimeout(timer); resolve(); }
        });
      }
      done = true;
      finalSeen = null;
      const stayed = ok && !failed;
      try { socket?.close(); } catch { /* closed */ }
      return { ok: stayed, text: transcriptText(transcript) };
    },
    abort() {
      done = true;
      finalSeen = null;
      if (connectTimer) clearTimeout(connectTimer);
      pending = [];
      try { socket?.close(); } catch { /* closed */ }
    },
  };
}
