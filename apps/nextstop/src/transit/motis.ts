import type { Departure, Ride, RideStop, Stop, TransitBackend } from "./types";
import { metresBetween } from "./types";

/**
 * Transitous backend.
 *
 * Transitous is a community-run, provider-neutral routing service built on
 * MOTIS. It needs no key and no account, and — the reason it is here rather
 * than a commercial API — the whole thing can be run on your own machine, so
 * NextStop keeps working if the public instance ever stops.
 *
 * Coverage follows whichever timetables communities have contributed, which
 * is uneven: a region can be entirely absent, and realtime is configured for
 * only a fraction of the feeds that exist. Austria in particular is carried
 * as plain timetables, with live data for Styria alone — that gap is why the
 * ÖBB backend exists alongside this one.
 */

const DEFAULT_ENDPOINT = "https://api.transitous.org";

export interface MotisOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
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
 * Half a degree of latitude per kilometre, near enough for a search box.
 *
 * Longitude is squeezed towards the poles, so its span is widened by the
 * cosine of the latitude — without that, a box around Helsinki would be far
 * narrower on the ground than the same box around Salzburg.
 */
export function boundingBox(lat: number, lon: number, metres: number): {
  min: string; max: string;
} {
  const dLat = metres / 111320;
  const dLon = metres / (111320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return {
    min: `${lat - dLat},${lon - dLon}`,
    max: `${lat + dLat},${lon + dLon}`,
  };
}

export class MotisBackend implements TransitBackend {
  readonly id = "motis" as const;
  readonly label = "Transitous (weltweit)";
  readonly hasRealtime = false;

  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: MotisOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 12000;
  }

  async #get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(this.#baseUrl + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          // Transitous answers 403 to a request that does not say who is
          // asking — verified: no User-Agent and a bare "node" are both
          // refused, anything identifying is served. It is a volunteer-run
          // service, so naming the client is the least it deserves.
          //
          // Browsers forbid scripts from setting this header and will drop it
          // silently; there the WebView's own agent is sent, which is fine.
          // It matters for Node, where there may be no agent at all.
          "User-Agent": "NextStop/0.1 (Quietglass; +https://github.com/samuelvoltarius/quietglass)",
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async nearbyStops(lat: number, lon: number, limit: number): Promise<readonly Stop[]> {
    const box = boundingBox(lat, lon, 800);
    const raw = await this.#get("/api/v1/map/stops", box);

    const found: (Stop & { metres: number })[] = [];
    for (const entry of asArray(raw)) {
      const record = asRecord(entry);
      const id = asString(record["stopId"]);
      const name = asString(record["name"]);
      const stopLat = asNumber(record["lat"]);
      const stopLon = asNumber(record["lon"]);
      if (!id || !name || stopLat === undefined || stopLon === undefined) continue;
      found.push({
        id, name, lat: stopLat, lon: stopLon,
        metres: metresBetween(lat, lon, stopLat, stopLon),
      });
    }

    // A box query returns every platform separately — Makartplatz comes back
    // four times — so the nearest of each name is kept and the rest dropped.
    // Unlike ÖBB, the box is unsorted, so it has to be sorted first.
    found.sort((a, b) => a.metres - b.metres);
    const byName = new Map<string, Stop>();
    for (const stop of found) {
      if (byName.has(stop.name)) continue;
      byName.set(stop.name, { id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon });
    }
    return [...byName.values()].slice(0, limit);
  }

  async departures(stopId: string, limit: number): Promise<readonly Departure[]> {
    const raw = asRecord(await this.#get("/api/v1/stoptimes", {
      stopId, n: String(limit),
    }));
    const now = new Date();

    return asArray(raw["stopTimes"]).flatMap((entry): Departure[] => {
      const record = asRecord(entry);
      const place = asRecord(record["place"]);
      const tripId = asString(record["tripId"]);
      const scheduled = parseTime(place["scheduledDeparture"]);
      if (!tripId || !scheduled) return [];

      // MOTIS always fills `departure`, copying the scheduled value when it
      // has nothing live. Only `realTime` says whether it means anything.
      const isLive = record["realTime"] === true;
      const expected = (isLive ? parseTime(place["departure"]) : null) ?? scheduled;
      const track = asString(place["track"]) ?? asString(place["scheduledTrack"]);

      return [{
        line: asString(record["routeShortName"]) ?? asString(record["displayName"]) ?? "?",
        headsign: asString(record["headsign"]) ?? "",
        scheduled,
        expected,
        source: isLive ? "realtime" : "scheduled",
        inMinutes: Math.floor((expected.getTime() - now.getTime()) / 60000),
        ...(track ? { track } : {}),
        cancelled: record["cancelled"] === true || record["tripCancelled"] === true,
        tripId,
      }];
    });
  }

  async ride(tripId: string): Promise<Ride | null> {
    const raw = asRecord(await this.#get("/api/v1/trip", { tripId }));
    const leg = asRecord(asArray(raw["legs"])[0]);
    if (Object.keys(leg).length === 0) return null;

    const isLive = leg["realTime"] === true;

    // The ride is the boarding point, the stops between, and the terminus;
    // MOTIS hands them over as three separate fields.
    const places = [
      asRecord(leg["from"]),
      ...asArray(leg["intermediateStops"]).map(asRecord),
      asRecord(leg["to"]),
    ];

    const stops = places.flatMap((place): RideStop[] => {
      const name = asString(place["name"]);
      const lat = asNumber(place["lat"]);
      const lon = asNumber(place["lon"]);
      if (!name || lat === undefined || lon === undefined) return [];

      const scheduled = parseTime(place["scheduledArrival"])
        ?? parseTime(place["scheduledDeparture"]);
      if (!scheduled) return [];
      const expected = (isLive
        ? parseTime(place["arrival"]) ?? parseTime(place["departure"])
        : null) ?? scheduled;

      return [{
        stop: { id: asString(place["stopId"]) ?? name, name, lat, lon },
        scheduled,
        expected,
        source: isLive ? "realtime" : "scheduled",
        cancelled: place["cancelled"] === true,
      }];
    });

    if (stops.length === 0) return null;

    return {
      line: asString(leg["routeShortName"]) ?? asString(leg["displayName"]) ?? "?",
      headsign: asString(leg["headsign"]) ?? stops[stops.length - 1]?.stop.name ?? "",
      stops,
    };
  }
}
