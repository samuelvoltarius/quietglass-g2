/**
 * Client for the one Quiet Hub daemon.
 *
 * All three backends sit behind this single origin: the daemon adapts
 * the agents (local and via relays), Home Assistant and Moonraker, holds the
 * tokens, and the glasses see only `/report`, `/agent/*`, `/events/read`,
 * `/home/toggle`, `/printer`. No cloud, no
 * API keys on the device.
 */
import { normalizeReport } from "./normalize";
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
    report: async () => normalizeReport(await call<HubReport>("/report")),
    ask: async (question, agentId) => {
      await call("/agent/ask", { method: "POST", body: JSON.stringify({ question, agentId, wait: false }) });
    },
    voice: async (wav, agentId) => {
      const query = `?wait=0${agentId !== undefined ? `&agentId=${encodeURIComponent(agentId)}` : ""}`;
      return call<{ question: string }>(`/agent/voice${query}`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: new Blob([wav.slice().buffer], { type: "audio/wav" }),
      });
    },
    approve: async (cardId, decision) => {
      await call("/agent/approve", { method: "POST", body: JSON.stringify({ cardId, decision }) });
    },
    cancel: async (agentId) => {
      await call("/agent/cancel", { method: "POST", body: JSON.stringify({ agentId }) });
    },
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
