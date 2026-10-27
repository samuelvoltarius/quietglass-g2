/**
 * Errors and address checks shared by the backends. A user-entered address is
 * the only network target the app has; there is no default server.
 */

export type ApiErrorCode = "timeout" | "unreachable" | "auth" | "http" | "bad-reply" | "missing" | "unsupported";

export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode, readonly status = 0) {
    super(code === "http" ? `HTTP ${status}` : code);
    this.name = "ApiError";
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") return new ApiError("timeout");
  if (error instanceof Error && error.name === "AbortError") return new ApiError("timeout");
  return new ApiError("unreachable");
}

export const DEFAULT_TIMEOUT_MS = 8_000;

export interface UrlCheck {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/** A base address the user typed: http or https (Home Assistant also ws/wss), no credentials, no query. */
export function validateUrl(url: string, allowWs = false): UrlCheck {
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, errors: ["p.err.urlRequired"] };
  try {
    const parsed = new URL(trimmed);
    const schemes = allowWs ? ["http:", "https:", "ws:", "wss:"] : ["http:", "https:"];
    if (!schemes.includes(parsed.protocol)) return { valid: false, errors: ["p.err.urlScheme"] };
    if (parsed.username || parsed.password) return { valid: false, errors: ["p.err.urlCredentials"] };
    if (parsed.search || parsed.hash) return { valid: false, errors: ["p.err.urlQuery"] };
  } catch {
    return { valid: false, errors: ["p.err.urlScheme"] };
  }
  return { valid: true, errors: [] };
}

/** Trims the address and drops trailing slashes. */
export function normaliseBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Home Assistant's HTTP base from whatever the user typed: `ws:`/`wss:` become
 * `http:`/`https:`, a pasted `/api/websocket` (or `/api`) and trailing slashes go.
 * A Nabu Casa remote address works like any other https address.
 */
export function haHttpBase(url: string): string {
  return normaliseBase(url)
    .replace(/^wss:/i, "https:")
    .replace(/^ws:/i, "http:")
    .replace(/\/api(?:\/websocket)?$/i, "")
    .replace(/\/+$/, "");
}

/** The WebSocket address of Home Assistant: same host and port, `ws:` for http, `wss:` for https, path /api/websocket. */
export function haWsUrl(url: string): string {
  return haHttpBase(url).replace(/^https:/i, "wss:").replace(/^http:/i, "ws:") + "/api/websocket";
}

export function isPlainHttp(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "ws:";
  } catch {
    return false;
  }
}

/**
 * One request with a time limit. Throws ApiError: 401/403 = auth, 404 =
 * missing, other non-2xx = http, unparsable JSON = bad-reply.
 */
export async function requestJson(doFetch: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, { ...init, cache: "no-store", signal: controller.signal });
    if (response.status === 401 || response.status === 403) throw new ApiError("auth", response.status);
    if (response.status === 404) throw new ApiError("missing", 404);
    if (!response.ok) throw new ApiError("http", response.status);
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ApiError("bad-reply", response.status);
    }
  } catch (error) {
    throw toApiError(error);
  } finally {
    clearTimeout(timer);
  }
}
