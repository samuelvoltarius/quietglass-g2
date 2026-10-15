import { distanceMeters, formatDistance, type LatLng } from "../geo/geometry";
import { encodePolyline6 } from "../overview/route-streets";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";

/**
 * Traffic along the route (jams, closures, roadworks, accidents) from the
 * owner's own glass-traffic service (private build: `VITE_TRAFFIC_URL`;
 * empty = off, no request is ever made).
 *
 * The app sends only the route line ahead to its OWN server. That server asks
 * TomTom (key stays on the server) with boxes around the route and reads the
 * ASFINAG DATEX II feed; the glasses' position never goes to TomTom directly.
 *
 * Asked sparingly: every 2 minutes while driving with a route, and once after
 * a new route (reroute, detour) but never more often than every 15 s; one
 * request at a time; a failure waits the full interval.
 */

// Read as `import.meta.env.X` literally: the form Vite replaces at build time (and vitest can stub).
const BUILD_TRAFFIC_URL = (): string | undefined => import.meta.env.VITE_TRAFFIC_URL as string | undefined;

/** The service address of this build (`VITE_TRAFFIC_URL`); empty = feature off. */
export function buildTrafficUrl(raw: string | undefined = BUILD_TRAFFIC_URL()): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : "";
  } catch {
    return "";
  }
}

/** Poll interval while driving. */
export const TRAFFIC_POLL_MS = 2 * 60_000;
/** A new route is asked about at once, but never sooner than this after the last request. */
export const TRAFFIC_MIN_GAP_MS = 15_000;
/** Corridor either side of the route the service searches. */
export const TRAFFIC_BUFFER_M = 60;
/** Within this the jam/closure ahead outranks the speed-camera hint. */
export const TRAFFIC_NEAR_M = 3_000;
/** Further ahead than this nothing is shown while driving. */
export const TRAFFIC_SHOW_M = 30_000;
/** A detour is offered from this saving on (minutes), and only while this much delay lies ahead. */
export const DETOUR_MIN_SAVING_MIN = 5;
/** An offer stays this long; the next poll decides again. */
export const DETOUR_OFFER_MS = TRAFFIC_POLL_MS + 30_000;
/** Most points sent; the line ahead is thinned to about one point per 25 m first. */
export const MAX_TRAFFIC_POINTS = 6_000;
const TIMEOUT_MS = 12_000;

export type TrafficType = "jam" | "closure" | "roadwork" | "accident" | "other";

export interface TrafficIncident {
  readonly id: string;
  readonly type: TrafficType;
  /** Metres from the start of the line that was sent. */
  readonly alongM: number;
  readonly delayMin: number | null;
  readonly lengthKm: number | null;
  readonly text: string;
}

export interface TrafficReport {
  readonly incidents: readonly TrafficIncident[];
  /** Sum of the known delays on the line sent. */
  readonly delayMin: number;
  /** Whether any closure lies on the line. */
  readonly closure: boolean;
}

const TYPES: readonly TrafficType[] = ["jam", "closure", "roadwork", "accident", "other"];

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Reads the service's answer; anything malformed is skipped, never invented. Null = not an answer at all. */
export function parseTraffic(value: unknown): TrafficReport | null {
  const root = value as { incidents?: unknown; delayMin?: unknown } | null;
  if (!root || !Array.isArray(root.incidents)) return null;
  const incidents: TrafficIncident[] = [];
  for (const raw of root.incidents) {
    const i = raw as Record<string, unknown> | null;
    if (!i) continue;
    const type = TYPES.includes(i["type"] as TrafficType) ? (i["type"] as TrafficType) : null;
    const along = num(i["alongM"]);
    if (!type || along === null || along < 0) continue;
    const delay = num(i["delayMin"]);
    const length = num(i["lengthKm"]);
    incidents.push({
      id: typeof i["id"] === "string" ? i["id"].slice(0, 80) : String(incidents.length),
      type,
      alongM: along,
      delayMin: delay !== null && delay > 0 ? Math.round(delay) : null,
      lengthKm: length !== null && length > 0 ? length : null,
      text: typeof i["text"] === "string" ? i["text"].slice(0, 80) : "",
    });
  }
  incidents.sort((a, b) => a.alongM - b.alongM);
  const total = num(root.delayMin);
  return {
    incidents,
    delayMin: total !== null && total > 0 ? Math.round(total) : incidents.reduce((sum, i) => sum + (i.delayMin ?? 0), 0),
    closure: incidents.some((i) => i.type === "closure"),
  };
}

/** The route line from `fromIndex` on, thinned to about one point per `stepM` metres. */
export function lineAhead(shape: readonly LatLng[], fromIndex = 0, stepM = 25): LatLng[] {
  const rest = shape.slice(Math.max(0, Math.min(fromIndex, shape.length - 1)));
  if (rest.length <= 2) return rest;
  const out: LatLng[] = [rest[0]!];
  for (let i = 1; i < rest.length - 1; i++) {
    if (distanceMeters(out[out.length - 1]!, rest[i]!) >= stepM) out.push(rest[i]!);
  }
  out.push(rest[rest.length - 1]!);
  return out.length > MAX_TRAFFIC_POINTS ? out.slice(0, MAX_TRAFFIC_POINTS) : out;
}

/** The request body: the line as a six-decimal polyline (plain text, so no CORS preflight). */
export function trafficBody(line: readonly LatLng[]): string {
  return JSON.stringify({ shape: encodePolyline6(line), buffer_m: TRAFFIC_BUFFER_M });
}

export type TrafficFetch = (line: readonly LatLng[]) => Promise<TrafficReport | null>;

/** POST /traffic/route on the own service; null on any failure (the glasses then simply show no traffic). */
export function createTrafficClient(base: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init), timeoutMs = TIMEOUT_MS): TrafficFetch {
  return async (line) => {
    if (!base || line.length < 2) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}/traffic/route`, {
        method: "POST",
        // text/plain keeps it a "simple" request: no preflight (Tailscale serve adds the login).
        headers: { "Content-Type": "text/plain" },
        body: trafficBody(line),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return parseTraffic(await response.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * When to ask: never while a request is out; after a new route at once (but
 * not sooner than `minGapMs` after the last request, so a burst of reroutes
 * cannot storm the service); otherwise every `intervalMs`.
 */
export class TrafficPoller {
  private lastAt = Number.NEGATIVE_INFINITY;
  private lastRoute = -1;
  private busy = false;

  constructor(private readonly intervalMs = TRAFFIC_POLL_MS, private readonly minGapMs = TRAFFIC_MIN_GAP_MS) {}

  due(route: number, now: number): boolean {
    if (this.busy) return false;
    if (route !== this.lastRoute) return now - this.lastAt >= this.minGapMs;
    return now - this.lastAt >= this.intervalMs;
  }

  begin(route: number, now: number): void {
    this.busy = true;
    this.lastAt = now;
    this.lastRoute = route;
  }

  end(): void {
    this.busy = false;
  }

  reset(): void {
    this.lastRoute = -1;
  }
}

/** The traffic on the route now: the report and how far along the route its line started. */
export interface TrafficState {
  readonly route: number;
  readonly startAlong: number;
  readonly report: TrafficReport;
}

/** What the HUD shows about the next relevant incident ahead. */
export interface TrafficAhead {
  readonly type: TrafficType;
  readonly distance: number;
  readonly delayMin: number | null;
}

/** Roadworks and others count only when they cost time; jams, closures and accidents always. */
function relevant(incident: TrafficIncident): boolean {
  if (incident.type === "jam" || incident.type === "closure" || incident.type === "accident") return true;
  return (incident.delayMin ?? 0) >= 2;
}

/** The first relevant incident ahead of `alongNow` (metres along the route), within TRAFFIC_SHOW_M. */
export function trafficAhead(state: TrafficState | null, alongNow: number): TrafficAhead | null {
  if (!state) return null;
  for (const incident of state.report.incidents) {
    const distance = state.startAlong + incident.alongM - alongNow;
    // Already in it (a few hundred metres past its start): no point announcing it any more.
    if (distance < -200 || !relevant(incident)) continue;
    if (distance > TRAFFIC_SHOW_M) return null;
    return { type: incident.type, distance: Math.max(0, distance), delayMin: incident.delayMin };
  }
  return null;
}

/** Delay of everything still ahead (minutes). */
export function delayAhead(state: TrafficState | null, alongNow: number): number {
  if (!state) return 0;
  return state.report.incidents
    .filter((i) => state.startAlong + i.alongM - alongNow >= -200)
    .reduce((sum, i) => sum + (i.delayMin ?? 0), 0);
}

function t(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  return tr(messages, locale, key, vars);
}

const TEXT_KEY: Readonly<Record<TrafficType, string>> = {
  jam: "t.jam",
  closure: "t.closure",
  roadwork: "t.roadwork",
  accident: "t.accident",
  other: "t.other",
};

/** `Stau in 4,2 km · +9 min`, `Sperre in 800 m`. */
export function trafficText(ahead: TrafficAhead, locale: Locale): string {
  const base = t(locale, TEXT_KEY[ahead.type], { d: formatDistance(ahead.distance, locale) });
  return ahead.delayMin && ahead.type !== "closure" ? base + " · " + t(locale, "t.delay", { n: ahead.delayMin }) : base;
}

/** `Umfahrung spart 7 min · Tippen`. */
export function detourText(savesMin: number, locale: Locale): string {
  return t(locale, "t.detour", { n: Math.round(savesMin) });
}

/** In the route picker: `+12 min Stau`, `Sperre`, or nothing. */
export function pickerTrafficText(report: TrafficReport | null | undefined, locale: Locale): string {
  if (!report) return "";
  if (report.closure) return t(locale, "t.pickClosure");
  return report.delayMin > 0 ? t(locale, "t.pickDelay", { n: report.delayMin }) : "";
}

export interface DetourCandidate {
  readonly durationS: number;
  readonly delayMin: number;
  /** A closure on the way counts as unusable. */
  readonly closure: boolean;
}

/**
 * Whether another way is worth offering: the current way (time left plus the
 * delay ahead, a closure counts as hopeless) against each candidate (its own
 * time plus its own delay). Returns the index of the best candidate and the
 * minutes it saves, or null below DETOUR_MIN_SAVING_MIN.
 */
export function bestDetour(currentS: number, currentDelayMin: number, currentClosed: boolean, candidates: readonly DetourCandidate[]): { index: number; savesMin: number } | null {
  if (!Number.isFinite(currentS)) return null;
  const current = currentS + currentDelayMin * 60 + (currentClosed ? 3600 : 0);
  let best: { index: number; savesMin: number } | null = null;
  candidates.forEach((c, index) => {
    if (c.closure || !Number.isFinite(c.durationS)) return;
    const saves = (current - (c.durationS + c.delayMin * 60)) / 60;
    if (saves >= DETOUR_MIN_SAVING_MIN && (!best || saves > best.savesMin)) best = { index, savesMin: Math.floor(saves) };
  });
  return best;
}
