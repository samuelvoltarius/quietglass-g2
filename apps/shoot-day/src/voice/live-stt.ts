/**
 * Live speech-to-text while you hold to speak.
 *
 * Client for the Quietglass streaming recogniser, adapted from
 * apps/babel-glass/src/stt/provider.ts (createWebSocketStt, Quietglass, MIT):
 * same wire protocol, but one session per recording and no reconnect — when
 * the socket fails, the recording falls back to the batch path (WAV upload),
 * which keeps every PCM block anyway.
 *
 * Protocol:
 * - on open: `{"type":"start","language":"de","sampleRate":16000,"encoding":"s16le","stream":true}`
 * - then binary frames of 16 kHz s16le mono PCM, exactly as the SDK delivers them
 * - on release: `{"type":"stop"}`; the server commits the last words as a final
 * - server: `{"type":"partial","text":"…","final":false}` often, and
 *   `{"type":"final","text":"…","final":true}` at pauses (`""` clears the partial)
 *
 * Full transcript = all finals joined + the current partial.
 */

/** No answer to the handshake within this time: give up, the batch path takes over. */
export const LIVE_CONNECT_TIMEOUT_MS = 3_000;
/** How long `finish()` waits for the server to commit the last words. */
export const LIVE_STOP_GRACE_MS = 900;
/** After the final that answers the stop, a short wait for a straggler. */
const LIVE_SETTLE_MS = 150;
/** PCM held back while the socket opens (≈ 10 s); older blocks are dropped from the live path only. */
const MAX_PENDING_BYTES = 16_000 * 2 * 10;

export interface LiveText {
  readonly finals: readonly string[];
  readonly partial: string;
}

export const EMPTY_LIVE_TEXT: LiveText = { finals: [], partial: "" };

/** Applies one server message to the transcript so far. */
export function applyLiveMessage(state: LiveText, message: { readonly text: string; readonly final: boolean }): LiveText {
  if (!message.final) return { finals: state.finals, partial: message.text };
  const text = message.text.trim();
  return { finals: text ? [...state.finals, text] : state.finals, partial: "" };
}

/** All finals joined plus the current partial, whitespace flattened. */
export function joinLiveText(state: LiveText): string {
  return [...state.finals, state.partial].join(" ").replace(/\s+/g, " ").trim();
}

/**
 * The newest part of a long text: at most `max` characters, cut at a word
 * boundary and marked with a leading ellipsis, so the latest words stay visible.
 */
export function tailText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(flat.length - (max - 1));
  const space = cut.indexOf(" ");
  const words = space >= 0 && space < cut.length - 1 ? cut.slice(space + 1) : cut;
  return "…" + words;
}

/** Tolerates the reply shapes of the Quietglass server (and a few common others). */
export function parseLiveMessage(raw: unknown): { text: string; final: boolean } | null {
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

export type LiveState = "connecting" | "ready" | "failed" | "closed";

export interface LiveSession {
  /** Feeds one PCM block; held back while the socket opens. */
  send(pcm: Uint8Array): void;
  readonly state: LiveState;
  /** The transcript so far. */
  text(): string;
  /**
   * Ends the utterance: asks the server to commit, waits for the last final
   * (at most the grace time) and closes. `null` = the live path failed, use the
   * batch path.
   */
  finish(): Promise<string | null>;
  /** Drops everything, closes at once. */
  cancel(): void;
}

export interface LiveOptions {
  readonly url: string;
  readonly language: string;
  /** Called with the whole transcript whenever it changed. */
  readonly onText?: (text: string) => void;
  readonly onState?: (state: LiveState) => void;
  readonly token?: string;
  readonly connectTimeoutMs?: number;
  readonly graceMs?: number;
  /** Injectable for tests. */
  readonly WS?: typeof WebSocket;
}

export function openLiveStt(options: LiveOptions): LiveSession {
  const WS = options.WS ?? globalThis.WebSocket;
  const graceMs = options.graceMs ?? LIVE_STOP_GRACE_MS;
  let state: LiveState = "connecting";
  let transcript: LiveText = EMPTY_LIVE_TEXT;
  let last = "";
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let stopping = false;
  let afterStop: (() => void) | null = null;
  let socket: WebSocket | null = null;

  const setState = (next: LiveState): void => {
    if (state === next) return;
    state = next;
    options.onState?.(next);
  };
  const close = (): void => {
    const ws = socket;
    socket = null;
    pending = [];
    pendingBytes = 0;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch { /* already closed */ }
  };
  const fail = (): void => {
    if (state === "closed" || state === "failed") return;
    // A drop after the stop keeps what was heard; before it, the batch path takes over.
    if (stopping) { afterStop?.(); return; }
    close();
    setState("failed");
  };

  if (typeof WS !== "function" || !options.url) {
    state = "failed";
    return {
      send: () => undefined, get state() { return state; }, text: () => "",
      finish: async () => null, cancel: () => undefined,
    };
  }

  try {
    socket = new WS(options.url);
    socket.binaryType = "arraybuffer";
  } catch {
    socket = null;
    state = "failed";
  }
  const connectTimer = setTimeout(() => { if (state === "connecting") fail(); }, options.connectTimeoutMs ?? LIVE_CONNECT_TIMEOUT_MS);

  if (socket) {
    socket.onopen = () => {
      clearTimeout(connectTimer);
      if (!socket || state !== "connecting") return;
      try {
        socket.send(JSON.stringify({
          type: "start", language: options.language, sampleRate: 16_000, encoding: "s16le", stream: true,
          ...(options.token ? { token: options.token } : {}),
        }));
        for (const block of pending) socket.send(block);
      } catch {
        fail();
        return;
      }
      pending = [];
      pendingBytes = 0;
      setState("ready");
    };
    socket.onmessage = (event: MessageEvent) => {
      const message = parseLiveMessage(event.data);
      if (!message) return;
      transcript = applyLiveMessage(transcript, message);
      const text = joinLiveText(transcript);
      if (text !== last) { last = text; options.onText?.(text); }
      if (stopping && message.final) afterStop?.();
    };
    socket.onerror = () => { fail(); };
    socket.onclose = () => { fail(); };
  }

  return {
    get state() { return state; },
    text: () => joinLiveText(transcript),
    send(pcm) {
      if (state === "connecting") {
        pending.push(pcm);
        pendingBytes += pcm.length;
        while (pendingBytes > MAX_PENDING_BYTES && pending.length > 1) pendingBytes -= pending.shift()?.length ?? 0;
        return;
      }
      if (state !== "ready" || !socket) return;
      try { socket.send(pcm); } catch { fail(); }
    },
    async finish() {
      clearTimeout(connectTimer);
      if (state !== "ready" || !socket) { close(); if (state !== "failed") setState("failed"); return null; }
      stopping = true;
      await new Promise<void>((resolve) => {
        let settle: ReturnType<typeof setTimeout> | undefined;
        const grace = setTimeout(done, graceMs);
        function done(): void { clearTimeout(grace); clearTimeout(settle); afterStop = null; resolve(); }
        afterStop = () => { clearTimeout(settle); settle = setTimeout(done, LIVE_SETTLE_MS); };
        try { socket?.send(JSON.stringify({ type: "stop" })); } catch { done(); }
      });
      close();
      setState("closed");
      return joinLiveText(transcript);
    },
    cancel() {
      clearTimeout(connectTimer);
      close();
      if (state !== "failed") setState("closed");
    },
  };
}

/** Recording caps: a guard against a lost release event, not a limit on what you say. */
export const MAX_COMMAND_MS = 2 * 60_000;

/** The live STT address: the phone override wins, else the private build's default, else none. */
export function liveSttUrl(override: string | undefined, buildDefault: string | undefined): string {
  const pick = (override ?? "").trim() || (buildDefault ?? "").trim();
  if (!pick) return "";
  try {
    const url = new URL(pick);
    return url.protocol === "wss:" || url.protocol === "ws:" ? pick : "";
  } catch {
    return "";
  }
}
