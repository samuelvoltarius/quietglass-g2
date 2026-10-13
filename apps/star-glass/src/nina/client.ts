import { parseStatus, type Command, type StarStatus } from "./status";

/**
 * Talks to the Star Glass bridge (examples/star-bridge.mjs) on the imaging
 * computer. Requests carry no custom header unless a token is set, so the
 * status GET stays a CORS "simple request" without a preflight.
 */
export interface StarApi {
  readonly demo: boolean;
  status(): Promise<StarStatus>;
  /** PNG bytes of the newest frame (288 x 144, grayscale). */
  preview(key: string): Promise<Uint8Array>;
  command(command: Command): Promise<void>;
}

export type ApiErrorCode = "timeout" | "unreachable" | "auth" | "http" | "bad-reply" | "refused";

export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode, readonly status = 0, readonly detail = "") {
    super(code === "http" ? `HTTP ${status}` : code);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export const DEFAULT_TIMEOUT_MS = 6_000;

export function createClient(options: ClientOptions): StarApi {
  const base = options.baseUrl.trim().replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  const call = async (path: string, init: RequestInit = {}, timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (options.token) headers["Authorization"] = "Bearer " + options.token;
    try {
      const response = await doFetch(base + path, { ...init, headers, cache: "no-store", signal: controller.signal });
      if (response.status === 401) throw new ApiError("auth", 401);
      return response;
    } catch (error) {
      throw toApiError(error);
    } finally {
      clearTimeout(timer);
    }
  };

  const json = async (response: Response): Promise<Record<string, unknown>> => {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(response.ok ? "bad-reply" : "http", response.status);
    }
    const value = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (response.status === 403 || response.status === 409) throw new ApiError("refused", response.status, typeof value["error"] === "string" ? value["error"] : "");
    if (!response.ok) throw new ApiError("http", response.status);
    return value;
  };

  return {
    demo: false,
    status: async () => parseStatus(await json(await call("/api/star"))),
    preview: async (key) => {
      const response = await call("/api/star/preview.png?k=" + encodeURIComponent(key), {}, 12_000);
      if (!response.ok) throw new ApiError("http", response.status);
      return new Uint8Array(await response.arrayBuffer());
    },
    command: async (command) => {
      const reply = await json(await call("/api/star/cmd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      }));
      if (reply["ok"] !== true) throw new ApiError("refused", 0, typeof reply["error"] === "string" ? reply["error"] : "");
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

export function validateBridgeUrl(url: string): UrlCheck {
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

export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}
