/**
 * Live dictation: words on the glasses while the user is still speaking.
 *
 * The client is adapted from Babel Glass (`apps/babel-glass/src/stt/provider.ts`,
 * `createWebSocketStt`): a JSON `start` frame, then raw 16 kHz s16le mono PCM
 * frames exactly as the SDK delivers them, `{"type":"stop"}` at the end.
 * The server answers `{"type":"partial","text":…}` often and
 * `{"type":"final","text":…}` at pauses.
 *
 * Why this is not the WebSocket path FieldLog dropped in 0.5:
 * - Until 0.4 the WebSocket WAS the dictation. It spoke a protocol no stock
 *   server speaks, the public build had to whitelist any ws:// host, and while
 *   the socket was not open (connecting, reconnecting) audio frames were simply
 *   not sent — those words were lost with no way back.
 * - Here the live text is only a preview on top of the batch path. Every PCM
 *   block is still kept on the phone; frames that arrive before the socket is
 *   open are queued and sent on open. If the socket does not open within 3 s or
 *   drops, nothing reconnects: the recording carries on and the kept audio goes
 *   to the stock Whisper endpoint as before. The address comes only from the
 *   private build (`VITE_LIVE_STT_URL`); the phone settings still accept only
 *   http(s), and a stored ws:// address is still dropped on load.
 */

/** One reply from the recogniser. */
export interface Transcript {
  readonly text: string;
  /** False while the recogniser may still revise this text. */
  readonly final: boolean;
}

export type LiveState = "connecting" | "live" | "lost" | "closed";

/** How long the socket may take to open before dictation goes batch-only. */
export const LIVE_CONNECT_TIMEOUT_MS = 3_000;
/** How long `finish()` waits for the server to commit the last words. */
export const LIVE_STOP_GRACE_MS = 900;
/** Live text is redrawn at most this often. */
export const LIVE_REDRAW_MS = 300;

/** Set at build time in a private build: `VITE_LIVE_STT_URL=wss://… npm run build`. */
const BUILD_LIVE_URL: string | undefined = import.meta.env?.VITE_LIVE_STT_URL as string | undefined;

/** The live server of this build, or "" (public build: dictation stays batch-only). */
export function liveSttUrl(build: string | undefined = BUILD_LIVE_URL): string {
  const url = (build ?? "").trim();
  return /^wss?:\/\/[^\s/]/i.test(url) ? url : "";
}

export interface LiveSttOptions {
  readonly url: string;
  /** BCP-47 language for the recogniser. */
  readonly language: string;
  /** Optional token, sent in the start frame, never in the URL. */
  readonly token?: string;
  readonly onTranscript: (transcript: Transcript) => void;
  /** The socket failed to open in time or dropped: the batch path takes over. */
  readonly onLost: () => void;
  readonly connectTimeoutMs?: number;
  /** Injectable for tests. */
  readonly WS?: typeof WebSocket;
}

export interface LiveStt {
  readonly state: LiveState;
  /** Feeds one PCM block. Queued until the socket is open, ignored once lost. */
  send(pcm: Uint8Array): void;
  /**
   * Asks the server for its last words and closes. Resolves true when the
   * session was live up to the stop (the live text is complete), false when it
   * never opened or dropped before (the caller falls back to batch).
   */
  finish(graceMs?: number): Promise<boolean>;
  /** Closes at once without waiting for anything (dictation abandoned). */
  abort(): void;
}

export function createLiveStt(options: LiveSttOptions): LiveStt {
  const WS = options.WS ?? WebSocket;
  let state: LiveState = "connecting";
  let queue: Uint8Array[] = [];
  let stopping = false;
  let finalAfterStop: (() => void) | null = null;
  let socket: WebSocket;

  const lose = (): void => {
    if (state !== "connecting" && state !== "live") return;
    state = "lost";
    queue = [];
    clearTimeout(connectTimer);
    try { socket.close(); } catch { /* already closed */ }
    options.onLost();
  };

  try {
    socket = new WS(options.url) as unknown as WebSocket;
    socket.binaryType = "arraybuffer";
  } catch {
    // A malformed address or a blocked origin can throw right here.
    state = "lost";
    queueMicrotask(() => options.onLost());
    return {
      get state() { return state; },
      send() { /* batch only */ },
      async finish() { state = "closed"; return false; },
      abort() { state = "closed"; },
    };
  }

  const connectTimer = setTimeout(lose, options.connectTimeoutMs ?? LIVE_CONNECT_TIMEOUT_MS);

  socket.onopen = () => {
    if (state !== "connecting") return;
    clearTimeout(connectTimer);
    state = "live";
    try {
      socket.send(JSON.stringify({
        type: "start",
        language: options.language,
        sampleRate: 16_000,
        encoding: "s16le",
        stream: true,
        ...(options.token ? { token: options.token } : {}),
      }));
      // The words spoken while the socket was opening go first.
      for (const pcm of queue) socket.send(pcm);
    } catch {
      lose();
      return;
    }
    queue = [];
  };

  socket.onmessage = (event: MessageEvent) => {
    if (state !== "live") return;
    const transcript = parseTranscript(event.data);
    if (!transcript) return;
    options.onTranscript(transcript);
    if (transcript.final && stopping) finalAfterStop?.();
  };

  // An error is always followed by close; close decides.
  socket.onerror = () => undefined;

  socket.onclose = () => {
    if (stopping) return;
    lose();
  };

  return {
    get state() { return state; },
    send(pcm: Uint8Array) {
      if (state === "connecting") { queue.push(pcm); return; }
      if (state !== "live" || stopping) return;
      try { socket.send(pcm); } catch { lose(); }
    },
    async finish(graceMs = LIVE_STOP_GRACE_MS) {
      if (state !== "live") {
        clearTimeout(connectTimer);
        if (state === "connecting") { try { socket.close(); } catch { /* closing anyway */ } }
        state = "closed";
        return false;
      }
      stopping = true;
      try {
        socket.send(JSON.stringify({ type: "stop" }));
        // Wait for the committing final, but never longer than the grace time.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, graceMs);
          finalAfterStop = () => { clearTimeout(timer); resolve(); };
        });
      } catch { /* the words so far still count */ }
      finalAfterStop = null;
      state = "closed";
      try { socket.close(); } catch { /* already closed */ }
      return true;
    },
    abort() {
      clearTimeout(connectTimer);
      stopping = true;
      state = "closed";
      queue = [];
      try { socket.close(); } catch { /* already closed */ }
    },
  };
}

/** Tolerates the common reply shapes (`text`/`transcript`, `final`/`is_final`/`type`). */
export function parseTranscript(raw: unknown): Transcript | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const text = typeof value["text"] === "string"
      ? value["text"]
      : typeof value["transcript"] === "string" ? value["transcript"] : null;
    if (text === null) return null;
    const final = value["final"] === true || value["is_final"] === true || value["type"] === "final";
    return { text, final };
  } catch {
    return null;
  }
}

const tidy = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The transcript of one live dictation: all finals plus the current partial.
 * A final with empty text only clears the partial.
 */
export class LiveTranscript {
  private finals: string[] = [];
  private partial = "";

  /** Applies one reply; true when the visible text changed. */
  apply(transcript: Transcript): boolean {
    const before = this.text();
    const text = tidy(transcript.text);
    if (transcript.final) {
      if (text) this.finals.push(text);
      this.partial = "";
    } else {
      this.partial = text;
    }
    return this.text() !== before;
  }

  /** Committed text only: what the server will not revise any more. */
  committed(): string {
    return this.finals.join(" ");
  }

  /** Everything heard so far: finals joined, then the current partial. */
  text(): string {
    return [...this.finals, this.partial].filter(Boolean).join(" ");
  }
}

/** Delay before the next live redraw, so the glasses are not redrawn faster than every `minMs`. */
export function redrawDelay(lastDrawAt: number, now: number, minMs = LIVE_REDRAW_MS): number {
  return Math.max(0, lastDrawAt + minMs - now);
}
