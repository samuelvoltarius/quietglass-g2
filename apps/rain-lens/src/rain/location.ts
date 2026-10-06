import { parseCoordinates, type Coordinates } from "./api";
import { parseSavedPlace, type Place } from "./geocode";

/**
 * Where the forecast is for, decided without ever inventing a place.
 *
 * The phone location comes first unless the user picked a place or typed
 * coordinates; whatever is chosen, the others are still tried before giving
 * up. With none of them there is no forecast at all: an earlier version
 * quietly showed Salzburg labelled "LIVE", which looked right to anyone in
 * Salzburg and was simply wrong for everyone else.
 */
export type LocationMode = "phone" | "place" | "manual";
export interface ResolvedLocation { readonly position: Coordinates; readonly kind: LocationMode; readonly label: string | null; }
export interface LocationSources {
  readonly mode: LocationMode;
  readonly phoneFix: () => Promise<Coordinates | null>;
  readonly place: Place | null;
  readonly manual: Coordinates | null;
}

/** Store keys; `rainlens.auto`/`lat`/`lon` predate place search and are still read. */
export const KEYS = { mode: "rainlens.mode", auto: "rainlens.auto", place: "rainlens.place", lat: "rainlens.lat", lon: "rainlens.lon" } as const;

export function storedMode(storage: Pick<Storage, "getItem">): LocationMode {
  const mode = storage.getItem(KEYS.mode);
  if (mode === "phone" || mode === "place" || mode === "manual") return mode;
  return storage.getItem(KEYS.auto) === "false" ? "manual" : "phone";
}

export function storedSources(storage: Pick<Storage, "getItem">, phoneFix: LocationSources["phoneFix"]): LocationSources {
  return { mode: storedMode(storage), phoneFix, place: parseSavedPlace(storage.getItem(KEYS.place)), manual: parseCoordinates(storage.getItem(KEYS.lat), storage.getItem(KEYS.lon)) };
}

export async function resolveLocation(sources: LocationSources): Promise<ResolvedLocation | null> {
  const order: LocationMode[] = [sources.mode, ...(["phone", "place", "manual"] as const).filter((mode) => mode !== sources.mode)];
  for (const mode of order) {
    if (mode === "phone") { const fix = await sources.phoneFix().catch(() => null); if (fix && Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude)) return { position: { latitude: fix.latitude, longitude: fix.longitude }, kind: "phone", label: null }; }
    if (mode === "place" && sources.place) return { position: { latitude: sources.place.latitude, longitude: sources.place.longitude }, kind: "place", label: sources.place.name };
    if (mode === "manual" && sources.manual) return { position: sources.manual, kind: "manual", label: null };
  }
  return null;
}

/** What the app is doing, as far as the user needs to know. */
export type Status = "loading" | "live" | "noLocation" | "offline";

/** A failed request, in words a passenger on a bus can act on. */
export function errorKey(cause: unknown): { key: "errorTimeout" | "errorServer" | "errorOffline" | "errorData"; status?: string } {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/timed out|abort/i.test(message)) return { key: "errorTimeout" };
  const http = /HTTP (\d{3})/.exec(message); if (http) return { key: "errorServer", status: http[1] ?? "" };
  if (/fetch|network|load failed|offline/i.test(message)) return { key: "errorOffline" };
  return { key: "errorData" };
}

/** Without a real forecast to show, the glasses carry a short instruction instead of sample numbers that look real. */
export function noticeKey(status: Status, source: "live" | "demo"): "glassLoading" | "glassNoLocation" | "glassOffline" | null {
  if (source === "live") return null;
  return status === "noLocation" ? "glassNoLocation" : status === "offline" ? "glassOffline" : status === "loading" ? "glassLoading" : null;
}
