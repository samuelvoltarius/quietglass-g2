import { parseState, type Action, type CarState } from "./model";

/**
 * Talks to the byd-bridge. Only CORS "simple requests": GET with a query, and
 * POST with a text/plain body, never a custom header — so no preflight. The
 * bridge authenticates through `tailscale serve` (Tailscale login), nothing to
 * send from here.
 */
export interface CarApi {
  readonly demo: boolean;
  /** Long-poll: resolves at once when `since` is outdated, otherwise after <= `waitS`. */
  state(since: number | null, waitS: number): Promise<CarState>;
  command(action: Action, value: number | null): Promise<CommandReply>;
}

export interface CommandReply {
  readonly ok: boolean;
  /** Bridge error code ("busy", "not_parked", ...) when refused. */
  readonly error: string | null;
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

  const call = async (url: string, init: RequestInit, timeoutMs: number, accept: (status: number) => boolean): Promise<{ status: number; body: unknown }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, { ...init, cache: "no-store", signal: controller.signal });
      if (response.status === 401 || (response.status === 403 && !accept(403))) throw new ApiError("auth", response.status);
      if (!response.ok && !accept(response.status)) throw new ApiError("http", response.status);
      try {
        return { status: response.status, body: await response.json() };
      } catch {
        throw new ApiError("bad-reply", response.status);
      }
    } catch (error) {
      throw toApiError(error);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    demo: false,
    state: async (since, waitS) => {
      const { body } = await call(stateUrl(base, since, waitS), {}, (since === null ? 0 : waitS * 1000) + (options.slackMs ?? 10_000), () => false);
      try {
        return parseState(body);
      } catch {
        throw new ApiError("bad-reply");
      }
    },
    command: async (action, value) => {
      // text/plain keeps it a simple request (no preflight); the bridge parses the JSON.
      const { body } = await call(base + "/command", {
        method: "POST",
        body: JSON.stringify(value === null ? { action } : { action, value }),
      }, 15_000, (status) => status === 400 || status === 403 || status === 409 || status === 501);
      const reply = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
      const command = (reply["command"] && typeof reply["command"] === "object" ? reply["command"] : {}) as Record<string, unknown>;
      return {
        ok: reply["ok"] === true,
        error: typeof reply["error"] === "string" ? reply["error"] : null,
        id: typeof command["id"] === "string" ? command["id"] : null,
      };
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
