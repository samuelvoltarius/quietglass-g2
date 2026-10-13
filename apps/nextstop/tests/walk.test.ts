import { describe, expect, it } from "vitest";
import valhalla from "./fixtures/valhalla-walk.json";
import recorded from "../src/demo/plan-salzburg.json";
import { demoJourneys, demoPosition, demoWalkRoute } from "../src/demo/demo";
import {
  decodePolyline, fetchWalkRoute, mapType, MIN_TURN_METRES, OFF_ROUTE_METRES, parseWalkRoute, project,
  PUBLIC_ROUTER, walkNav,
} from "../src/route/walk";
import { buildSteps, estimatedArrival, guideState } from "../src/route/guide";
import { ARROWS, guideView, ROUTE_ROWS, ROUTE_WIDTH, walkRows } from "../src/route/view";
import { arrivalOf, clock, departureOf, type TransitLeg, type WalkLeg } from "../src/route/journey";
import { locales } from "../src/i18n";

/**
 * valhalla-walk.json is a real answer of valhalla1.openstreetmap.de (pedestrian,
 * fetched with curl on 2026-10-13, trimmed to shape and manoeuvres): 1.17 km
 * from Salzburg Vogelweiderstraße to Mirabellplatz.
 */
const route = parseWalkRoute(valhalla)!;

describe("reading a Valhalla walking route", () => {
  it("decodes the shape at precision 6", () => {
    const shape = decodePolyline((valhalla as { trip: { legs: { shape: string }[] } }).trip.legs[0]!.shape);
    expect(shape[0]?.lat).toBeCloseTo(47.8091, 3);
    expect(shape[0]?.lon).toBeCloseTo(13.0571, 3);
    expect(shape.at(-1)?.lat).toBeCloseTo(47.8054, 3);
    expect(decodePolyline("")).toEqual([]);
  });

  it("keeps the start, the arrival and the turns worth making, and drops pavement zigzags", () => {
    expect(route.maneuvers[0]?.type).toBe("depart");
    expect(route.maneuvers.at(-1)?.type).toBe("arrive");
    expect(route.maneuvers.length).toBeLessThan(18);
    for (const m of route.maneuvers.slice(1, -1)) expect(m.length).toBeGreaterThanOrEqual(MIN_TURN_METRES);
    expect(route.maneuvers.find((m) => m.street === "Sterneckstraße")?.type).toBe("right");
  });

  it("measures the route in metres", () => {
    expect(route.distance).toBeGreaterThan(1100);
    expect(route.distance).toBeLessThan(1250);
    expect(route.along.at(-1)).toBeGreaterThan(1000);
  });

  it("maps Valhalla's manoeuvre numbers, and never invents a turn for an unknown one", () => {
    expect(mapType(15)).toBe("left");
    expect(mapType(10)).toBe("right");
    expect(mapType(16)).toBe("slightLeft");
    expect(mapType(9)).toBe("slightRight");
    expect(mapType(4)).toBe("arrive");
    expect(mapType(999)).toBe("straight");
  });

  it("returns nothing for an answer without a route", () => {
    expect(parseWalkRoute(null)).toBeNull();
    expect(parseWalkRoute({ error: "No path could be found" })).toBeNull();
    expect(parseWalkRoute({ trip: { legs: [{ shape: "", maneuvers: [] }] } })).toBeNull();
  });
});

describe("where the walker is on the route", () => {
  const at = (metres: number) => {
    // The point of the shape nearest to that distance along the route.
    const index = route.along.findIndex((value) => value >= metres);
    return route.shape[Math.max(0, index)]!;
  };

  it("names the first real turn at the start, with the distance to it", () => {
    const nav = walkNav(route, at(0));
    expect(nav.next.type).not.toBe("depart");
    expect(nav.toNext).toBeGreaterThan(0);
    expect(nav.remaining).toBeCloseTo(route.along.at(-1)!, -1);
    expect(nav.off).toBeLessThan(2);
  });

  it("moves on to the next turn once one has been passed", () => {
    const first = walkNav(route, at(0)).next;
    const later = walkNav(route, at(route.along[first.shapeIndex]! + 20));
    expect(later.next).not.toBe(first);
    expect(later.remaining).toBeLessThan(walkNav(route, at(0)).remaining);
  });

  it("says arrive for the last stretch, and counts down to the end", () => {
    const nav = walkNav(route, at(route.along.at(-1)! - 60));
    expect(nav.next.type).toBe("arrive");
    expect(nav.toNext).toBeGreaterThan(40);
    expect(nav.toNext).toBeLessThan(70);
    expect(walkNav(route, route.shape.at(-1)!).atEnd).toBe(true);
    expect(nav.atEnd).toBe(false);
  });

  it("measures the distance from the route itself", () => {
    const p = at(300);
    const aside = { lat: p.lat + 0.001, lon: p.lon };
    expect(project(route, aside).off).toBeGreaterThan(OFF_ROUTE_METRES);
    expect(project(route, p).off).toBeLessThan(2);
  });
});

describe("a walking instruction on the glasses", () => {
  const leg = (toDestination: boolean): WalkLeg => ({
    kind: "walk", toName: toDestination ? "Heim" : "Salzburg Mirabellplatz", toLat: 47.8054, toLon: 13.044,
    toDestination, fromLat: 47.809, fromLon: 13.057, metres: 1170,
    start: new Date("2026-10-13T12:00:00Z"), end: new Date("2026-10-13T12:14:00Z"),
  });

  it("leads with an arrow, the distance and the turn, then the street and what is left", () => {
    const turn = { next: { type: "right" as const, street: "Sterneckstraße", length: 300, shapeIndex: 9 }, toNext: 120, remaining: 980, off: 3, atEnd: false };
    expect(walkRows(turn, leg(false), "de")).toEqual([
      "→  120 m  rechts abbiegen", "in Sterneckstraße", "noch 980 m · 12 min zu Fuß",
    ]);
    expect(walkRows({ ...turn, next: { type: "left", length: 5, shapeIndex: 3 }, toNext: 40 }, leg(false), "en")[0]).toBe("←  40 m  turn left");
  });

  it("says how far the stop or the destination is on the last stretch", () => {
    const end = { next: { type: "arrive" as const, length: 0, shapeIndex: 80 }, toNext: 60, remaining: 60, off: 2, atEnd: false };
    expect(walkRows(end, leg(false), "de").slice(0, 2)).toEqual(["● 60 m bis zur Haltestelle", "Salzburg Mirabellplatz"]);
    expect(walkRows(end, leg(true), "de").slice(0, 2)).toEqual(["● 60 m bis zum Ziel", "Heim"]);
  });

  it("has an arrow for every kind of turn", () => {
    for (const type of Object.keys(ARROWS)) expect(ARROWS[type as keyof typeof ARROWS], type).toMatch(/^\S$/);
  });
});

describe("asking for a walking route", () => {
  const from = { lat: 47.809, lon: 13.057 };
  const to = { lat: 47.8054, lon: 13.044 };

  it("sends a GET with ?json=, pedestrian costing and the client id to the public server only", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(valhalla), { status: 200 });
    }) as unknown as typeof fetch;

    const found = await fetchWalkRoute(from, to, { fetchImpl, baseUrl: PUBLIC_ROUTER, language: "de" });
    expect(found?.maneuvers.length).toBeGreaterThan(2);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://valhalla1.openstreetmap.de/route");
    const body = JSON.parse(url.searchParams.get("json")!);
    expect(body.costing).toBe("pedestrian");
    expect(body.locations).toEqual([{ lat: 47.809, lon: 13.057 }, { lat: 47.8054, lon: 13.044 }]);
    expect(body.directions_options.language).toBe("de-DE");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.headers).toEqual({ "X-Client-Id": "quietglass-nextstop" });

    // A server of your own gets no extra header: it would bring the CORS preflight back.
    await fetchWalkRoute(from, to, { fetchImpl, baseUrl: "https://router.example:8455/" });
    expect(calls[1]!.url.startsWith("https://router.example:8455/route?json=")).toBe(true);
    expect(calls[1]!.init.headers).toEqual({});
  });

  it("reports a refusal instead of an empty route", async () => {
    const fetchImpl = (async () => new Response("no", { status: 429 })) as unknown as typeof fetch;
    await expect(fetchWalkRoute(from, to, { fetchImpl })).rejects.toThrow("HTTP 429");
  });
});

// ---- through a whole connection ---------------------------------------------

describe("walking, riding and walking again", () => {
  const T0 = new Date("2026-10-13T12:00:00Z");
  const journey = demoJourneys(recorded, T0, { name: "Heim", lat: 47.796, lon: 13.016 }, "de")[0]!;
  const steps = buildSteps(journey);
  const bus1 = journey.legs[1] as TransitLeg;
  const bus2 = journey.legs[3] as TransitLeg;
  const walks = journey.legs.filter((leg): leg is WalkLeg => leg.kind === "walk");
  const at = (date: Date) => demoPosition(journey, date);
  const phaseAt = (date: Date) => {
    const state = guideState(steps, date, at(date));
    return `${state.step.kind}:${state.phase}:${state.index}`;
  };

  it("simulates a walker who starts at the first walk, rides, changes, and ends at the destination", () => {
    expect(at(new Date(T0.getTime() - 600000)).lat).toBeCloseTo(47.8095, 3);
    const mid = at(new Date(walks[0]!.start.getTime() + (walks[0]!.end.getTime() - walks[0]!.start.getTime()) / 2));
    expect(mid.lat).toBeCloseTo((walks[0]!.fromLat + walks[0]!.toLat) / 2, 4);
    const end = at(new Date(journey.end.getTime() + 3600000));
    expect(end.lat).toBeCloseTo(walks.at(-1)!.toLat, 5);
    expect(end.lon).toBeCloseTo(walks.at(-1)!.toLon, 5);
  });

  it("changes stage by itself all the way: walk, wait, ride, change on foot, wait, ride, walk, arrived", () => {
    const seen: string[] = [];
    for (let t = T0.getTime(); t <= journey.end.getTime() + 15 * 60000; t += 20000) {
      const label = phaseAt(new Date(t));
      if (seen.at(-1) !== label) seen.push(label);
    }
    // The index never goes back, and every stage of the journey is visited in order.
    const indexes = seen.map((label) => Number(label.split(":")[2]));
    expect(indexes).toEqual([...indexes].sort((x, y) => x - y));
    expect([...new Set(indexes)]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(seen.at(-1)).toBe("arrived:arrived:5");
    expect(seen.some((label) => label.startsWith("walk:walk:4"))).toBe(true);
  });

  it("asks the plain question of the walk to the destination: what is left, and when does it end", () => {
    const now = new Date(arrivalOf(bus2).getTime() + 60000);
    const state = guideState(steps, now, at(now));
    expect(state.index).toBe(4);
    const last = walks.at(-1)!;
    const nav = walkNav(demoWalkRoute({ lat: last.fromLat, lon: last.fromLon }, { lat: last.toLat, lon: last.toLon }), at(now));
    expect(nav.remaining).toBeLessThan(last.metres * 1.5);
  });

  it("puts the expected end of the whole journey in every header, later by a reported delay", () => {
    const now = new Date(departureOf(bus1).getTime() + 90000);
    const state = guideState(steps, now, at(now));
    const view = guideView(state, now, at(now), "de", { arrival: estimatedArrival(journey) });
    expect(view.header).toContain(`an ${clock(journey.end)}`);
    expect(view.header.length).toBeLessThanOrEqual(ROUTE_WIDTH);

    const late = { ...journey, legs: journey.legs.map((leg) => leg === bus2 ? { ...bus2, stops: bus2.stops.map((s) => ({ ...s, expected: new Date(s.expected.getTime() + 4 * 60000), source: "realtime" as const })) } : leg) };
    expect(estimatedArrival(late).getTime() - journey.end.getTime()).toBe(4 * 60000);
    expect(estimatedArrival(journey).getTime()).toBe(journey.end.getTime());
  });

  it("warns one halt before the stop to get off at, and says 'Warte auf' while waiting", () => {
    const slow: TransitLeg = { ...bus1, stops: bus1.stops.map((s, i) => ({ ...s, expected: new Date(departureOf(bus1).getTime() + i * 5 * 60000) })) };
    const slowSteps = buildSteps({ ...journey, legs: [journey.legs[0]!, slow, ...journey.legs.slice(2)] });
    const now = new Date(slow.stops[2]!.expected.getTime() + 60000);
    const view = guideView(guideState(slowSteps, now, null), now, null, "de");
    expect(view.body.some((line) => line === "Danach aussteigen – bereit machen!")).toBe(true);

    const waiting = new Date(departureOf(bus1).getTime() - 60000);
    const board = guideView(guideState(steps, waiting, { lat: bus1.stops[0]!.stop.lat, lon: bus1.stops[0]!.stop.lon, accuracy: 10 }), waiting, null, "de");
    expect(board.body[0]).toBe("> Warte auf O-Bus 2");
  });

  for (const locale of locales) {
    it(`keeps the walking pages inside the display in ${locale}`, () => {
      for (let t = T0.getTime(); t <= journey.end.getTime() + 60000; t += 30000) {
        const now = new Date(t);
        const pos = at(now);
        const state = guideState(steps, now, pos);
        let walk = null;
        if (state.step.kind === "walk") {
          const route = demoWalkRoute(pos, { lat: state.step.leg.toLat, lon: state.step.leg.toLon });
          walk = walkNav(route, pos);
        }
        const view = guideView(state, now, pos, locale, { walk, arrival: estimatedArrival(journey), rerouted: t % 60000 === 0 });
        expect(view.header.length, view.header).toBeLessThanOrEqual(ROUTE_WIDTH);
        expect(view.footer.length, view.footer).toBeLessThanOrEqual(46);
        expect(view.body.length).toBeLessThanOrEqual(ROUTE_ROWS);
        for (const line of view.body) expect(line.length, line).toBeLessThanOrEqual(ROUTE_WIDTH);
      }
    });
  }
});

describe("the demo's invented walking route", () => {
  it("has a start, one turn and an arrival, and turns the right way", () => {
    const east = demoWalkRoute({ lat: 47.80, lon: 13.04 }, { lat: 47.804, lon: 13.046 });
    expect(east.maneuvers.map((m) => m.type)).toEqual(["depart", "right", "arrive"]);
    const west = demoWalkRoute({ lat: 47.80, lon: 13.04 }, { lat: 47.804, lon: 13.034 });
    expect(west.maneuvers[1]?.type).toBe("left");
    const nav = walkNav(east, { lat: 47.80, lon: 13.04 });
    expect(nav.next.type).toBe("right");
    expect(nav.toNext).toBeGreaterThan(300);
  });
});
