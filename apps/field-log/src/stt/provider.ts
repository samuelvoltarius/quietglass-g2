/**
 * Speech recognition providers.
 *
 * The interface is deliberately narrow — feed PCM, receive text — so that a
 * self-hosted Whisper, a WhisperX server or anything else speaking WebSocket
 * can be plugged in without touching the rest of the app.
 *
 * Every captioning app found for the G2 routes audio through a paid cloud
 * service. The point of this abstraction is that the default here is your own
 * machine.
 */

export interface Transcript {
  readonly text: string;
  /** False while the recogniser may still revise this text. */
  readonly final: boolean;
  /** BCP-47 tag if the provider detected one. */
  readonly language?: string;
}

export type TranscriptHandler = (transcript: Transcript) => void;
export type StatusHandler = (status: SttStatus) => void;

export type SttStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "error";

export interface SttProvider {
  readonly name: string;
  /** Opens the connection. Resolves once audio can be sent. */
  start(): Promise<void>;
  /** Feeds one PCM block, exactly as the SDK delivered it. */
  send(pcm: Uint8Array): void;
  stop(): Promise<void>;
  readonly status: SttStatus;
}

export interface SttConfig {
  /** WebSocket URL of the recognition server. */
  readonly url: string;
  /** Optional bearer token, sent in the handshake, never in the URL. */
  readonly token?: string;
  /** BCP-47 source language, or "auto". */
  readonly language: string;
  readonly onTranscript: TranscriptHandler;
  readonly onStatus?: StatusHandler;
  /** Injectable for tests. */
  readonly WS?: typeof WebSocket;
}

/**
 * Generic WebSocket recogniser.
 *
 * Wire format, chosen to be trivial to implement on the server side:
 * - a JSON `start` frame with the language,
 * - then binary frames of raw 16 kHz s16le mono PCM,
 * - server replies with JSON `{ "text": "...", "final": true|false }`.
 *
 * `faster-whisper` behind a dozen lines of Python speaks this happily.
 */
export function createWebSocketStt(config: SttConfig): SttProvider {
  const WS = config.WS ?? WebSocket;
  let socket: WebSocket | undefined;
  let status: SttStatus = "idle";
  let closing = false;
  let retry = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (next: SttStatus): void => {
    if (status === next) return;
    status = next;
    config.onStatus?.(next);
  };

  const open = (): Promise<void> =>
    new Promise((resolve) => {
      setStatus(retry === 0 ? "connecting" : "reconnecting");
      const ws = new WS(config.url);
      socket = ws as unknown as WebSocket;

      (ws as WebSocket).onopen = () => {
        retry = 0;
        setStatus("ready");
        (ws as WebSocket).send(JSON.stringify({
          type: "start",
          language: config.language,
          sampleRate: 16_000,
          encoding: "s16le",
          ...(config.token ? { token: config.token } : {}),
        }));
        resolve();
      };

      (ws as WebSocket).onmessage = (event: MessageEvent) => {
        const transcript = parseTranscript(event.data);
        if (transcript) config.onTranscript(transcript);
      };

      (ws as WebSocket).onerror = () => { setStatus("error"); };

      (ws as WebSocket).onclose = () => {
        socket = undefined;
        if (closing) { setStatus("idle"); return; }
        // Captions are live: a dropped connection must reconnect by itself,
        // because the user has no hands free to fix it.
        retry++;
        setStatus("reconnecting");
        retryTimer = setTimeout(() => { void open(); }, reconnectDelay(retry));
        resolve();
      };
    });

  return {
    name: "websocket",
    get status() { return status; },
    async start() {
      closing = false;
      retry = 0;
      await open();
    },
    send(pcm: Uint8Array) {
      if (socket && socket.readyState === 1) socket.send(pcm);
    },
    async stop() {
      closing = true;
      clearTimeout(retryTimer);
      socket?.close();
      socket = undefined;
      setStatus("idle");
    },
  };
}

export function reconnectDelay(attempt: number): number {
  return Math.min(500 * Math.pow(2, Math.max(0, attempt - 1)), 10_000);
}

/** Tolerates several common reply shapes so more servers work unmodified. */
export function parseTranscript(raw: unknown): Transcript | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const text = typeof value["text"] === "string"
      ? value["text"]
      : typeof value["transcript"] === "string"
        ? value["transcript"]
        : null;
    if (text === null) return null;

    const final = value["final"] === true
      || value["is_final"] === true
      || value["type"] === "final";

    const language = typeof value["language"] === "string" ? value["language"] : undefined;

    return { text, final, ...(language ? { language } : {}) };
  } catch {
    return null;
  }
}

/**
 * Mock recogniser for the simulator and for development without a server.
 *
 * It is clearly labelled as a mock everywhere it surfaces — it exists so the
 * UI can be exercised, never to make the app look like it is working when it
 * is not.
 */
export function createMockStt(config: Pick<SttConfig, "onTranscript" | "onStatus">): SttProvider {
  const phrases = [
    "This is the mock recogniser.",
    "It produces fixed text without a server.",
    "Configure a real speech server in the phone app.",
  ];
  let index = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let status: SttStatus = "idle";

  return {
    name: "mock",
    get status() { return status; },
    async start() {
      status = "ready";
      config.onStatus?.("ready");
      timer = setInterval(() => {
        const text = phrases[index % phrases.length] ?? "";
        index++;
        config.onTranscript({ text, final: true, language: "en" });
      }, 3000);
    },
    send() { /* the mock ignores audio by design */ },
    async stop() {
      clearInterval(timer);
      status = "idle";
      config.onStatus?.("idle");
    },
  };
}
