import { parseAnswer, parseFeed, parseVoice, type Answer, type AnswerResult, type HudFeed, type VoiceResult } from "./types";

/**
 * Talks to the Xaventra Even G2 endpoint: `GET /hud` (long poll),
 * `POST /hud/answer` and `POST /hud/voice`.
 *
 * Every request has a timeout, the token only ever travels in the
 * Authorization header, and errors are reduced to a short code: URLs, tokens
 * and server texts never reach the display.
 */

export interface XaventraApi {
  readonly demo: boolean;
  /** Returns at once when the server's state differs from `since`, otherwise after its wait time. */
  feed(since: string, signal: AbortSignal): Promise<HudFeed>;
  answer(cardId: string, answer: Answer): Promise<AnswerResult>;
  /**
   * WAV (16 kHz, 16-bit, mono) in; transcript and what the server did with it out.
   * `cardId` binds a spoken yes/no to the card that is on the glasses.
   */
  voice(wav: ArrayBuffer, cardId?: string): Promise<VoiceResult>;
}

export type ApiErrorCode = "timeout" | "unreachable" | "auth" | "http" | "bad-reply" | "aborted";

export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode, readonly status = 0) {
    super(code === "http" ? `HTTP ${status}` : code);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly pollTimeoutMs?: number;
  readonly voiceTimeoutMs?: number;
  /** Server-side wait of the long poll, in seconds (the daemon caps it at 25). */
  readonly pollWaitSeconds?: number;
}

export const DEFAULT_TIMEOUT_MS = 8_000;
/** The long poll waits up to 20 s on the server; this leaves room for the network. */
export const POLL_TIMEOUT_MS = 30_000;
/** The daemon's own speech budget is shorter than this. */
export const VOICE_TIMEOUT_MS = 30_000;

export function createClient(options: ClientOptions): XaventraApi {
  const base = options.baseUrl.trim().replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const wait = options.pollWaitSeconds ?? 20;

  const request = async (
    path: string, init: RequestInit, timeoutMs: number, outer?: AbortSignal,
  ): Promise<unknown> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const relay = (): void => controller.abort();
    if (outer?.aborted) relay();
    outer?.addEventListener("abort", relay, { once: true });
    const headers: Record<string, string> = { Accept: "application/json", ...(init.headers as Record<string, string> | undefined) };
    if (options.token) headers["Authorization"] = "Bearer " + options.token;
    try {
      const response = await doFetch(base + path, { ...init, headers, cache: "no-store", signal: controller.signal });
      if (response.status === 401) throw new ApiError("auth", 401);
      if (!response.ok) throw new ApiError("http", response.status);
      try {
        return await response.json();
      } catch {
        throw new ApiError("bad-reply");
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const aborted = (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
      if (aborted) throw new ApiError(timedOut ? "timeout" : "aborted");
      throw new ApiError("unreachable");
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", relay);
    }
  };

  return {
    demo: false,
    feed: async (since, signal) => {
      const query = (since ? `since=${encodeURIComponent(since)}&` : "") + `wait=${wait}`;
      const feed = parseFeed(await request(`/hud?${query}`, {}, options.pollTimeoutMs ?? POLL_TIMEOUT_MS, signal));
      if (!feed) throw new ApiError("bad-reply");
      return feed;
    },
    answer: async (cardId, answer) => parseAnswer(await request("/hud/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId, answer }),
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    voice: async (wav, cardId) => {
      const query = cardId ? `?cardId=${encodeURIComponent(cardId)}` : "";
      const result = parseVoice(await request("/hud/voice" + query, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: new Blob([wav], { type: "audio/wav" }),
      }, options.voiceTimeoutMs ?? VOICE_TIMEOUT_MS));
      if (!result) throw new ApiError("bad-reply");
      return result;
    },
  };
}

export interface UrlCheck {
  readonly valid: boolean;
  /** Message keys, see `messages.ts`. */
  readonly errors: readonly string[];
}

/** Validates the address typed on the phone. */
export function validateServerUrl(url: string): UrlCheck {
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, errors: ["p.err.urlRequired"] };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { valid: false, errors: ["p.err.urlScheme"] };
    if (parsed.username || parsed.password) return { valid: false, errors: ["p.err.urlCredentials"] };
    if (parsed.search || parsed.hash) return { valid: false, errors: ["p.err.urlQuery"] };
  } catch {
    return { valid: false, errors: ["p.err.urlInvalid"] };
  }
  return { valid: true, errors: [] };
}

export function isPlainHttp(url: string): boolean {
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

/** Loopback is reachable over http from a local dev page; nothing else is from an https page. */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}
