import type { LatLng } from "../geo/geometry";

/**
 * The owner's own Overpass server (private build, `VITE_OVERPASS_URL`,
 * tailnet only). The public servers answered 406/429 on the road (15.10.):
 * no streets on the map, no speed cameras. The own server holds Austria,
 * Germany and Italy, so it is asked first for places inside them; elsewhere
 * (and in the public build) the public servers are asked as before. The boxes
 * are rough (they also touch Switzerland, Slovenia, Czechia ...): there an own
 * answer without streets is not trusted and the public servers are asked too.
 */

const BUILD_OVERPASS_URL: string | undefined = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_OVERPASS_URL;

/** Rough boxes of the imported countries; a query reaching outside all of them goes to the public servers. */
export const OWN_OVERPASS_AREAS = [
  { name: "AT", south: 46.37, west: 9.53, north: 49.02, east: 17.17 },
  { name: "DE", south: 47.27, west: 5.86, north: 55.06, east: 15.04 },
  { name: "IT", south: 35.49, west: 6.62, north: 47.10, east: 18.52 },
] as const;

/**
 * An Overpass address as the app calls it: http(s) only, no query or
 * fragment, trailing slashes dropped, `/api/interpreter` appended when missing
 * (a bare host is what people type). Anything else gives "" (= not set).
 */
export function normalizeOverpassUrl(raw: string | undefined): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname || parsed.search || parsed.hash) return "";
  } catch {
    return "";
  }
  return url.endsWith("/api/interpreter") ? url : url + "/api/interpreter";
}

/** The build's own interpreter address (`VITE_OVERPASS_URL`); empty = none (public build). */
export function buildOverpassUrl(raw: string | undefined = BUILD_OVERPASS_URL): string {
  return normalizeOverpassUrl(raw);
}

/**
 * The user's own Overpass server from the phone page (22.10.2026: the public
 * servers answered 406 / not at all - a map with the route line and no
 * streets, also in the public build). Set by the app whenever its settings
 * change; read on every request, so a new address applies at once.
 */
let userOverpassUrl = "";
export function setUserOverpassUrl(raw: string | undefined): void {
  userOverpassUrl = normalizeOverpassUrl(raw);
}

function inside(point: LatLng): boolean {
  return OWN_OVERPASS_AREAS.some((a) => point.lat >= a.south && point.lat <= a.north && point.lon >= a.west && point.lon <= a.east);
}

/**
 * True for an own server (phone page or build): when it cannot be reached
 * (tailnet or home network down, being rebuilt) the public ones are still asked.
 */
export function isOwnOverpass(url: string, own: string = buildOverpassUrl(), user: string = userOverpassUrl): boolean {
  return (own !== "" && url === own) || (user !== "" && url === user);
}

/**
 * Servers to ask for a query about `points` (a line, a box's corners or a
 * centre), in order: the user's server from the phone page (its area is not
 * known, so always), the build's own one when its countries cover all the
 * points, then the public ones. A server listed twice is asked once.
 */
export function overpassUrlsFor(points: readonly LatLng[], publicUrls: readonly string[], own: string = buildOverpassUrl(), user: string = userOverpassUrl): readonly string[] {
  const build = own && points.length > 0 && points.every(inside) ? [own] : [];
  return [...new Set([...(user ? [user] : []), ...build, ...publicUrls])];
}
