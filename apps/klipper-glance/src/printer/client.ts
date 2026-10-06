import { parseStatus, type Command, type PrinterStatus } from "./status";

/**
 * Talks to the Klipper Glance bridge (examples/klipper-bridge.mjs). The
 * printer itself sits on the LAN; the bridge is the one machine that can see
 * both it and the phone.
 */

export interface PrinterApi {
  readonly demo: boolean;
  status(): Promise<PrinterStatus>;
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

export function createClient(options: ClientOptions): PrinterApi {
  const base = options.baseUrl.trim().replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  const request = async (path: string, init: RequestInit = {}): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const headers: Record<string, string> = { Accept: "application/json", ...(init.headers as Record<string, string> | undefined) };
    if (options.token) headers["Authorization"] = "Bearer " + options.token;
    try {
      const response = await doFetch(base + path, { ...init, headers, cache: "no-store", signal: controller.signal });
      if (response.status === 401) throw new ApiError("auth", 401);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ApiError(response.ok ? "bad-reply" : "http", response.status);
      }
      const value = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      if (response.status === 403) throw new ApiError("refused", 403, typeof value["error"] === "string" ? value["error"] : "");
      if (!response.ok) throw new ApiError("http", response.status);
      return value;
    } catch (error) {
      throw toApiError(error);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    demo: false,
    status: async () => parseStatus(await request("/api/printer")),
    command: async (command) => {
      const reply = await request("/api/printer/cmd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
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

/**
 * An in-memory printer for `?demo=1`: a print that advances over ten minutes
 * and reacts to pause, resume and cancel. Labelled DEMO on the glasses.
 */
export function createDemoPrinter(now: () => number = Date.now): PrinterApi {
  const started = now();
  let pausedAt: number | null = null;
  let pausedTotal = 0;
  let cancelled = false;
  const elapsed = (): number => ((pausedAt ?? now()) - started - pausedTotal) / 1000;
  return {
    demo: true,
    status: async () => {
      const seconds = elapsed() + 4 * 60 * 60 * 0.42;     // starts at ~42 %
      const progress = Math.min(99, Math.round((seconds / (4 * 60 * 60)) * 100));
      return parseStatus({
        online: true,
        state: cancelled ? "cancelled" : pausedAt !== null ? "paused" : "printing",
        file: "bracket_v3.gcode",
        progress,
        layer: Math.round(progress * 1.8) + 1,
        layers: 180,
        minutesLeft: Math.round((4 * 60 * (100 - progress)) / 100),
        nozzle: { now: pausedAt !== null ? 180 : 219, target: pausedAt !== null ? 0 : 220 },
        bed: { now: 60, target: 60 },
        speed: 100,
        message: "",
        controllable: true,
      });
    },
    command: async (command) => {
      if (command === "pause" && pausedAt === null) pausedAt = now();
      if (command === "resume" && pausedAt !== null) { pausedTotal += now() - pausedAt; pausedAt = null; }
      if (command === "cancel") cancelled = true;
    },
  };
}
