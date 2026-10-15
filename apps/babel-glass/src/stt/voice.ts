/**
 * 0.8.0 "Meine Stimme": voice enrollment on the user's own speech server.
 *
 * The app reads ~16 s of the user's voice through the glasses microphone (the
 * same path as the captions) and streams it as 16 kHz s16le PCM over a fresh
 * WebSocket to the same server and with the same token as the captions:
 *
 *   -> {"type":"start","voice":"enroll","token":...}   <- {"type":"voice","action":"enroll","state":"listening"}
 *   -> PCM frames, then {"type":"stop"}                 <- {"type":"voice","action":"enroll","ok":true,"seconds":..,"quality":..}
 *   -> {"type":"start","voice":"delete","token":...}    <- {"type":"voice","action":"delete","ok":true,"existed":true}
 *
 * The server keeps one voice print (a normalised ECAPA vector, biometric data)
 * in a 0600 file on that machine only; nothing is stored in the app except the
 * flag "a voice is enrolled". Captions then mark the user's own lines as
 * speaker "ME" ("Ich:"), and the letters A, B … are only the other people.
 */

/** How long the user reads. */
export const ENROLL_MS = 16_000;
/** No "listening" answer within this long: the server does not know voice profiles. */
export const ENROLL_ACK_MS = 5_000;
/** Computing the print takes a moment (one embedding per 3 s of voice). */
export const ENROLL_RESULT_MS = 15_000;
export const VOICE_COMMAND_MS = 8_000;

/** The speaker label the server sends for the enrolled user. */
export const OWNER_SPEAKER = "ME";

/** "Personen: 2/3/4/5" in the side menu; everyone in the conversation, the user included. */
export const PERSONS_MIN = 2;
export const PERSONS_MAX = 5;
export const PERSONS_DEFAULT = 2;

export function nextPersons(current: number): number {
  return current >= PERSONS_MAX || current < PERSONS_MIN ? PERSONS_MIN : current + 1;
}

export function clampPersons(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= PERSONS_MIN && value <= PERSONS_MAX
    ? value
    : PERSONS_DEFAULT;
}

/** Other people the server may tell apart: everyone minus the user when the user's voice is known. */
export function othersFor(persons: number, enrolled: boolean): number {
  return Math.max(1, clampPersons(persons) - (enrolled ? 1 : 0));
}

export type VoiceAction = "enroll" | "delete" | "status";

export type VoiceError =
  | "too_short" | "inconsistent" | "no_model" | "bad_profile" | "failed"
  /** The server never acknowledged the voice request (an older server). */
  | "unsupported"
  /** No connection, or it closed before the answer. */
  | "network"
  /** The server refused the token (close code 1008). */
  | "unauthorized"
  | "timeout";

export interface VoiceReply {
  readonly action: VoiceAction;
  readonly ok: boolean;
  /** "listening": the enrollment started. */
  readonly state?: string;
  readonly error?: VoiceError;
  readonly seconds?: number;
  readonly quality?: number;
  readonly enrolled?: boolean;
  readonly existed?: boolean;
}

const ERRORS: readonly VoiceError[] = ["too_short", "inconsistent", "no_model", "bad_profile", "failed"];

/** Reads one server message; null for anything that is not a voice reply (e.g. a caption). */
export function parseVoiceReply(raw: unknown): VoiceReply | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || value["type"] !== "voice") return null;
    const action = value["action"];
    if (action !== "enroll" && action !== "delete" && action !== "status") return null;
    const num = (key: string): number | undefined => (typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] as number : undefined);
    const error = typeof value["error"] === "string" ? (ERRORS.includes(value["error"] as VoiceError) ? value["error"] as VoiceError : "failed") : undefined;
    const seconds = num("seconds");
    const quality = num("quality");
    return {
      action,
      ok: value["ok"] === true,
      ...(typeof value["state"] === "string" ? { state: value["state"] } : {}),
      ...(error ? { error } : {}),
      ...(seconds !== undefined ? { seconds } : {}),
      ...(quality !== undefined ? { quality } : {}),
      ...(typeof value["enrolled"] === "boolean" ? { enrolled: value["enrolled"] } : {}),
      ...(typeof value["existed"] === "boolean" ? { existed: value["existed"] } : {}),
    };
  } catch {
    return null;
  }
}

export function voiceStartFrame(action: VoiceAction, token?: string): string {
  return JSON.stringify({ type: "start", voice: action, profile: "owner", sampleRate: 16_000, encoding: "s16le", ...(token ? { token } : {}) });
}

export interface VoiceConfig {
  readonly url: string;
  readonly token?: string;
  /** Injectable for tests. */
  readonly WS?: typeof WebSocket;
  readonly ackMs?: number;
  readonly resultMs?: number;
}

export interface VoiceEnrollment {
  /** True once the server said "listening"; false = unsupported or unreachable (then the mic can close). */
  readonly ready: Promise<boolean>;
  /** One PCM block from the glasses, exactly as the SDK delivered it. */
  send(pcm: Uint8Array): void;
  /** Ends the reading, waits for the stored print (or the reason it failed). */
  finish(): Promise<VoiceReply>;
  /** Drops everything; the server stores nothing. */
  cancel(): void;
}

const failed = (action: VoiceAction, error: VoiceError): VoiceReply => ({ action, ok: false, error });

export function createVoiceEnrollment(config: VoiceConfig): VoiceEnrollment {
  const WS = config.WS ?? WebSocket;
  let socket: WebSocket | null = null;
  let acked = false;
  let done = false;
  let resolveReady: (ok: boolean) => void = () => undefined;
  let resolveResult: ((reply: VoiceReply) => void) | null = null;
  let resultTimer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
  let finalReply: VoiceReply | null = null;

  const settle = (reply: VoiceReply): void => {
    if (finalReply) return;
    finalReply = reply;
    clearTimeout(resultTimer);
    resolveResult?.(reply);
    try { socket?.close(); } catch { /* closing anyway */ }
    socket = null;
  };

  const ackTimer = setTimeout(() => {
    if (!acked) { resolveReady(false); settle(failed("enroll", "unsupported")); }
  }, config.ackMs ?? ENROLL_ACK_MS);

  try {
    const ws = new WS(config.url) as WebSocket;
    socket = ws;
    ws.onopen = () => { try { ws.send(voiceStartFrame("enroll", config.token)); } catch { /* onclose follows */ } };
    ws.onmessage = (event: MessageEvent) => {
      const reply = parseVoiceReply(event.data);
      if (!reply || reply.action !== "enroll") return;   // captions from an older server: ignored
      if (reply.state === "listening") {
        acked = true;
        clearTimeout(ackTimer);
        resolveReady(true);
        return;
      }
      settle(reply);
    };
    ws.onerror = () => undefined;
    ws.onclose = (event?: CloseEvent) => {
      clearTimeout(ackTimer);
      resolveReady(acked);
      settle(failed("enroll", event?.code === 1008 ? "unauthorized" : acked ? "network" : "unsupported"));
    };
  } catch {
    clearTimeout(ackTimer);
    resolveReady(false);
    settle(failed("enroll", "network"));
  }

  return {
    ready,
    send(pcm) {
      if (!done && acked && socket && socket.readyState === 1) socket.send(pcm);
    },
    finish() {
      if (finalReply) return Promise.resolve(finalReply);
      done = true;
      return new Promise<VoiceReply>((resolve) => {
        resolveResult = resolve;
        if (!socket || socket.readyState !== 1) { settle(failed("enroll", "network")); return; }
        try { socket.send(JSON.stringify({ type: "stop" })); } catch { settle(failed("enroll", "network")); return; }
        resultTimer = setTimeout(() => settle(failed("enroll", "timeout")), config.resultMs ?? ENROLL_RESULT_MS);
      });
    },
    cancel() {
      done = true;
      clearTimeout(ackTimer);
      resolveReady(false);
      // Closed without "stop": the server drops the audio and stores nothing.
      settle(failed("enroll", "failed"));
    },
  };
}

/** "delete" or "status" on a short connection of its own. */
export function voiceCommand(config: VoiceConfig & { readonly action: "delete" | "status"; readonly timeoutMs?: number }): Promise<VoiceReply> {
  const WS = config.WS ?? WebSocket;
  return new Promise((resolve) => {
    let socket: WebSocket | null = null;
    let finished = false;
    const finish = (reply: VoiceReply): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* closing anyway */ }
      resolve(reply);
    };
    const timer = setTimeout(() => finish(failed(config.action, "unsupported")), config.timeoutMs ?? VOICE_COMMAND_MS);
    try {
      const ws = new WS(config.url) as WebSocket;
      socket = ws;
      ws.onopen = () => { try { ws.send(voiceStartFrame(config.action, config.token)); } catch { /* onclose follows */ } };
      ws.onmessage = (event: MessageEvent) => {
        const reply = parseVoiceReply(event.data);
        if (reply && reply.action === config.action) finish(reply);
      };
      ws.onerror = () => undefined;
      ws.onclose = (event?: CloseEvent) => finish(failed(config.action, event?.code === 1008 ? "unauthorized" : "network"));
    } catch {
      finish(failed(config.action, "network"));
    }
  });
}
