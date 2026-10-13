import type { Departure, Ride, Stop, TransitBackend } from "../transit/types";
import { metresBetween } from "../transit/types";
import type { Position } from "../ride/tracker";
import type { Maneuver, TurnType, WalkRoute } from "../route/walk";
import { parsePlan, type Destination, type Journey } from "../route/journey";
import type { Places } from "../route/places";
import type { Planner } from "../route/planner";
import type { GeoResult } from "../route/geocode";

/**
 * Demo mode (`?demo=1`): the simulator has no GPS and the screens that matter
 * only show up with a connection in hand, so everything here is invented from
 * one real, trimmed MOTIS answer (plan-salzburg.json) with its times shifted
 * to "now". It is off unless the parameter is present, and the phone page says
 * so; an invented connection that looked like a real one would be exactly the
 * kind of quiet lie this app exists to avoid.
 */

export interface DemoOptions {
  readonly enabled: boolean;
  /** Dev-only: jump to a screen at start. */
  readonly scene: "board" | "places" | "plans" | "guide" | "recording" | "voice" | null;
  /** Dev-only: minutes the demo clock runs ahead, to reach later guide steps. */
  readonly offsetMinutes: number;
  /** Dev-only: how many times faster than real time the demo clock runs (1 = real time). */
  readonly speed: number;
  readonly locale: "de" | "en" | null;
}

export function demoFromUrl(search: string): DemoOptions {
  const params = new URLSearchParams(search);
  const scene = params.get("scene");
  const offset = Number(params.get("t") ?? "0");
  const lang = params.get("lang");
  const speed = Number(params.get("speed") ?? "1");
  return {
    enabled: params.get("demo") === "1",
    scene: scene === "board" || scene === "places" || scene === "plans" || scene === "guide" || scene === "recording" || scene === "voice" ? scene : null,
    offsetMinutes: Number.isFinite(offset) ? offset : 0,
    speed: Number.isFinite(speed) && speed >= 1 && speed <= 120 ? speed : 1,
    locale: lang === "de" || lang === "en" ? lang : null,
  };
}

/** Salzburg, near Vogelweiderstraße: where the recorded answer starts. */
export const DEMO_POSITION = { lat: 47.8095, lon: 13.055 } as const;

export const DEMO_PLACES: Places = {
  favorites: [
    { id: "demo-home", name: "Heim", lat: 47.796, lon: 13.016 },
    { id: "demo-work", name: "Arbeit", lat: 47.8058, lon: 13.0427 },
    { id: "demo-station", name: "Hauptbahnhof", lat: 47.8130, lon: 13.0460 },
  ],
  now: { name: "Getreidegasse 10", lat: 47.8001, lon: 13.0433 },
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Moves every timestamp of an answer by the same amount, leaving the rest alone. */
export function shiftTimes(value: unknown, deltaMs: number): unknown {
  if (typeof value === "string" && ISO.test(value)) {
    return new Date(new Date(value).getTime() + deltaMs).toISOString().replace(".000Z", "Z");
  }
  if (Array.isArray(value)) return value.map((entry) => shiftTimes(entry, deltaMs));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shiftTimes(entry, deltaMs)]));
  }
  return value;
}

interface RecordedAnswer {
  itineraries: { legs: { mode: string; from: { departure?: string } }[] }[];
  direct: unknown[];
}

/**
 * Four connections: the two recorded ones, then each again a quarter of an
 * hour later, like the next departures of the same lines.
 */
export function demoJourneys(recorded: unknown, now: Date, destination: Destination, locale: "de" | "en"): readonly Journey[] {
  const answer = recorded as RecordedAnswer;
  // The recorded geometry ends at its own destination; the walk there must end where it really does.
  const end = (recorded as { to?: { lat?: number; lon?: number } }).to;
  const target: Destination = typeof end?.lat === "number" && typeof end.lon === "number"
    ? { name: destination.name, lat: end.lat, lon: end.lon }
    : destination;
  const firstBus = answer.itineraries[0]?.legs.find((leg) => leg.mode !== "WALK")?.from.departure;
  if (!firstBus) return [];
  // The first bus leaves four minutes from now.
  const delta = now.getTime() + 4 * 60000 - new Date(firstBus).getTime();
  const base = shiftTimes(answer, delta) as { itineraries: unknown[]; direct: unknown[] };
  const later = shiftTimes({ itineraries: base.itineraries }, 14 * 60000) as { itineraries: unknown[] };
  const merged = { direct: [], itineraries: [...base.itineraries, ...later.itineraries] };
  return parsePlan(merged, target, locale).slice(0, 4);
}

export function demoPlanner(recorded: unknown, clock: () => Date): Planner {
  return {
    async plan(_from, to, language) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Half a minute more than four, so the page still says "in 4 min" when it is drawn.
      return demoJourneys(recorded, new Date(clock().getTime() + 30000), to, language ?? "de");
    },
    async geocode(text): Promise<readonly GeoResult[]> {
      const entries: GeoResult[] = [
        { name: "Salzburg Hauptbahnhof", detail: "5020 Salzburg, AT", kind: "stop", lat: 47.8130, lon: 13.0460 },
        { name: "Getreidegasse 10", detail: "5020 Salzburg, AT", kind: "address", lat: 47.8001, lon: 13.0433 },
        { name: "Mirabellgarten", detail: "5020 Salzburg, AT", kind: "place", lat: 47.8049, lon: 13.0426 },
      ];
      const wanted = text.trim().toLowerCase();
      const hits = entries.filter((entry) => entry.name.toLowerCase().includes(wanted));
      return hits.length > 0 ? hits : entries;
    },
    async ride() { return null; },
  };
}

/**
 * Simulated movement through a whole connection: the walker follows each walk
 * leg in a straight line, then rides along the stops of each vehicle, on the
 * demo clock. It lets the guide run on a "GPS" that moves, in the simulator.
 */
export function demoPosition(journey: Journey, now: Date): Position {
  const t = now.getTime();
  let at: { lat: number; lon: number } = { ...DEMO_POSITION };
  for (const leg of journey.legs) {
    if (leg.kind === "walk") {
      const from = { lat: leg.fromLat, lon: leg.fromLon };
      const to = { lat: leg.toLat, lon: leg.toLon };
      const span = Math.max(1, leg.end.getTime() - leg.start.getTime());
      if (t < leg.start.getTime()) return { ...at, accuracy: 10 };
      if (t <= leg.end.getTime()) {
        const f = (t - leg.start.getTime()) / span;
        return { lat: from.lat + (to.lat - from.lat) * f, lon: from.lon + (to.lon - from.lon) * f, accuracy: 10 };
      }
      at = to;
    } else {
      const first = leg.stops[0];
      const last = leg.stops[leg.stops.length - 1];
      if (!first || !last) continue;
      if (t < first.expected.getTime()) return { ...at, accuracy: 10 };
      if (t <= last.expected.getTime()) {
        for (let i = 1; i < leg.stops.length; i += 1) {
          const a = leg.stops[i - 1]!;
          const b = leg.stops[i]!;
          if (t <= b.expected.getTime()) {
            const f = (t - a.expected.getTime()) / Math.max(1, b.expected.getTime() - a.expected.getTime());
            return {
              lat: a.stop.lat + (b.stop.lat - a.stop.lat) * f,
              lon: a.stop.lon + (b.stop.lon - a.stop.lon) * f,
              accuracy: 10,
            };
          }
        }
      }
      at = { lat: last.stop.lat, lon: last.stop.lon };
    }
  }
  return { ...at, accuracy: 10 };
}

/**
 * An invented walking route for the demo: along the north-south line first,
 * then along the east-west one, with the turn in between and made-up street
 * names. Real routes come from Valhalla; this one only has to look like one.
 */
export function demoWalkRoute(from: { lat: number; lon: number }, to: { lat: number; lon: number }): WalkRoute {
  const corner = { lat: to.lat, lon: from.lon };
  const points: { lat: number; lon: number }[] = [];
  const leg = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): void => {
    const metres = Math.max(1, metresBetween(a.lat, a.lon, b.lat, b.lon));
    const steps = Math.max(1, Math.round(metres / 20));
    for (let i = points.length === 0 ? 0 : 1; i <= steps; i += 1) {
      points.push({ lat: a.lat + ((b.lat - a.lat) * i) / steps, lon: a.lon + ((b.lon - a.lon) * i) / steps });
    }
  };
  leg(from, corner);
  const cornerIndex = points.length - 1;
  leg(corner, to);
  const along = [0];
  for (let i = 1; i < points.length; i += 1) {
    along.push(along[i - 1]! + metresBetween(points[i - 1]!.lat, points[i - 1]!.lon, points[i]!.lat, points[i]!.lon));
  }
  // Heading north then east is a right turn; north then west, a left one.
  const turn: TurnType = to.lon >= from.lon ? (to.lat >= from.lat ? "right" : "left") : (to.lat >= from.lat ? "left" : "right");
  const total = along[along.length - 1]!;
  const toCorner = along[cornerIndex]!;
  const maneuvers: Maneuver[] = [{ type: "depart", length: toCorner, shapeIndex: 0 }];
  if (toCorner > 15 && total - toCorner > 15) {
    maneuvers.push({ type: turn, street: "Linzer Gasse", length: total - toCorner, shapeIndex: cornerIndex });
  }
  maneuvers.push({ type: "arrive", length: 0, shapeIndex: points.length - 1 });
  return { shape: points, maneuvers, along, distance: total, duration: total / 1.3 };
}

/** A tiny offline board, so `?demo=1` shows something on the departures page too. */
export function demoBackend(clock: () => Date): TransitBackend {
  const stop: Stop = { id: "demo-mirabell", name: "Salzburg Mirabellplatz", lat: 47.8058, lon: 13.0430 };
  const at = (minutes: number): Date => new Date(clock().getTime() + minutes * 60000);
  const make = (line: string, headsign: string, minutes: number, track: string, live: boolean): Departure => ({
    line, headsign, scheduled: at(minutes), expected: at(minutes), source: live ? "realtime" : "scheduled",
    inMinutes: minutes, track, cancelled: false, tripId: `demo-${line}-${minutes}`,
  });
  return {
    id: "motis",
    label: "Demo",
    hasRealtime: false,
    async nearbyStops() { return [stop]; },
    async departures() {
      return [
        make("O-Bus 3", "Itzling West", 2, "A", true),
        make("O-Bus 5", "Salzburg Hbf", 4, "C", false),
        make("O-Bus 10", "Kugelhofstraße", 7, "B", true),
        make("O-Bus 7", "Salzburg Hbf", 11, "B", false),
      ];
    },
    async ride(): Promise<Ride | null> {
      const names = ["Salzburg Mirabellplatz", "Salzburg Hanuschplatz", "Salzburg Hbf"];
      return {
        line: "O-Bus 3", headsign: "Itzling West",
        stops: names.map((name, index) => ({
          stop: { id: `d${index}`, name, lat: 47.8058 + index * 0.003, lon: 13.043 },
          scheduled: at(2 + index * 2), expected: at(2 + index * 2), source: "scheduled" as const, cancelled: false,
        })),
      };
    },
  };
}
