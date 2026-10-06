/** Joins the configured bridge address and a path without doubling the slash a user may have typed. */
export function bridgeUrl(api: string, path: string): string {
  return `${api.trim().replace(/\/+$/, "")}${path}`;
}

/** Text fetch with a timeout so a hung bridge cannot leave a request pending forever. */
export async function fetchText(url: string, label: string, options: { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch } = {}): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch; const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await doFetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
    return await response.text();
  } catch (cause) {
    if (controller.signal.aborted) throw new Error(`${label} timed out`);
    throw cause;
  } finally { clearTimeout(timeout); }
}
