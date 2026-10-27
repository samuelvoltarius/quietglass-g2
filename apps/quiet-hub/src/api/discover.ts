/**
 * Self-discovery of the hub (0.11): a private build carries a candidate list
 * (`VITE_HUB_CANDIDATES=https://pi…:8443,https://other…:8443`, the Pi first), the app tries
 * them in order, keeps the one that answers and looks again when it stops answering. Nobody
 * types an address or a token: the daemon signs the glasses in by their Tailscale login.
 * The public build has no list and stays with the phone setup (QR / address field).
 */

/** Candidate list of a private build; [] in the public build. */
export function hubCandidates(raw: string | undefined = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_HUB_CANDIDATES): string[] {
  return String(raw ?? "")
    .split(",")
    .map((part) => normalizeUrl(part))
    .filter((url, index, all) => url !== "" && all.indexOf(url) === index);
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** The address that worked last time first, then the list in its own order. */
export function probeOrder(candidates: readonly string[], remembered: string): string[] {
  const last = normalizeUrl(remembered);
  return candidates.includes(last) ? [last, ...candidates.filter((url) => url !== last)] : [...candidates];
}

/**
 * Discovery owns the address only while it is one of its own (or none is set): an address
 * the wearer set on the phone (QR, typed) is never replaced.
 */
export function discoveryOwns(serverUrl: string, candidates: readonly string[]): boolean {
  if (candidates.length === 0) return false;
  const url = normalizeUrl(serverUrl);
  return url === "" || candidates.includes(url);
}

/** First candidate whose probe answers, tried one after the other; null = none answered. */
export async function discoverHub(order: readonly string[], probe: (url: string) => Promise<boolean>): Promise<string | null> {
  for (const url of order) {
    try {
      if (await probe(url)) return url;
    } catch {
      // Next one.
    }
  }
  return null;
}

/** Look again after this many failed polls in a row (the backoff makes that ~17 s). */
export const REDISCOVER_AFTER_FAILS = 3;
