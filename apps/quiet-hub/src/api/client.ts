/**
 * Client for the one Quiet Hub daemon.
 *
 * All three backends sit behind this single origin: the daemon adapts
 * the agents (local and via relays), Home Assistant and Moonraker, holds the
 * tokens, and the glasses see only `/report`, `/agent/*`, `/events/read`,
 * `/home/toggle`, `/home/action`, `/home/confirm`, `/printer`, `/brief`. No cloud, no
 * API keys on the device.
 */
import { normalizeReport } from "./normalize";
import { briefPath } from "../hub/place";
import type { Brief, HomeActionResult, HubApi, HubReport, ReportCursor, SessionList } from "./types";

/** How long the client waits for a voice upload: 90 s, plus half the audio length for long dictations (16 kHz s16le). */
export function voiceTimeoutMs(wavBytes: number): number {
  return 90_000 + Math.round(Math.max(0, wavBytes - 44) / 32 / 2);
}

/** Query of a long-poll request; the daemon holds it at most `waitS` seconds. */
export function longPollPath(cursor: ReportCursor, waitS: number): string {
  return `/report?since=${encodeURIComponent(String(cursor.rev))}&boot=${encodeURIComponent(cursor.boot)}&wait=${Math.max(1, Math.min(25, Math.round(waitS)))}`;
}

export type ApiErrorKind = "network" | "timeout" | "http";

export class ApiError extends Error {
  constructor(message: string, readonly status?: number, readonly kind: ApiErrorKind = status === undefined ? "network" : "http") {
    super(message);
    this.name = "ApiError";
  }
}

/** Why the hub cannot be used - the exact reason the wearer and the phone page show. */
export type LinkProblem = "unreachable" | "unauthorized" | "timeout" | "error" | "insecure";

/** An https page (the installed Even Hub app) may not call an http:// server: mixed content is blocked silently. */
export function insecureServer(serverUrl: string, pageProtocol: string | undefined): boolean {
  return pageProtocol === "https:" && /^http:\/\//i.test(serverUrl.trim());
}

export function classifyError(error: unknown): LinkProblem {
  if (error instanceof ApiError) {
    if (error.kind === "timeout") return "timeout";
    if (error.status === 401 || error.status === 403) return "unauthorized";
    if (error.kind === "network") return "unreachable";
  }
  return "error";
}

/** Host part of the server URL (never the token), "" when unset or unparsable. */
export function serverHost(url: string): string {
  if (url.trim() === "") return "";
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  }
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetchImpl?: typeof fetch;
  /** Abort a request after this long (default 8 s; voice uploads get more). */
  readonly timeoutMs?: number;
}

export function createClient(options: ClientOptions): HubApi {
  const base = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 8000;

  const call = async <T>(path: string, init?: RequestInit, limitMs?: number): Promise<T> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.token !== undefined && options.token !== "") headers.Authorization = `Bearer ${options.token}`;
    let response: Response;
    const controller = new AbortController();
    const limit = limitMs ?? (path.startsWith("/agent/voice") ? Math.max(timeoutMs, 90_000) : timeoutMs);
    const timer = setTimeout(() => controller.abort(), limit);
    try {
      response = await fetchImpl(`${base}${path}`, { ...init, signal: controller.signal, headers: { ...headers, ...(init?.headers ?? {}) } });
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError("timeout", undefined, "timeout");
      throw new ApiError(error instanceof Error ? error.message : "network error");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
    return (await response.json()) as T;
  };

  return {
    report: async () => normalizeReport(await call<HubReport>("/report")),
    // Held by the daemon up to waitS; give it 10 s more before calling it a timeout.
    reportAfter: async (cursor, waitS) => normalizeReport(await call<HubReport>(longPollPath(cursor, waitS), undefined, Math.max(timeoutMs, waitS * 1000 + 10_000))),
    ask: async (question, agentId) => {
      await call("/agent/ask", { method: "POST", body: JSON.stringify({ question, agentId, wait: false }) });
    },
    voice: async (wav, agentId, ask = true) => {
      // ask=0: the daemon only transcribes; the wearer confirms on the glasses first.
      const query = `?wait=0${ask ? "" : "&ask=0"}${agentId !== undefined ? `&agentId=${encodeURIComponent(agentId)}` : ""}`;
      return call<{ question: string; asked?: boolean; accepted?: boolean }>(`/agent/voice${query}`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: new Blob([wav.slice().buffer], { type: "audio/wav" }),
      }, Math.max(timeoutMs, voiceTimeoutMs(wav.length)));
    },
    approve: async (cardId, decision, note) => {
      await call("/agent/approve", { method: "POST", body: JSON.stringify(note ? { cardId, decision, note } : { cardId, decision }) });
    },
    cancel: async (agentId) => {
      await call("/agent/cancel", { method: "POST", body: JSON.stringify({ agentId }) });
    },
    sessions: async (agentId) => call<SessionList>(`/agent/sessions?agentId=${encodeURIComponent(agentId)}`),
    newSession: async (agentId) => {
      await call("/agent/session/new", { method: "POST", body: JSON.stringify({ agentId }) });
    },
    selectSession: async (agentId, sessionId, title) => {
      await call("/agent/session/select", { method: "POST", body: JSON.stringify({ agentId, sessionId, title }) });
    },
    toggle: async (device) => {
      await call("/home/toggle", { method: "POST", body: JSON.stringify({ device }) });
    },
    printer: async (action) => {
      await call("/printer", { method: "POST", body: JSON.stringify({ action }) });
    },
    homeAction: async (target, action, value) => {
      const result = await call<{ ok?: boolean; confirm?: HomeActionResult["confirm"] }>("/home/action", { method: "POST", body: JSON.stringify(value === undefined ? { target, action } : { target, action, value }) });
      return result.confirm !== undefined ? { ok: true, confirm: result.confirm } : { ok: true };
    },
    homeConfirm: async (token) => {
      await call("/home/confirm", { method: "POST", body: JSON.stringify({ token }) });
    },
    // Collecting every source may take a few seconds on the daemon (each has its own timeout).
    brief: async (refresh = false, place = null) => call<Brief>(briefPath(refresh, place), undefined, Math.max(timeoutMs, 15_000)),
    readEvent: async (id, open) => {
      await call("/events/read", { method: "POST", body: JSON.stringify(open === true ? { id, open: true } : { id }) });
    },
  };
}
