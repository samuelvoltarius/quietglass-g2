/**
 * Client for the one Quiet Hub daemon.
 *
 * All three backends sit behind this single origin: the daemon adapts
 * Hermes, Home Assistant and Moonraker, holds the tokens, and the glasses see
 * only `/report`, `/agent/ask`, `/events/read`, `/home/toggle`, `/printer`. No cloud, no
 * API keys on the device.
 */
import type { HubApi, HubReport } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createClient(options: ClientOptions): HubApi {
  const base = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.token !== undefined && options.token !== "") headers.Authorization = `Bearer ${options.token}`;
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : "network error");
    }
    if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
    return (await response.json()) as T;
  };

  return {
    report: () => call<HubReport>("/report"),
    ask: async (question) => (await call<{ answer: string }>("/agent/ask", {
      method: "POST",
      body: JSON.stringify({ question }),
    })).answer,
    voice: async (audio, mime) => call<{ question: string; answer: string }>("/agent/voice", {
      method: "POST",
      body: JSON.stringify({ audio, mime }),
    }),
    toggle: async (device) => {
      await call("/home/toggle", { method: "POST", body: JSON.stringify({ device }) });
    },
    printer: async (action) => {
      await call("/printer", { method: "POST", body: JSON.stringify({ action }) });
    },
    readEvent: async (id) => {
      await call("/events/read", { method: "POST", body: JSON.stringify({ id }) });
    },
  };
}
