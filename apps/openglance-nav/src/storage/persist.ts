import { normalizeOverpassUrl } from "../overpass/own";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { LatLng } from "../geo/geometry";
import { DEFAULT_ROUTER_URL, type TravelMode } from "../routing/provider";
import { DEFAULT_GEOCODER_URL } from "../geocode/photon";
import type { GlassLayout } from "../glasses/view";
import { buildTtsUrl } from "../speech/server-tts";
import { clampUsableKwh, DEFAULT_USABLE_KWH } from "../car/byd";
import { buildSugarUrl } from "../sugar/glucose";
import { briefConfigured } from "../appointments/appointments";
import { DEFAULT_PEAK_RADIUS, isPeakRadius, type PeakRadiusKm } from "../peaks/peaks";
import { parseRoutes, parseTombstones, type RouteTombstone, type SavedRoute } from "../trip/saved";

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
  /**
   * Base URL of a Valhalla instance. Empty uses the free public FOSSGIS
   * server, so OpenGlance routes right after install with nothing to host.
   */
  readonly valhallaUrl: string;
  /** Base URL of a Photon instance for place search. Empty uses photon.komoot.io. */
  readonly geocoderUrl: string;
  /**
   * The user's own Overpass server (map streets, speed cameras, charging
   * stations), stored normalised (`…/api/interpreter`). Asked first; when it
   * cannot be reached the build's own one (private build) and the public
   * servers are asked. Empty = those alone.
   */
  readonly overpassUrl: string;
  /** Demonstration route instead of real routing; nothing leaves the device. */
  readonly demo: boolean;
  /** Next-turn arrow or overview map on the glasses; swipe switches. */
  readonly glassView: GlassLayout;
  /** Driving: the HUD layout ("new": big arrow right, speed left, one alert line) or the classic turn page. */
  readonly hudLayout: HudLayout;
  readonly mode: TravelMode;
  /** Saved places, so a destination can be picked without typing in the field. */
  readonly places: readonly Destination[];
  /**
   * Destinations navigated to recently that were not saved (spoken on the
   * glasses), newest first, at most MAX_RECENT. Pickable on the glasses list.
   */
  readonly recent: readonly Destination[];
  /** Routes planned on the phone and saved under a name (start, stops, destination). */
  readonly routes: readonly SavedRoute[];
  /** Saved routes deleted here, kept for a while so the deletion reaches the route store (private build). */
  readonly deletedRoutes: readonly RouteTombstone[];
  /** Selected destination id (a saved place, a recent one or a saved route), or null. */
  readonly destinationId: string | null;
  readonly invertScroll: boolean;
  /**
   * Real streets behind the overview route, loaded from OpenStreetMap
   * (Overpass) once per route. Off: the route alone, nothing extra sent.
   */
  readonly streets: boolean;
  /** Spoken turn instructions ("In 200 metres turn left"). On by default when the build has a voice server. */
  readonly announce: boolean;
  /**
   * Charging stations (OpenStreetMap via Overpass): along a planned route on
   * the phone, "charging nearby" on the glasses list, the next one while
   * driving. Off by default: nothing is asked for while it is off.
   */
  readonly chargers: boolean;
  /** "Peaks nearby" on the glasses list (OpenStreetMap via Overpass). Off by default: nothing is asked for while it is off. */
  readonly peaks: boolean;
  /** Radius of the peak search, 10, 25 or 50 km. */
  readonly peakRadiusKm: PeakRadiusKm;
  /** Facing direction when standing still (degrees, set on the phone); null = north up. */
  readonly peakFacing: number | null;
  /** Glucose in the driving HUD (own Nightscout server, private build). Default: on only when the build has an address. */
  readonly sugar: boolean;
  /** Today's appointments from the owner's Quiet Hub daemon on the glasses list (private build). Default: on only when the build has the daemon. */
  readonly appointments: boolean;
  /**
   * Neutral speed hint before fixed enforcement points (OpenStreetMap via
   * Overpass, once per route) while driving. On by default; always off in
   * Germany, where using such warnings while driving is not allowed.
   */
  readonly cameras: boolean;
  /** Usable battery of the car in kWh, for the arrival estimate (car link, private build). */
  readonly carUsableKwh: number;
  /**
   * When the running navigation was started (ms), null when none runs. The
   * phone may end the app (screen lock); on the next start the navigation to
   * the selected destination or route is picked up again.
   */
  readonly activeSince: number | null;
}

export type HudLayout = "new" | "classic";

const KEY = "quietglass.openglance.v1";

export const EMPTY_DATA: NavData = {
  valhallaUrl: "",
  geocoderUrl: "",
  overpassUrl: "",
  demo: false,
  glassView: "turns",
  hudLayout: "new",
  // Walking is the safe default: on foot, glancing at the glasses is fine.
  mode: "walking",
  places: [],
  recent: [],
  routes: [],
  deletedRoutes: [],
  destinationId: null,
  invertScroll: false,
  streets: true,
  announce: buildTtsUrl() !== "",
  chargers: false,
  peaks: false,
  peakRadiusKm: DEFAULT_PEAK_RADIUS,
  peakFacing: null,
  sugar: buildSugarUrl() !== "",
  appointments: briefConfigured(),
  cameras: true,
  carUsableKwh: DEFAULT_USABLE_KWH,
  activeSince: null,
};

export function usesMockRouter(data: NavData): boolean {
  return data.demo;
}

/** The router actually used: the user's own, or the public default. */
export function routerUrlOf(data: NavData): string {
  return data.valhallaUrl.trim() || DEFAULT_ROUTER_URL;
}

/**
 * The place search of this build: the owner's own glass-geocode (private
 * build, `VITE_GEOCODER_URL`: Photon and Nominatim at once, answers in about
 * a second) - photon.komoot.io alone took 13-15 s on 15.10.
 */
const BUILD_GEOCODER_URL = ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_GEOCODER_URL ?? "").trim();

export function geocoderUrlOf(data: NavData, build: string = BUILD_GEOCODER_URL): string {
  return data.geocoderUrl.trim() || build || DEFAULT_GEOCODER_URL;
}

export function destinationOf(data: NavData): Destination | null {
  if (!data.destinationId) return null;
  return data.places.find((p) => p.id === data.destinationId)
    ?? data.recent.find((p) => p.id === data.destinationId)
    ?? null;
}

/** The saved route selected as destination, or null. */
export function selectedRoute(data: NavData): SavedRoute | null {
  if (!data.destinationId) return null;
  return data.routes.find((r) => r.id === data.destinationId) ?? null;
}

/** Label of whatever is selected: a place or a saved route. */
export function selectionLabel(data: NavData): string | null {
  return destinationOf(data)?.label ?? selectedRoute(data)?.name ?? null;
}

/** How many recent destinations are kept. */
export const MAX_RECENT = 5;

/** Same place: within about 30 m (names repeat: three hits can all be called "Tamsweg"). */
function samePlace(a: Destination, b: Destination): boolean {
  return Math.abs(a.at.lat - b.at.lat) < 0.0003 && Math.abs(a.at.lon - b.at.lon) < 0.0003;
}

/**
 * Puts a destination at the front of the recent list and selects it. A saved
 * place is only selected (it is already in the list); an older entry for the
 * same place is replaced, and the list is cut to MAX_RECENT.
 */
export function chooseDestination(data: NavData, place: Destination): NavData {
  const saved = data.places.find((p) => p.id === place.id || samePlace(p, place));
  if (saved) return { ...data, destinationId: saved.id };
  const others = data.recent.filter((r) => r.id !== place.id && !samePlace(r, place));
  const id = data.recent.some((r) => r.id === place.id) ? place.id : nextRecentId(data);
  const entry = { id, label: place.label, at: place.at };
  return { ...data, recent: [entry, ...others].slice(0, MAX_RECENT), destinationId: id };
}

function nextRecentId(data: NavData): string {
  let n = 1;
  const taken = new Set([...data.places, ...data.recent].map((p) => p.id));
  while (taken.has("r" + n)) n++;
  return "r" + n;
}

/** Saves a place as a favourite (selected), dropping it from the recent list. */
export function saveFavorite(data: NavData, place: { label: string; at: LatLng }): NavData {
  const existing = data.places.find((p) => samePlace(p, { id: "", ...place }));
  if (existing) return { ...data, destinationId: existing.id };
  const id = nextPlaceId(data);
  return {
    ...data,
    places: [...data.places, { id, label: place.label, at: place.at }],
    recent: data.recent.filter((r) => !samePlace(r, { id, ...place })),
    destinationId: id,
  };
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
  if (!trimmed) return { valid: true, errors: [] };   // empty means the public default
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

    const readPlaces = (list: unknown): Destination[] => {
    const places: Destination[] = [];
    if (Array.isArray(list)) {
      for (const candidate of list) {
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
    return places;
    };
    const places = readPlaces(value.places);
    const recent = readPlaces(value.recent).filter((r) => !places.some((p) => p.id === r.id)).slice(0, MAX_RECENT);

    const url = (candidate: unknown): string =>
      typeof candidate === "string" && validateRouterUrl(candidate).valid ? candidate.trim() : "";
    const valhallaUrl = url(value.valhallaUrl);

    const routes = parseRoutes(value.routes);
    const destinationId = typeof value.destinationId === "string"
      && [...places, ...recent, ...routes].some((p) => p.id === value.destinationId)
      ? value.destinationId
      : null;

    return {
      valhallaUrl,
      geocoderUrl: url(value.geocoderUrl),
      overpassUrl: typeof value.overpassUrl === "string" ? normalizeOverpassUrl(value.overpassUrl) : "",
      demo: value.demo === true,
      glassView: value.glassView === "overview" ? "overview" : "turns",
      hudLayout: value.hudLayout === "classic" ? "classic" : "new",
      mode: isMode(value.mode) ? value.mode : EMPTY_DATA.mode,
      places,
      recent,
      routes,
      deletedRoutes: parseTombstones(value.deletedRoutes),
      destinationId,
      invertScroll: typeof value.invertScroll === "boolean" ? value.invertScroll : false,
      streets: typeof value.streets === "boolean" ? value.streets : EMPTY_DATA.streets,
      announce: typeof value.announce === "boolean" ? value.announce : EMPTY_DATA.announce,
      chargers: value.chargers === true,
      peaks: value.peaks === true,
      peakRadiusKm: isPeakRadius(value.peakRadiusKm) ? value.peakRadiusKm : DEFAULT_PEAK_RADIUS,
      peakFacing: typeof value.peakFacing === "number" && Number.isFinite(value.peakFacing) ? ((Math.round(value.peakFacing) % 360) + 360) % 360 : null,
      sugar: typeof value.sugar === "boolean" ? value.sugar : EMPTY_DATA.sugar,
      appointments: typeof value.appointments === "boolean" ? value.appointments : EMPTY_DATA.appointments,
      cameras: typeof value.cameras === "boolean" ? value.cameras : EMPTY_DATA.cameras,
      carUsableKwh: value.carUsableKwh === undefined ? DEFAULT_USABLE_KWH : clampUsableKwh(value.carUsableKwh),
      activeSince: typeof value.activeSince === "number" && Number.isFinite(value.activeSince) && destinationId !== null ? value.activeSince : null,
    };
  } catch {
    return EMPTY_DATA;
  }
}

function isMode(value: unknown): value is TravelMode {
  return value === "walking" || value === "cycling" || value === "driving";
}
