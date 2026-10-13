import { parseDeviceStatus, parseEntries, parseTreatments, type PumpStatus, type Reading, type Treatments } from "./model";

/**
 * Reads Nightscout (directly, or through the Sugar Glass bridge). Only GET
 * requests without custom headers: they are CORS "simple requests" and need
 * no preflight. A token, if any, goes into the query (`?token=`), which is how
 * Nightscout accepts it; it is never logged.
 */
export interface SugarApi {
  readonly demo: boolean;
  /** Newest first. */
  readings(count: number): Promise<Reading[]>;
  pump(): Promise<PumpStatus | null>;
  treatments(sinceMs: number): Promise<Treatments>;
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
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export const DEFAULT_TIMEOUT_MS = 8_000;

export function buildUrl(base: string, path: string, query: Record<string, string>, token?: string): string {
  const params = new URLSearchParams(query);
  if (token) params.set("token", token);
  const qs = params.toString();
  return base.trim().replace(/\/+$/, "") + path + (qs ? "?" + qs : "");
}

export function createClient(options: ClientOptions): SugarApi {
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  const get = async (path: string, query: Record<string, string>): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await doFetch(buildUrl(options.baseUrl, path, query, options.token), { cache: "no-store", signal: controller.signal });
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

  return {
    demo: false,
    readings: async (count) => parseEntries(await get("/api/v1/entries/sgv.json", { count: String(count) })),
    pump: async () => parseDeviceStatus(await get("/api/v1/devicestatus.json", { count: "3" })),
    treatments: async (sinceMs) => parseTreatments(await get("/api/v1/treatments.json", {
      count: "30",
      "find[created_at][$gte]": new Date(sinceMs).toISOString(),
    })),
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
