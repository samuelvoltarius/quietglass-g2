import type { LatLng } from "../geo/geometry";
import type { TravelMode } from "../routing/provider";
import type { FoundPlace, SearchOutcome } from "./photon";

/**
 * Google Maps without Google's API: OpenGlance never asks Google for
 * anything (its terms forbid using Google data for turn-by-turn navigation).
 * It only reads a link someone pasted — the coordinates are in the URL — and
 * builds a link that opens a place or route in Google Maps itself.
 */

export type MapsInput =
  /** Coordinates found in the text or link, with the place's name when the link carries one. */
  | { readonly kind: "place"; readonly at: LatLng; readonly label?: string }
  /** A link that names a place but has no coordinates: search for the name instead. */
  | { readonly kind: "query"; readonly text: string }
  /** maps.app.goo.gl and goo.gl/maps: only a server could follow the redirect. */
  | { readonly kind: "short" };

const NUM = String.raw`[-+]?\d{1,3}(?:\.\d+)?`;
const PAIR = new RegExp(String.raw`^\s*(${NUM})\s*[,;\s]\s*(${NUM})\s*$`);

function valid(lat: number, lon: number): LatLng | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** "47.8, 13.04", "47.8 13.04", "47.8;13.04" → a position; null for anything else. */
export function parseLatLng(text: string): LatLng | null {
  const match = PAIR.exec(text);
  if (!match) return null;
  // "1, 2" would also be a street number and a floor: require decimals in at least one part.
  if (!match[1]!.includes(".") && !match[2]!.includes(".")) return null;
  return valid(Number(match[1]), Number(match[2]));
}

function decode(part: string): string {
  try { return decodeURIComponent(part.replace(/\+/g, " ")).trim(); } catch { return part.replace(/\+/g, " ").trim(); }
}

/** Place name or position from one path segment / parameter value. */
function pointOf(value: string): MapsInput | null {
  const text = decode(value);
  if (!text) return null;
  const at = parseLatLng(text);
  return at ? { kind: "place", at } : { kind: "query", text };
}

/**
 * Reads what was typed or pasted into the search field. Null when it is
 * neither coordinates nor a Google Maps link: then it is an ordinary search.
 *
 * Order matters: `!3d…!4d…` is the place itself, `@lat,lng,zoom` only where
 * the map was looking, so the first wins over the second.
 */
export function parseMapsInput(input: string): MapsInput | null {
  const text = input.trim();
  if (!text) return null;
  const plain = parseLatLng(text);
  if (plain) return { kind: "place", at: plain };

  let url: URL;
  // A pasted link without its scheme ("maps.app.goo.gl/...") is read as https. Only parsed here, never
  // requested; the prefix is joined from parts because the store review rejects a bare "https://" literal.
  try { url = new URL(/^[a-z]+:\/\//i.test(text) ? text : ["https:", "", text].join("/")); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "maps.app.goo.gl" || (host === "goo.gl" && url.pathname.startsWith("/maps"))) return { kind: "short" };
  const google = /^(?:maps\.)?google\.[a-z.]+$/.test(host);
  if (!google || (!host.startsWith("maps.") && !url.pathname.startsWith("/maps"))) return null;

  const full = decode(url.pathname) + " " + url.search;
  const segments = url.pathname.split("/").filter(Boolean);
  const named = (index: number): string | undefined => {
    const raw = segments[index];
    if (!raw || raw.startsWith("@") || raw.startsWith("data=")) return undefined;
    const name = decode(raw);
    return name && !parseLatLng(name) ? name : undefined;
  };

  // Directions: the destination is the last stop of the route.
  const dirAt = segments.indexOf("dir");
  if (dirAt >= 0) {
    const destination = url.searchParams.get("destination");
    if (destination) return pointOf(destination);
    const stops = segments.slice(dirAt + 1).filter((s) => !s.startsWith("@") && !s.startsWith("data="));
    const last = stops[stops.length - 1];
    // In the data part every stop is "!1d<lng>!2d<lat>"; the last pair is the destination.
    const pairs = [...full.matchAll(new RegExp(String.raw`!1d(${NUM})!2d(${NUM})`, "g"))];
    const lastPair = pairs[pairs.length - 1];
    if (last) {
      const point = pointOf(last);
      if (point?.kind === "place") return point;
      if (lastPair) {
        const at = valid(Number(lastPair[2]), Number(lastPair[1]));
        if (at) return { kind: "place", at, ...(point?.kind === "query" ? { label: point.text } : {}) };
      }
      return point;
    }
    return null;
  }

  const placeAt = segments.indexOf("place");
  const label = placeAt >= 0 ? named(placeAt + 1) : segments[0] === "search" || segments[1] === "search" ? named(segments.indexOf("search") + 1) : undefined;
  const withLabel = (at: LatLng | null): MapsInput | null => (at ? { kind: "place", at, ...(label ? { label } : {}) } : null);

  const pin = new RegExp(String.raw`!3d(${NUM})!4d(${NUM})`).exec(full);
  if (pin) { const hit = withLabel(valid(Number(pin[1]), Number(pin[2]))); if (hit) return hit; }

  for (const key of ["q", "query", "daddr", "destination", "ll", "center", "sll"]) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    const point = pointOf(value.replace(/^loc:/i, ""));
    if (point?.kind === "place") return label && !point.label ? { ...point, label } : point;
    if (point && (key === "q" || key === "query" || key === "daddr" || key === "destination")) return label ? { kind: "query", text: label } : point;
  }

  const view = new RegExp(String.raw`@(${NUM}),(${NUM})`).exec(full);
  if (view) { const hit = withLabel(valid(Number(view[1]), Number(view[2]))); if (hit) return hit; }

  // /maps/place/Name without any position: search for the name.
  if (placeAt >= 0) {
    const raw = segments[placeAt + 1];
    if (raw) return pointOf(raw);
  }
  return null;
}

const GOOGLE_MODE: Readonly<Record<TravelMode, string>> = { driving: "driving", cycling: "bicycling", walking: "walking" };

/** Google takes at most this many stops between start and destination in a link. */
export const GOOGLE_MAX_WAYPOINTS = 9;

const coord = (p: LatLng): string => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;

/**
 * A link that opens the route in Google Maps (its documented "Maps URLs",
 * no key, no API call). Without an origin Google starts where the phone is.
 */
export function googleMapsDirUrl(route: {
  readonly origin?: LatLng | null;
  readonly destination: LatLng;
  readonly waypoints?: readonly LatLng[];
  readonly mode: TravelMode;
}): string {
  const params = [`api=1`];
  if (route.origin) params.push(`origin=${coord(route.origin)}`);
  params.push(`destination=${coord(route.destination)}`);
  const via = (route.waypoints ?? []).slice(0, GOOGLE_MAX_WAYPOINTS);
  if (via.length) params.push(`waypoints=${via.map(coord).join("%7C")}`);
  params.push(`travelmode=${GOOGLE_MODE[route.mode]}`);
  return `https://www.google.com/maps/dir/?${params.join("&")}`;
}

/**
 * Wraps the place search: a pasted link or coordinates become a result at
 * once (no search server asked), a link with only a name is searched by that
 * name, a short link is refused with its own error.
 */
export function withMapsLinks(search: (query: string) => Promise<SearchOutcome>): (query: string) => Promise<SearchOutcome> {
  return async (query) => {
    const parsed = parseMapsInput(query);
    if (!parsed) return search(query);
    if (parsed.kind === "short") return { places: [], error: "shortLink" };
    if (parsed.kind === "query") return search(parsed.text);
    const position = `${parsed.at.lat.toFixed(5)}, ${parsed.at.lon.toFixed(5)}`;
    const place: FoundPlace = { label: parsed.label ?? position, detail: parsed.label ? position : "", at: parsed.at };
    return { places: [place], error: null };
  };
}
