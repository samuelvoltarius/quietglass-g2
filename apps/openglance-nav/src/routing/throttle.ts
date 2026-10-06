/**
 * Request pacing for the free public servers.
 *
 * The FOSSGIS routing server allows at most one request per second, and both
 * it and Photon ask for fair use. OpenGlance never polls: it routes when the
 * user taps, when the destination or mode changes, and when an automatic
 * reroute is due. These helpers keep even those within the rules.
 */

/** Spacing between any two router requests: one per second, plus margin. */
export const MIN_REQUEST_INTERVAL_MS = 1_100;

/**
 * Spacing between automatic reroutes. Someone wandering beside the route —
 * a car park, a square, a GPS drifting in a street canyon — would otherwise
 * request a new route every few fixes. A tap still reroutes at once.
 */
export const MIN_AUTO_REROUTE_INTERVAL_MS = 15_000;

/** Whether an automatic (not user-requested) reroute may start now. */
export function mayAutoReroute(
  lastRouteAt: number | null,
  now: number,
  minIntervalMs = MIN_AUTO_REROUTE_INTERVAL_MS,
): boolean {
  return lastRouteAt === null || now - lastRouteAt >= minIntervalMs;
}

/**
 * Serialises callers onto a minimum spacing. `ready()` resolves when the
 * caller may send; each call books the next slot, so two quick taps go out a
 * second apart rather than together.
 */
export function createRequestGate(
  minIntervalMs = MIN_REQUEST_INTERVAL_MS,
  clock: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): { ready(): Promise<void> } {
  let next: number | null = null;
  return {
    async ready(): Promise<void> {
      const now = clock();
      const wait = next === null ? 0 : Math.max(0, next - now);
      next = now + wait + minIntervalMs;
      if (wait > 0) await sleep(wait);
    },
  };
}
