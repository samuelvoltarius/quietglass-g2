import { parsePositions, type Position } from "./model";

export interface PositionsResult { readonly positions: Position[]; readonly source: "live" | "demo"; }

export const DEFAULT_TIMEOUT = 8000;

/** A hung bridge must not pile up requests under the 15 s poll, so every call is aborted after `timeoutMs`. */
export async function fetchPositions(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT): Promise<PositionsResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { positions?: unknown; source?: unknown } | null;
    return { positions: parsePositions(body), source: body?.source === "live" ? "live" : "demo" };
  } finally {
    clearTimeout(timeout);
  }
}
