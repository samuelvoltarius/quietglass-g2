import type { Destination } from "./journey";

/**
 * The places a passenger wants to get to: favourites with a name of their own
 * ("Heim", "Arbeit"), and one "go there now" target that is not kept as a
 * favourite.
 *
 * Where somebody lives and works is personal, so this lives only on the phone
 * (SDK per-app store, mirrored into the WebView's localStorage) and is never
 * sent anywhere except as the coordinates of a connection search.
 */

export interface Place extends Destination {
  readonly id: string;
}

export interface Places {
  readonly favorites: readonly Place[];
  /** "Ziel jetzt": the target of right now, until replaced or cleared. */
  readonly now: Destination | null;
}

export const EMPTY_PLACES: Places = { favorites: [], now: null };

/** Few enough to swipe through with a thumb; the list on the glasses is one page. */
export const MAX_FAVORITES = 8;
/** What a name may be, so it also fits on a glasses row next to the clock. */
export const MAX_NAME = 24;

export const PLACES_KEY = "quietglass.nextstop.places.v1";

/** The narrow part of the Even bridge storage needs (fakeable in tests). */
export interface PlacesBridge {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
}

function validCoordinates(lat: unknown, lon: unknown): lat is number {
  return typeof lat === "number" && typeof lon === "number"
    && Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

export function cleanName(name: string): string {
  const collapsed = name.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_NAME ? collapsed : `${collapsed.slice(0, MAX_NAME - 1).trimEnd()}…`;
}

function readDestination(value: unknown): Destination | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? cleanName(record["name"]) : "";
  if (!name || !validCoordinates(record["lat"], record["lon"])) return null;
  return { name, lat: record["lat"] as number, lon: record["lon"] as number };
}

/** Anything unreadable becomes "no places" rather than an error on the glasses. */
export function parsePlaces(raw: string | null | undefined): Places {
  if (!raw) return EMPTY_PLACES;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const seen = new Set<string>();
    const favorites: Place[] = [];
    for (const entry of Array.isArray(value["favorites"]) ? value["favorites"] : []) {
      const destination = readDestination(entry);
      const id = typeof (entry as Record<string, unknown>)?.["id"] === "string"
        ? String((entry as Record<string, unknown>)["id"]) : "";
      if (!destination || !id || seen.has(id)) continue;
      seen.add(id);
      favorites.push({ id, ...destination });
      if (favorites.length >= MAX_FAVORITES) break;
    }
    return { favorites, now: readDestination(value["now"]) };
  } catch {
    return EMPTY_PLACES;
  }
}

export function serializePlaces(places: Places): string {
  return JSON.stringify({ v: 1, favorites: places.favorites, now: places.now });
}

/**
 * Reads the SDK store first, then the WebView's own storage. The Even app's
 * WebView does not always keep window.localStorage across launches, which is
 * why the SDK store leads; the mirror covers a store that is unavailable.
 */
export async function loadPlaces(bridge: PlacesBridge): Promise<Places> {
  try {
    const fromSdk = await bridge.getLocalStorage(PLACES_KEY);
    if (fromSdk) return parsePlaces(fromSdk);
  } catch {
    // SDK store unavailable: fall through to the mirror.
  }
  try {
    return parsePlaces(globalThis.localStorage?.getItem(PLACES_KEY));
  } catch {
    return EMPTY_PLACES;
  }
}

/** Writes both copies. Resolves false only when neither could be written. */
export async function savePlaces(bridge: PlacesBridge, places: Places): Promise<boolean> {
  const text = serializePlaces(places);
  let stored = false;
  try {
    stored = (await bridge.setLocalStorage(PLACES_KEY, text)) !== false;
  } catch {
    stored = false;
  }
  try {
    globalThis.localStorage?.setItem(PLACES_KEY, text);
    stored = true;
  } catch {
    // Mirror unavailable; the SDK copy may still have worked.
  }
  return stored;
}

let counter = 0;
/** A short id that is unique within one list; time plus a counter is enough. */
export function newPlaceId(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Adds a favourite. A second entry for the very same spot renames the first instead. */
export function addFavorite(places: Places, destination: Destination, id: string = newPlaceId()): Places {
  const name = cleanName(destination.name);
  if (!name || !validCoordinates(destination.lat, destination.lon)) return places;
  const near = places.favorites.find((place) =>
    Math.abs(place.lat - destination.lat) < 0.0002 && Math.abs(place.lon - destination.lon) < 0.0002);
  if (near) return renameFavorite(places, near.id, name);
  if (places.favorites.length >= MAX_FAVORITES) return places;
  return { ...places, favorites: [...places.favorites, { id, name, lat: destination.lat, lon: destination.lon }] };
}

export function renameFavorite(places: Places, id: string, name: string): Places {
  const clean = cleanName(name);
  if (!clean) return places;
  return { ...places, favorites: places.favorites.map((place) => place.id === id ? { ...place, name: clean } : place) };
}

export function removeFavorite(places: Places, id: string): Places {
  return { ...places, favorites: places.favorites.filter((place) => place.id !== id) };
}

/** Moves a favourite one place up (-1) or down (+1). */
export function moveFavorite(places: Places, id: string, direction: -1 | 1): Places {
  const from = places.favorites.findIndex((place) => place.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= places.favorites.length) return places;
  const next = [...places.favorites];
  const [moved] = next.splice(from, 1);
  if (!moved) return places;
  next.splice(to, 0, moved);
  return { ...places, favorites: next };
}

export function setNow(places: Places, destination: Destination | null): Places {
  if (destination === null) return { ...places, now: null };
  const name = cleanName(destination.name);
  if (!name || !validCoordinates(destination.lat, destination.lon)) return places;
  return { ...places, now: { name, lat: destination.lat, lon: destination.lon } };
}

/** What the glasses list: "Ziel jetzt" first, then the favourites in order. */
export interface Target extends Destination {
  readonly id: string;
  readonly isNow: boolean;
}

export function targetsOf(places: Places): readonly Target[] {
  const targets: Target[] = places.favorites.map((place) => ({ ...place, isNow: false }));
  return places.now ? [{ id: "now", ...places.now, isNow: true }, ...targets] : targets;
}
