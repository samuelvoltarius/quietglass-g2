import type { RideStop, TimeSource } from "../transit/types";
import { minutesUntil } from "../transit/types";
import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * A connection from here to somewhere, as the passenger lives it: walk, ride,
 * walk, ride, walk. Parsed from the answer of MOTIS' `/api/v1/plan`.
 *
 * Only the fields the glasses need are kept. The answer also carries a route
 * geometry, turn-by-turn steps and debug counters (130 kB for four
 * connections); none of it is read.
 */

export interface Destination {
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

export interface WalkLeg {
  readonly kind: "walk";
  /** Where the walk ends: a stop name, or the destination's own name. */
  readonly toName: string;
  readonly toLat: number;
  readonly toLon: number;
  /** True when this walk ends at the destination rather than at a stop. */
  readonly toDestination: boolean;
  /** Where the walk starts. */
  readonly fromLat: number;
  readonly fromLon: number;
  readonly metres: number;
  readonly start: Date;
  readonly end: Date;
}

export interface TransitLeg {
  readonly kind: "transit";
  /** "Bus 2", "O-Bus 10", "S3" — as a passenger says it. */
  readonly line: string;
  readonly headsign: string;
  readonly tripId: string;
  /** Boarding stop, every stop in between, and the alighting stop, in order. */
  readonly stops: readonly RideStop[];
  /** Stand or platform at the boarding stop, when known. */
  readonly boardTrack?: string;
  readonly alightTrack?: string;
}

export type Leg = WalkLeg | TransitLeg;

export interface Journey {
  readonly legs: readonly Leg[];
  readonly start: Date;
  readonly end: Date;
  /** Number of changes between vehicles, as the service counts them. */
  readonly transfers: number;
  readonly destination: Destination;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function parseTime(raw: unknown): Date | null {
  const text = asString(raw);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The name a line goes by. A bare number gets its vehicle in front ("Bus 2",
 * "O-Bus 10"), because "2" alone says nothing; "S3" or "REX 1" already do.
 */
export function lineLabel(mode: string, shortName: string, agency: string, locale: Locale): string {
  const name = shortName.trim();
  if (!name) return t(locale, "r.vehicleOther");
  if (/^\d+[A-Za-z]?$/.test(name)) {
    if (/o-?bus/i.test(agency)) return `O-Bus ${name}`;
    if (mode === "TRAM") return t(locale, "r.vehicleTram", { line: name });
    if (mode === "BUS" || mode === "COACH") return t(locale, "r.vehicleBus", { line: name });
  }
  return name;
}

function placeStop(place: Record<string, unknown>, arrival: boolean, isLive: boolean): RideStop | null {
  const name = asString(place["name"]);
  const lat = asNumber(place["lat"]);
  const lon = asNumber(place["lon"]);
  if (!name || lat === undefined || lon === undefined) return null;
  const scheduled = (arrival
    ? parseTime(place["scheduledArrival"]) ?? parseTime(place["scheduledDeparture"])
    : parseTime(place["scheduledDeparture"]) ?? parseTime(place["scheduledArrival"]));
  if (!scheduled) return null;
  const live = arrival
    ? parseTime(place["arrival"]) ?? parseTime(place["departure"])
    : parseTime(place["departure"]) ?? parseTime(place["arrival"]);
  const source: TimeSource = isLive ? "realtime" : "scheduled";
  return {
    stop: { id: asString(place["stopId"]) ?? name, name, lat, lon },
    scheduled,
    expected: (isLive ? live : null) ?? scheduled,
    source,
    cancelled: place["cancelled"] === true,
  };
}

function parseLeg(raw: unknown, destination: Destination, locale: Locale): Leg | null {
  const leg = asRecord(raw);
  const from = asRecord(leg["from"]);
  const to = asRecord(leg["to"]);
  const mode = asString(leg["mode"]) ?? "";
  const isTransit = Boolean(asString(leg["tripId"]) ?? asString(leg["routeShortName"]));

  if (!isTransit) {
    const start = parseTime(leg["startTime"]);
    const end = parseTime(leg["endTime"]);
    const toLat = asNumber(to["lat"]);
    const toLon = asNumber(to["lon"]);
    const fromLat = asNumber(from["lat"]);
    const fromLon = asNumber(from["lon"]);
    if (!start || !end || toLat === undefined || toLon === undefined || fromLat === undefined || fromLon === undefined) return null;
    // The service names the two ends of the whole trip "START" and "END".
    const atDestination = to["name"] === "END" || !asString(to["stopId"]);
    return {
      kind: "walk",
      toName: atDestination ? destination.name : (asString(to["name"]) ?? destination.name),
      toLat: atDestination ? destination.lat : toLat,
      toLon: atDestination ? destination.lon : toLon,
      toDestination: atDestination,
      fromLat, fromLon,
      metres: Math.round(asNumber(leg["distance"]) ?? 0),
      start,
      end,
    };
  }

  const isLive = leg["realTime"] === true;
  const boarding = placeStop(from, false, isLive);
  const alighting = placeStop(to, true, isLive);
  if (!boarding || !alighting) return null;
  const between = asArray(leg["intermediateStops"])
    .map((entry) => placeStop(asRecord(entry), true, isLive))
    .filter((stop): stop is RideStop => stop !== null);
  const boardTrack = asString(from["track"]) ?? asString(from["scheduledTrack"]);
  const alightTrack = asString(to["track"]) ?? asString(to["scheduledTrack"]);
  const shortName = asString(leg["routeShortName"]) ?? asString(leg["displayName"]) ?? "";

  return {
    kind: "transit",
    line: lineLabel(mode, shortName, asString(leg["agencyName"]) ?? "", locale),
    headsign: asString(leg["headsign"]) ?? alighting.stop.name,
    tripId: asString(leg["tripId"]) ?? "",
    stops: [boarding, ...between, alighting],
    ...(boardTrack ? { boardTrack } : {}),
    ...(alightTrack ? { alightTrack } : {}),
  };
}

function parseItinerary(raw: unknown, destination: Destination, locale: Locale): Journey | null {
  const itinerary = asRecord(raw);
  const start = parseTime(itinerary["startTime"]);
  const end = parseTime(itinerary["endTime"]);
  if (!start || !end) return null;
  const legs: Leg[] = [];
  for (const entry of asArray(itinerary["legs"])) {
    const leg = parseLeg(entry, destination, locale);
    if (!leg) return null; // a connection with a hole in it is worse than none
    legs.push(leg);
  }
  if (legs.length === 0) return null;
  return {
    legs, start, end, destination,
    transfers: Math.max(0, asNumber(itinerary["transfers"]) ?? legs.filter((leg) => leg.kind === "transit").length - 1),
  };
}

/** A direct walk is offered when it is about as short as the walk to a stop. */
export const MAX_DIRECT_WALK_SECONDS = 15 * 60;

/**
 * Reads the answer of `/api/v1/plan`. A walk-only option comes first when the
 * destination is a quarter of an hour away on foot: waiting for a bus to
 * cover 800 m is not a service.
 */
export function parsePlan(raw: unknown, destination: Destination, locale: Locale = "de"): readonly Journey[] {
  const record = asRecord(raw);
  const journeys = asArray(record["itineraries"])
    .map((entry) => parseItinerary(entry, destination, locale))
    .filter((journey): journey is Journey => journey !== null)
    .filter((journey) => !journey.legs.some((leg) => leg.kind === "transit" && leg.stops.every((stop) => stop.cancelled)));

  const walk = asArray(record["direct"])
    .map((entry) => parseItinerary(entry, destination, locale))
    .find((journey): journey is Journey => journey !== null
      && journey.legs.every((leg) => leg.kind === "walk")
      && journey.end.getTime() - journey.start.getTime() <= MAX_DIRECT_WALK_SECONDS * 1000);

  return walk ? [walk, ...journeys] : journeys;
}

/** The first vehicle of a connection, if there is one. */
export function firstTransit(journey: Journey): TransitLeg | undefined {
  return journey.legs.find((leg): leg is TransitLeg => leg.kind === "transit");
}

/** Boarding time of a transit leg, as the operator currently expects it. */
export function departureOf(leg: TransitLeg): Date {
  return leg.stops[0]?.expected ?? new Date(0);
}

export function arrivalOf(leg: TransitLeg): Date {
  return leg.stops[leg.stops.length - 1]?.expected ?? new Date(0);
}

/** Clock time as shown in the passenger's own timezone: "14:52". */
export function clock(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Waiting time as the board prints it: "jetzt", "4 min", "1h05". */
export function waitText(date: Date, now: Date, locale: Locale): string {
  const minutes = minutesUntil(date, now);
  if (minutes <= 0) return t(locale, "g.now");
  if (minutes >= 60) return t(locale, "g.hoursCompact", { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, "0") });
  return t(locale, "g.minutes", { minutes });
}

/** "in 4 min", or "jetzt" once it is time: a phrase that reads right inside brackets. */
export function whenPhrase(date: Date, now: Date, locale: Locale): string {
  return minutesUntil(date, now) <= 0 ? t(locale, "g.now") : t(locale, "r.in", { when: waitText(date, now, locale) });
}

/** Distance as a walker reads it: "180 m", "1,2 km". */
export function distanceText(metres: number, locale: Locale): string {
  if (metres < 1000) return `${Math.max(10, Math.round(metres / 10) * 10)} m`;
  const km = (metres / 1000).toFixed(1);
  return `${locale === "de" ? km.replace(".", ",") : km} km`;
}
