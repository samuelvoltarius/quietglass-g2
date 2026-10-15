/**
 * Where the wearer is, for the Tagesstart weather.
 *
 * The phone is asked (same bridge call as Shoot Day: `getAppLocation`), the
 * answer is rounded to two decimals (about 1 km) before it leaves the app and
 * cached for 30 minutes. The briefing never waits long for it: after a short
 * timeout the request simply goes out without coordinates and the daemon uses
 * its default place.
 */

/** A position rounded to ~1 km. */
export interface Place {
  readonly lat: number;
  readonly lon: number;
}

/** What the Tagesstart can say about the location. */
export type LocateState = "pending" | "used" | "denied" | "unavailable";

export const PLACE_TTL_MS = 30 * 60_000;
export const LOCATE_TIMEOUT_MS = 4_000;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Rounded place, or null for anything that is not a real coordinate pair. */
export function roundPlace(lat: unknown, lon: unknown): Place | null {
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  // Both coordinates exactly 0 is the "no fix" value of some phones, not the Gulf of Guinea.
  if (lat === 0 && lon === 0) return null;
  return { lat: round2(lat), lon: round2(lon) };
}

/** `/brief`, `/brief?refresh=1`, with `lat`/`lon` when a place is known. */
export function briefPath(refresh: boolean, place: Place | null | undefined): string {
  const params: string[] = [];
  if (refresh) params.push("refresh=1");
  if (place) params.push(`lat=${place.lat.toFixed(2)}`, `lon=${place.lon.toFixed(2)}`);
  return params.length === 0 ? "/brief" : `/brief?${params.join("&")}`;
}

export interface FixLike {
  readonly latitude: number;
  readonly longitude: number;
}

export interface LocatorOptions {
  /** Phone location call; missing when the host has none. */
  readonly getLocation?: (() => Promise<FixLike | null | undefined>) | undefined;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
}

export interface Locator {
  /** Rounded place now (cached up to the TTL), or null. Never rejects, never waits longer than the timeout. */
  locate(): Promise<Place | null>;
  state(): LocateState;
}

export function createLocator(options: LocatorOptions): Locator {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? LOCATE_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? PLACE_TTL_MS;
  let cached: { place: Place; at: number } | null = null;
  let current: LocateState = "pending";
  let inflight: Promise<Place | null> | null = null;

  const ask = async (): Promise<Place | null> => {
    const getLocation = options.getLocation;
    if (getLocation === undefined) { current = "unavailable"; return null; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("timeout");
    try {
      const fix = await Promise.race([
        Promise.resolve().then(getLocation),
        new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), timeoutMs); }),
      ]);
      if (fix === timedOut) { current = "unavailable"; return null; }
      // The host answers null when the permission is off.
      const place = fix ? roundPlace(fix.latitude, fix.longitude) : null;
      if (place === null) { current = "denied"; return null; }
      cached = { place, at: now() };
      current = "used";
      return place;
    } catch {
      current = "denied";
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return {
    locate: async () => {
      if (cached !== null && now() - cached.at < ttlMs) { current = "used"; return cached.place; }
      inflight ??= ask().finally(() => { inflight = null; });
      return inflight;
    },
    state: () => current,
  };
}
