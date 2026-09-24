import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { LatLng } from "../geo/geometry";
import type { TravelMode } from "../routing/provider";

/**
 * Configuration, stored in the Even app's per-app storage on the phone.
 *
 * No position history is kept. Where a person has been is among the most
 * sensitive data a device can hold, and this app has no reason to retain it.
 */

export interface Destination {
  readonly id: string;
  readonly label: string;
  readonly at: LatLng;
}

export interface NavData {
  /** Base URL of a Valhalla instance. Empty uses the mock router. */
  readonly valhallaUrl: string;
  readonly mode: TravelMode;
  /** Saved places, so a destination can be picked without typing in the field. */
  readonly places: readonly Destination[];
  /** Selected destination id, or null. */
  readonly destinationId: string | null;
  readonly invertScroll: boolean;
}

const KEY = "aignerlabs.openglance.v1";

export const EMPTY_DATA: NavData = {
  valhallaUrl: "",
  mode: "driving",
  places: [],
  destinationId: null,
  invertScroll: false,
};

export function usesMockRouter(data: NavData): boolean {
  return data.valhallaUrl.trim() === "";
}

export function destinationOf(data: NavData): Destination | null {
  if (!data.destinationId) return null;
  return data.places.find((p) => p.id === data.destinationId) ?? null;
}

export function nextPlaceId(data: NavData): string {
  let n = data.places.length + 1;
  const taken = new Set(data.places.map((p) => p.id));
  while (taken.has("p" + n)) n++;
  return "p" + n;
}

export function addPlace(data: NavData, place: Destination): NavData {
  return { ...data, places: [...data.places, place] };
}

export function removePlace(data: NavData, id: string): NavData {
  return {
    ...data,
    places: data.places.filter((p) => p.id !== id),
    destinationId: data.destinationId === id ? null : data.destinationId,
  };
}

export interface Check {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function validateRouterUrl(url: string): Check {
  const trimmed = url.trim();
  if (!trimmed) return { valid: true, errors: [] };   // empty means mock
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, errors: ["Router URL must start with http:// or https://."] };
    }
    return { valid: true, errors: [] };
  } catch {
    return { valid: false, errors: ["Router URL is not valid."] };
  }
}

/** Accepts "52.52, 13.405" and rejects anything outside real coordinates. */
export function parseCoordinates(text: string): LatLng | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

export async function save(bridge: EvenAppBridge, data: NavData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

export async function load(bridge: EvenAppBridge): Promise<NavData> {
  return parseData(await bridge.getLocalStorage(KEY));
}

export function parseData(raw: string): NavData {
  if (!raw) return EMPTY_DATA;
  try {
    const value = JSON.parse(raw) as Partial<NavData>;

    const places: Destination[] = [];
    if (Array.isArray(value.places)) {
      for (const candidate of value.places) {
        const p = candidate as Partial<Destination>;
        const at = p?.at as Partial<LatLng> | undefined;
        if (typeof p?.id !== "string") continue;
        if (typeof at?.lat !== "number" || typeof at?.lon !== "number") continue;
        if (at.lat < -90 || at.lat > 90 || at.lon < -180 || at.lon > 180) continue;
        places.push({
          id: p.id,
          label: typeof p.label === "string" && p.label ? p.label : p.id,
          at: { lat: at.lat, lon: at.lon },
        });
      }
    }

    const valhallaUrl = typeof value.valhallaUrl === "string"
      && validateRouterUrl(value.valhallaUrl).valid
      ? value.valhallaUrl.trim()
      : "";

    const destinationId = typeof value.destinationId === "string"
      && places.some((p) => p.id === value.destinationId)
      ? value.destinationId
      : null;

    return {
      valhallaUrl,
      mode: isMode(value.mode) ? value.mode : EMPTY_DATA.mode,
      places,
      destinationId,
      invertScroll: typeof value.invertScroll === "boolean" ? value.invertScroll : false,
    };
  } catch {
    return EMPTY_DATA;
  }
}

function isMode(value: unknown): value is TravelMode {
  return value === "walking" || value === "cycling" || value === "driving";
}
