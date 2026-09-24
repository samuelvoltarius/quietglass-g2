import { reportFromValue, type SourceReport } from "./schema";

/**
 * Talks to the configured sources.
 *
 * Two transports, one shape. HTTP polling is the default because it is what a
 * five-line shell script can serve; WebSocket is offered for sources that
 * would rather push.
 */

export interface FetchOutcome {
  readonly report: SourceReport | null;
  readonly error: string | null;
  /** Non-fatal complaints about the payload. */
  readonly warnings: readonly string[];
}

export interface FetchOptions {
  readonly timeoutMs?: number;
  /** Optional bearer token. Sent as a header, never in the URL. */
  readonly token?: string;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT = 8000;

export async function fetchReport(
  url: string,
  name: string,
  options: FetchOptions = {},
): Promise<FetchOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT);

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    // A credential belongs in a header: URLs end up in logs and proxies.
    if (options.token) headers["Authorization"] = "Bearer " + options.token;

    const response = await doFetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      return { report: null, error: "HTTP " + response.status, warnings: [] };
    }

    const parsed = reportFromValue(await response.json(), name);
    return parsed.report === null
      ? { report: null, error: parsed.errors[0] ?? "Unreadable response", warnings: parsed.errors }
      : { report: parsed.report, error: null, warnings: parsed.errors };
  } catch (error) {
    return { report: null, error: describeError(error), warnings: [] };
  } finally {
    clearTimeout(timeout);
  }
}

/** Never leak a stack trace or a URL with a token into the display. */
export function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "timed out";
  if (error instanceof TypeError) return "unreachable";
  if (error instanceof Error && error.message) return error.message.slice(0, 60);
  return "failed";
}

/**
 * Backoff for a failing source: quick retries at first, then backing off so a
 * server that is down does not get hammered, capped so recovery is still
 * noticed promptly.
 */
export function backoffMs(consecutiveFailures: number, baseMs: number): number {
  if (consecutiveFailures <= 0) return baseMs;
  const grown = baseMs * Math.pow(2, Math.min(consecutiveFailures, 5));
  return Math.min(grown, 300_000);
}

export interface ActionOutcome {
  readonly ok: boolean;
  readonly error: string | null;
}

/**
 * Runs an action on a source.
 *
 * Posts to `<url>/action` with the action id. The id is sent in the body, not
 * the path, so it needs no escaping and never lands in a server log line.
 */
export async function runAction(
  url: string,
  actionId: string,
  options: FetchOptions = {},
): Promise<ActionOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.token) headers["Authorization"] = "Bearer " + options.token;

    const response = await doFetch(actionUrl(url), {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({ id: actionId }),
    });

    return response.ok
      ? { ok: true, error: null }
      : { ok: false, error: "HTTP " + response.status };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Derives the action endpoint from the status URL: the last path segment is
 * replaced with `action`, so `https://h/status` becomes `https://h/action`.
 */
export function actionUrl(statusUrl: string): string {
  try {
    const parsed = new URL(statusUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    segments.pop();
    segments.push("action");
    parsed.pathname = "/" + segments.join("/");
    parsed.search = "";
    return parsed.toString();
  } catch {
    return statusUrl.replace(/\/[^/]*$/, "") + "/action";
  }
}
