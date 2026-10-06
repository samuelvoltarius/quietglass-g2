import {
  parseCallSheet, parseEquipment, parsePrompter, parseShotList, parseTake, parseTakes,
  type CallSheet, type Equipment, type ShotList, type Take, type TakeStatus,
} from "./types";

/**
 * Talks to the Shoot Day server (examples/shoot-day-server.mjs).
 *
 * Every request has a timeout: on set the phone drops in and out of coverage,
 * and a request that never returns must not leave the glasses on "Loading…".
 * Errors are reduced to a short code; URLs and tokens never reach the display.
 */

export interface NewTake {
  readonly scene: string;
  readonly shot: string;
  readonly status: TakeStatus;
  readonly note: string;
}

export interface ShootDayApi {
  readonly demo: boolean;
  shotList(): Promise<ShotList>;
  takes(): Promise<Take[]>;
  addTake(take: NewTake): Promise<Take>;
  setTakeNote(scene: string, shot: string, n: number, note: string): Promise<void>;
  prompter(): Promise<string>;
  callSheet(): Promise<CallSheet>;
  equipment(): Promise<Equipment>;
  setPacked(name: string, packed: boolean): Promise<void>;
  /** WAV in, recognised text out. `language` is a hint ("de", "en"). */
  transcribe(wav: ArrayBuffer, language: string): Promise<string>;
}

export type ApiErrorCode = "timeout" | "unreachable" | "auth" | "http" | "bad-reply";

export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode, readonly status = 0) {
    super(code === "http" ? `HTTP ${status}` : code);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  readonly baseUrl: string;
  /** Optional bearer token, sent as a header, never in the URL. */
  readonly token?: string;
  readonly timeoutMs?: number;
  /** Speech takes longer than a list lookup. */
  readonly sttTimeoutMs?: number;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

export const DEFAULT_TIMEOUT_MS = 6_000;
export const STT_TIMEOUT_MS = 20_000;

export function createClient(options: ClientOptions): ShootDayApi {
  const base = options.baseUrl.trim().replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  const request = async (path: string, init: RequestInit = {}, timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { Accept: "application/json", ...(init.headers as Record<string, string> | undefined) };
    if (options.token) headers["Authorization"] = "Bearer " + options.token;
    try {
      const response = await doFetch(base + path, { ...init, headers, cache: "no-store", signal: controller.signal });
      if (response.status === 401 || response.status === 403) throw new ApiError("auth", response.status);
      if (!response.ok) throw new ApiError("http", response.status);
      try {
        return await response.json();
      } catch {
        throw new ApiError("bad-reply");
      }
    } catch (error) {
      throw toApiError(error);
    } finally {
      clearTimeout(timer);
    }
  };

  const post = (path: string, body: unknown): Promise<unknown> =>
    request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  return {
    demo: false,
    shotList: async () => parseShotList(await request("/api/shotlist")),
    takes: async () => parseTakes(await request("/api/takes?all=1")),
    addTake: async (take) => {
      const saved = parseTake(await post("/api/take", take));
      if (!saved) throw new ApiError("bad-reply");
      return saved;
    },
    setTakeNote: async (scene, shot, n, note) => { await post("/api/take/note", { scene, shot, n, note }); },
    prompter: async () => parsePrompter(await request("/api/prompter")),
    callSheet: async () => parseCallSheet(await request("/api/dispo")),
    equipment: async () => parseEquipment(await request("/api/equipment")),
    setPacked: async (name, packed) => { await post("/api/equipment", { toggle: { name, packed } }); },
    transcribe: async (wav, language) => {
      const reply = await request("/api/stt?lang=" + encodeURIComponent(language), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([wav], { type: "application/octet-stream" }),
      }, options.sttTimeoutMs ?? STT_TIMEOUT_MS);
      const text = (reply as { text?: unknown } | null)?.text;
      return typeof text === "string" ? text.slice(0, 500) : "";
    },
  };
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new ApiError("timeout");
  if (error instanceof Error && error.name === "AbortError") return new ApiError("timeout");
  return new ApiError("unreachable");
}

export interface UrlCheck {
  readonly valid: boolean;
  /** Message keys, see `messages.ts`. */
  readonly errors: readonly string[];
}

/** Validates the server address typed on the phone. */
export function validateServerUrl(url: string): UrlCheck {
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, errors: ["p.err.urlRequired"] };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { valid: false, errors: ["p.err.urlScheme"] };
    // A password in the URL would be shown on the page and refused by fetch.
    if (parsed.username || parsed.password) return { valid: false, errors: ["p.err.urlCredentials"] };
    if (parsed.search || parsed.hash) return { valid: false, errors: ["p.err.urlQuery"] };
  } catch {
    return { valid: false, errors: ["p.err.urlInvalid"] };
  }
  return { valid: true, errors: [] };
}

export function isPlainHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:";
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
