import { parseState, type Action, type CarState } from "./model";

/**
 * Talks to the byd-bridge. Only CORS "simple requests": GET with a query, and
 * POST with a text/plain body, never a custom header - so no preflight. The
 * bridge authenticates through `tailscale serve` (Tailscale login), nothing to
 * send from here.
 *
 * Commands (0.7.0) always take two calls: `arm` (the bridge checks every guard,
 * sends nothing, returns a one-time value) and `confirm` with that value (the
 * second tap on the glasses). The bridge checks everything again before sending.
 */
export interface CarApi {
  readonly demo: boolean;
  /** Long-poll: resolves at once when `since` is outdated, otherwise after <= `waitS`. */
  state(since: number | null, waitS: number): Promise<CarState>;
  arm(action: Action, minutes: number | null): Promise<CommandReply>;
  confirm(action: Action, minutes: number | null, token: string): Promise<CommandReply>;
}

export interface CommandReply {
  readonly ok: boolean;
  /** Bridge refusal code ("car_on", "too_fast", ...) or null. */
  readonly error: string | null;
  /** The bridge's own refusal text; the glasses show it as it is. */
  readonly message: { readonly de: string; readonly en: string } | null;
  /** One-time value from `arm`. */
  readonly armed: string | null;
  /** Id of the sent command (`confirm`). */
  readonly id: string | null;
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
  readonly fetchImpl?: typeof fetch;
  /** Extra time on top of the long-poll wait before giving up. */
  readonly slackMs?: number;
}

export const LONG_POLL_S = 25;

export function stateUrl(base: string, since: number | null, waitS: number): string {
  const params = new URLSearchParams();
  if (since !== null) { params.set("since", String(since)); params.set("wait", String(waitS)); }
  const qs = params.toString();
  return base.trim().replace(/\/+$/, "") + "/state" + (qs ? "?" + qs : "");
}

export function createClient(options: ClientOptions): CarApi {
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const base = options.baseUrl.trim().replace(/\/+$/, "");

  const call = async (url: string, timeoutMs: number): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, { cache: "no-store", signal: controller.signal });
      if (response.status === 401 || response.status === 403) throw new ApiError("auth", response.status);
      if (!response.ok) throw new ApiError("http", response.status);
      try {
        return await response.json();
      } catch {
        throw new ApiError("bad-reply", response.status);
      }
    } catch (error) {
      throw toApiError(error);
    } finally {
      clearTimeout(timer);
    }
  };

  const command = async (body: Record<string, unknown>): Promise<CommandReply> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let status = 0;
    let raw: unknown;
    try {
      // A string body keeps it a simple request (text/plain); the bridge parses the JSON.
      const response = await doFetch(base + "/command", { method: "POST", body: JSON.stringify(body), cache: "no-store", signal: controller.signal });
      status = response.status;
      if (status === 401) throw new ApiError("auth", status);
      try {
        raw = await response.json();
      } catch {
        throw new ApiError(response.ok ? "bad-reply" : "http", status);
      }
    } catch (error) {
      throw toApiError(error);
    } finally {
      clearTimeout(timer);
    }
    return parseReply(raw, status);
  };

  return {
    demo: false,
    arm: (action, minutes) => command({ action, ...(minutes === null ? {} : { minutes }), step: "arm" }),
    confirm: (action, minutes, token) => command({ action, ...(minutes === null ? {} : { minutes }), confirm: token }),
    state: async (since, waitS) => {
      const body = await call(stateUrl(base, since, waitS), (since === null ? 0 : waitS * 1000) + (options.slackMs ?? 10_000));
      try {
        return parseState(body);
      } catch {
        throw new ApiError("bad-reply");
      }
    },
  };
}

/** A /command reply; anything odd is a refusal, never a success. */
export function parseReply(raw: unknown, status: number): CommandReply {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const m = (r["message"] && typeof r["message"] === "object" ? r["message"] : {}) as Record<string, unknown>;
  const message = typeof m["de"] === "string" && typeof m["en"] === "string" ? { de: m["de"], en: m["en"] } : null;
  const c = (r["command"] && typeof r["command"] === "object" ? r["command"] : {}) as Record<string, unknown>;
  const ok = r["ok"] === true && status >= 200 && status < 300;
  return {
    ok,
    error: ok ? null : typeof r["error"] === "string" ? r["error"] : "other",
    message,
    armed: ok && typeof r["armed"] === "string" ? r["armed"] : null,
    id: ok && typeof c["id"] === "string" ? c["id"] : null,
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
  readonly errors: readonly string[];
}

export function validateUrl(url: string): UrlCheck {
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
