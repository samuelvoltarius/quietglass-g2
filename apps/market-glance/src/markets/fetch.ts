import { parseErrors, parsePositions, parseTimestamp, type Position, type ProviderError } from "./model";

/** `updatedAt` is the bridge's timestamp in ms (null when missing or unparseable); `errors` lists providers that failed in a partial response. */
export interface PositionsResult { readonly positions: Position[]; readonly source: "live" | "demo"; readonly updatedAt: number | null; readonly errors: ProviderError[]; }

export const DEFAULT_TIMEOUT = 8000;

/** A hung bridge must not pile up requests under the 15 s poll, so every call is aborted after `timeoutMs`. */
export async function fetchPositions(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT): Promise<PositionsResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      // The bridge explains a 502 in `{ error }`; keep that text for the phone page.
      const detail = await response.json().then((body: { error?: unknown } | null) => typeof body?.error === "string" ? `: ${body.error}` : "", () => "");
      throw new Error(`HTTP ${response.status}${detail}`);
    }
    const body = await response.json() as { positions?: unknown; source?: unknown; updatedAt?: unknown; errors?: unknown } | null;
    return { positions: parsePositions(body), source: body?.source === "live" ? "live" : "demo", updatedAt: parseTimestamp(body?.updatedAt), errors: parseErrors(body?.errors) };
  } finally {
    clearTimeout(timeout);
  }
}
