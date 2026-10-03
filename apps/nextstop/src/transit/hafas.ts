import type { Departure, Ride, RideStop, Stop, TransitBackend } from "./types";

/**
 * ÖBB backend.
 *
 * Austria is not in Transitous' realtime coverage — its Austrian feeds are
 * plain timetables, with live data configured for Styria alone. ÖBB's own
 * service does carry it, down to Salzburg's trolleybuses, so that is what this
 * backend talks to.
 *
 * Verified live while writing this: 9 of 12 departures at Salzburg Hbf came
 * back with a real time attached, one of them three minutes late.
 *
 * Two things to know before relying on it:
 *
 *   - This is the endpoint ÖBB's own apps use, not a published open-data API.
 *     It needs no key and no account, but nobody has promised it will keep its
 *     shape. Every field read here is treated as optional for that reason, and
 *     a backend that starts answering differently degrades to "no live data"
 *     rather than crashing.
 *   - It sends no CORS headers, so a browser discards the answer before the
 *     app sees it. Point `baseUrl` at the bundled proxy — see examples/.
 */

const DEFAULT_ENDPOINT = "http://127.0.0.1:8079/oebb";

/** Taken from hafas-client's ÖBB profile; no signature or salt is required. */
const ENVELOPE = {
  auth: { type: "AID", aid: "OWDL4fE4ixNiPBBm" },
  client: { type: "IPH", id: "OEBB", v: "6030600", name: "oebbPROD-ADHOC" },
  ver: "1.45",
  lang: "de",
} as const;

export interface HafasOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface HafasFrame {
  readonly svcResL?: readonly { readonly err?: string; readonly res?: unknown }[];
}

/**
 * HAFAS writes times as HHMMSS, optionally prefixed with a day offset, so
 * "01000500" is five past midnight *tomorrow*. Dropping that prefix would put
 * a night bus sixteen hours in the past and sort it to the top of the board.
 */
export function parseHafasTime(raw: string | undefined, onDate: Date): Date | null {
  if (!raw || raw.length < 6) return null;
  const digits = raw.padStart(8, "0");
  const dayOffset = Number(digits.slice(0, digits.length - 6)) || 0;
  const body = digits.slice(-6);
  const hours = Number(body.slice(0, 2));
  const minutes = Number(body.slice(2, 4));
  const seconds = Number(body.slice(4, 6));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const out = new Date(onDate);
  out.setHours(hours, minutes, seconds, 0);
  out.setDate(out.getDate() + dayOffset);
  return out;
}

/** HAFAS carries coordinates as integer millionths, latitude in `y`. */
function coord(crd: { x?: number; y?: number } | undefined): { lat: number; lon: number } {
  return { lat: (crd?.y ?? 0) / 1e6, lon: (crd?.x ?? 0) / 1e6 };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function yyyymmdd(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}`;
}

function hhmmss(date: Date): string {
  return `${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}`;
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

/**
 * The stand or track a service leaves from.
 *
 * HAFAS stores it as `{ type, txt }` — type "ST" for a bus stand, "PL" for a
 * railway platform — under `dPltfS` planned and `dPltfR` live. Note the
 * spelling: `dPltf`, not `dPlatf`, which the neighbouring `dPlatfCh` flag
 * makes easy to get wrong.
 */
function platform(board: Record<string, unknown>): string | undefined {
  const live = asString(asRecord(board["dPltfR"])["txt"]);
  const planned = asString(asRecord(board["dPltfS"])["txt"]);
  return live ?? planned;
}

export class HafasBackend implements TransitBackend {
  readonly id = "oebb" as const;
  readonly label = "ÖBB (Österreich, mit Echtzeit)";
  readonly hasRealtime = true;

  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: HafasOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 12000;
  }

  async #call(method: string, request: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...ENVELOPE,
          svcReqL: [{ cfg: { polyEnc: "GPA" }, meth: method, req: request }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const frame = (await response.json()) as HafasFrame;
      const service = frame.svcResL?.[0];
      // HAFAS answers 200 with an error code in the body, so the status alone
      // says nothing about whether the request actually worked.
      if (!service || (service.err && service.err !== "OK")) {
        throw new Error(`ÖBB: ${service?.err ?? "empty response"}`);
      }
      return asRecord(service.res);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A stop name with its stand in brackets reduced to the stop itself.
   *
   * "Salzburg Mirabellplatz (Schloss Mirabell)" -> "Salzburg Mirabellplatz"
   */
  static baseName(name: string): string {
    return name.replace(/\s*\([^()]*\)\s*$/, "").trim();
  }

  /**
   * Finds the stop that covers every stand of a place.
   *
   * Searching by coordinate returns individual stands, not the place they
   * belong to: standing on Mirabellplatz yields six near-identical entries
   * 35 m apart, each showing a fraction of the departures. None of them is
   * the answer to "what leaves from here". ÖBB does have a stop that
   * aggregates all of them — Mirabellplatz A to H in one board — but nothing
   * in the stand's record points at it, so it is found by name.
   *
   * The name is not always preserved: "Hanuschplatz (Griesgasse)" resolves to
   * "Ferdinand-Hanusch-Platz". Verified across four Salzburg stops.
   */
  async #masterStop(standName: string, fallback: Stop): Promise<Stop> {
    const base = HafasBackend.baseName(standName);
    if (base === standName) return fallback;
    try {
      const res = await this.#call("LocMatch", {
        input: { loc: { type: "S", name: `${base}?` }, maxLoc: 1, field: "S" },
      });
      const hit = asRecord(asArray(asRecord(res["match"])["locL"])[0]);
      const id = asString(hit["extId"]);
      const name = asString(hit["name"]);
      if (!id || !name) return fallback;
      return { id, name, ...coord(asRecord(hit["crd"]) as { x?: number; y?: number }) };
    } catch {
      // A stand's own board is incomplete but not wrong; better than nothing.
      return fallback;
    }
  }

  async nearbyStops(lat: number, lon: number, limit: number): Promise<readonly Stop[]> {
    const res = await this.#call("LocGeoPos", {
      ring: { cCrd: { x: Math.round(lon * 1e6), y: Math.round(lat * 1e6) }, maxDist: 1500, minDist: 0 },
      getStops: true,
      getPOIs: false,
      // Ask for more than requested: several results collapse into one stop
      // once their stands are folded together.
      maxLoc: Math.max(limit * 4, 12),
    });

    // Already sorted by distance, so the first stand of a name is the nearest.
    const byPlace = new Map<string, Stop>();
    for (const raw of asArray(res["locL"])) {
      const loc = asRecord(raw);
      const id = asString(loc["extId"]);
      const name = asString(loc["name"]);
      if (!id || !name) continue;
      const key = HafasBackend.baseName(name);
      if (byPlace.has(key)) continue;
      byPlace.set(key, { id, name, ...coord(asRecord(loc["crd"]) as { x?: number; y?: number }) });
    }

    const nearest = [...byPlace.values()].slice(0, limit);
    return Promise.all(nearest.map((stand) => this.#masterStop(stand.name, stand)));
  }

  async departures(stopId: string, limit: number): Promise<readonly Departure[]> {
    const now = new Date();
    const res = await this.#call("StationBoard", {
      type: "DEP",
      date: yyyymmdd(now),
      time: hhmmss(now),
      stbLoc: { type: "S", extId: stopId },
      dur: 120,
      maxJny: limit,
    });
    const products = asArray(asRecord(res["common"])["prodL"]);

    return asArray(res["jnyL"]).flatMap((raw): Departure[] => {
      const journey = asRecord(raw);
      const board = asRecord(journey["stbStop"]);
      const tripId = asString(journey["jid"]);
      if (!tripId) return [];

      const productIndex = typeof journey["prodX"] === "number" ? journey["prodX"] : -1;
      const line = asString(asRecord(products[productIndex])["name"])?.trim() ?? "?";

      const scheduled = parseHafasTime(asString(board["dTimeS"]), now);
      if (!scheduled) return [];
      const live = parseHafasTime(asString(board["dTimeR"]), now);

      return [{
        line,
        headsign: asString(journey["dirTxt"])?.trim() ?? "",
        scheduled,
        expected: live ?? scheduled,
        // A departure with no `dTimeR` is not "on time" — it is unknown, and
        // saying otherwise would invent a fact the operator never sent.
        source: live ? "realtime" : "scheduled",
        inMinutes: Math.floor(((live ?? scheduled).getTime() - now.getTime()) / 60000),
        // Platform lives in an object, and the live value wins over the
        // planned one — a train moved to another track is exactly the case
        // where the printed timetable is the wrong thing to follow.
        ...(platform(board) ? { track: platform(board) as string } : {}),
        // Cancellation flags appear only when something is actually cancelled,
        // so their absence is the normal case rather than missing data.
        cancelled: board["dCncl"] === true || journey["isCncl"] === true,
        tripId,
      }];
    });
  }

  async ride(tripId: string): Promise<Ride | null> {
    const now = new Date();
    const res = await this.#call("JourneyDetails", { jid: tripId, getPolyline: true });
    const common = asRecord(res["common"]);
    const locations = asArray(common["locL"]);
    const journey = asRecord(res["journey"]);

    const stops = asArray(journey["stopL"]).flatMap((raw): RideStop[] => {
      const entry = asRecord(raw);
      const index = typeof entry["locX"] === "number" ? entry["locX"] : -1;
      const location = asRecord(locations[index]);
      const name = asString(location["name"]);
      if (!name) return [];

      // A stop has an arrival, a departure, or both — the first stop of a ride
      // has only a departure and the last one only an arrival.
      const scheduled = parseHafasTime(
        asString(entry["aTimeS"]) ?? asString(entry["dTimeS"]), now,
      );
      if (!scheduled) return [];
      const live = parseHafasTime(asString(entry["aTimeR"]) ?? asString(entry["dTimeR"]), now);

      return [{
        stop: {
          id: asString(location["extId"]) ?? name,
          name,
          ...coord(asRecord(location["crd"]) as { x?: number; y?: number }),
        },
        scheduled,
        expected: live ?? scheduled,
        source: live ? "realtime" : "scheduled",
        cancelled: entry["aCncl"] === true || entry["dCncl"] === true,
      }];
    });

    if (stops.length === 0) return null;

    const productIndex = typeof journey["prodX"] === "number" ? journey["prodX"] : -1;
    const line = asString(asRecord(asArray(common["prodL"])[productIndex])["name"])?.trim() ?? "?";

    return {
      line,
      headsign: asString(journey["dirTxt"])?.trim() ?? stops[stops.length - 1]?.stop.name ?? "",
      stops,
    };
  }
}
