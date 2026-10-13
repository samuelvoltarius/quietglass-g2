import { describe, expect, it } from "vitest";
import fixture from "./fixtures/overpass-chargers-salzburg.json";
import { decodePolyline, encodePolyline, simplifyTo, type LatLng } from "../src/geo/geometry";
import { createValhallaProvider, createMockProvider, parseValhalla } from "../src/routing/provider";
import {
  addRoute, makeSavedRoute, nameStops, parseRoutes, planFrom, removeRoute, renameRoute, stopsPassed, type SavedRoute,
} from "../src/trip/saved";
import {
  buildCorridorQuery, buildNearbyQuery, chargersAlong, createChargerSource, nearestFast, nextAhead, parseChargers, parsePower,
  socketsText, speedOf, type Charger,
} from "../src/chargers/chargers";
import { EMPTY_DATA, parseData, selectedRoute, selectionLabel, type NavData } from "../src/storage/persist";
import { chargerView, cursorFor, listItems, listView } from "../src/glasses/picker";
import { buildView } from "../src/glasses/view";
import { insertStop, routeSvg, routeLine } from "../src/ui/planner";
import { TurnAnnouncer } from "../src/speech/announcer";

/** A straight line north from 47.80 / 13.04, one point every ~111 m. */
const north = (n: number, lat = 47.8, lon = 13.04): LatLng[] => Array.from({ length: n }, (_, i) => ({ lat: lat + i * 0.001, lon }));

const point = (label: string, lat: number, lon = 13.04) => ({ label, at: { lat, lon } });

describe("routes with stops (Valhalla)", () => {
  it("sends every stop as a location, in order, as a simple GET", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const provider = createValhallaProvider({
      url: "https://valhalla.test",
      fetchImpl: async (input, options) => { url = String(input); init = options; return new Response(JSON.stringify({ error: "x" }), { status: 400 }); },
    });
    await provider.route({ from: { lat: 1, lon: 2 }, via: [{ lat: 3, lon: 4 }, { lat: 5, lon: 6 }], to: { lat: 7, lon: 8 }, mode: "driving" });
    const body = JSON.parse(decodeURIComponent(url.split("?json=")[1]!)) as { locations: LatLng[]; costing: string };
    expect(body.locations).toEqual([{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }, { lat: 5, lon: 6 }, { lat: 7, lon: 8 }]);
    expect(body.costing).toBe("auto");
    expect(init?.method).toBe("GET");
    expect(Object.keys((init?.headers ?? {}) as Record<string, string>)).toEqual([]);
  });

  it("marks the arrival at each stop, but not at the destination, and joins the legs", () => {
    const leg = (from: number, street: string) => ({
      shape: encodePolyline(north(3, 47.8 + from * 0.002), 6),
      maneuvers: [
        { type: 1, instruction: "Go", street_names: [street], length: 0.2, time: 30, begin_shape_index: 0 },
        { type: 4, instruction: "Arrive", length: 0, time: 0, begin_shape_index: 2 },
      ],
    });
    const outcome = parseValhalla({ trip: { legs: [leg(0, "A"), leg(1, "B"), leg(2, "C")], summary: { length: 1.2, time: 180 } } });
    const maneuvers = outcome.route!.maneuvers;
    expect(maneuvers.map((m) => m.via)).toEqual([undefined, 1, undefined, 2, undefined, undefined]);
    expect(maneuvers.map((m) => m.shapeIndex)).toEqual([0, 2, 3, 5, 6, 8]);
    expect(outcome.route!.shape).toHaveLength(9);
  });

  it("names the stops for the glasses and counts the ones passed", async () => {
    const outcome = await createMockProvider().route({ from: { lat: 47.8, lon: 13.04 }, via: [{ lat: 47.81, lon: 13.05 }], to: { lat: 47.82, lon: 13.05 }, mode: "driving" });
    const stops = [point("Ladepark", 47.81, 13.05)];
    const route = nameStops(outcome.route!, stops, "Stopp");
    const stop = route.maneuvers.find((m) => m.via === 1);
    expect(stop?.street).toBe("Stopp 1: Ladepark");
    const index = route.maneuvers.indexOf(stop!);
    expect(stopsPassed(route.maneuvers, index, stops, null)).toBe(0);
    expect(stopsPassed(route.maneuvers, index + 1, stops, null)).toBe(1);
    // Right at the stop it counts as reached, even before the manoeuvre moved on.
    expect(stopsPassed(route.maneuvers, 0, stops, { lat: 47.81, lon: 13.0502 })).toBe(1);
  });
});

describe("saved routes", () => {
  const plan = {
    name: " Büro ", mode: "driving" as const,
    start: point("Zuhause", 47.8), stops: [point("Laden", 47.81), point("Bäcker", 47.82)], to: point("Büro", 47.84),
  };
  const shape = north(41);

  it("are saved, renamed, deleted and read back; malformed ones are dropped", () => {
    const saved = makeSavedRoute([], plan, { shape, distance: 4444.4, duration: 333.3 });
    expect(saved).toMatchObject({ id: "s1", name: "Büro", distance: 4444, duration: 333 });
    expect(decodePolyline(saved.line!, 5).length).toBeGreaterThanOrEqual(2);
    let routes = addRoute([], saved);
    routes = addRoute(routes, makeSavedRoute(routes, { ...plan, name: "" }, { shape, distance: 1, duration: 1 }));
    expect(routes.map((r) => r.id)).toEqual(["s1", "s2"]);
    expect(routes[1]!.name).toBe("Zuhause – Büro");
    routes = renameRoute(routes, "s2", "Morgens");
    expect(routes[1]!.name).toBe("Morgens");
    expect(renameRoute(routes, "s2", "   ")[1]!.name).toBe("Morgens");

    const data: NavData = { ...EMPTY_DATA, routes, destinationId: "s2" };
    const back = parseData(JSON.stringify({ ...data, routes: [...routes, { id: "bad" }, { id: "s9", to: { at: { lat: 99, lon: 0 } } }] }));
    expect(back.routes).toEqual(routes);
    expect(back.destinationId).toBe("s2");
    expect(selectedRoute(back)?.name).toBe("Morgens");
    expect(selectionLabel(back)).toBe("Morgens");
    expect(removeRoute(routes, "s1").map((r) => r.id)).toEqual(["s2"]);
  });

  it("from my position store neither the position nor the line", () => {
    const saved = makeSavedRoute([], { ...plan, start: null }, { shape, distance: 1, duration: 1 });
    expect(saved.start).toBeNull();
    expect(saved.line).toBeUndefined();
    expect(parseRoutes([saved])[0]).toEqual(saved);
  });

  it("start as planned near the start, join the line further along, else go to the first stop", () => {
    const saved: SavedRoute = makeSavedRoute([], plan, { shape, distance: 4000, duration: 300 });
    expect(planFrom(saved, { lat: 47.8005, lon: 13.04 })).toMatchObject({ kind: "asPlanned", stops: plan.stops });
    // Half way, between the two stops: the first one is behind.
    const joined = planFrom(saved, { lat: 47.815, lon: 13.041 });
    expect(joined.kind).toBe("joined");
    expect(joined.stops.map((s) => s.label)).toEqual(["Bäcker"]);
    // Far from start and line.
    expect(planFrom(saved, { lat: 48.3, lon: 14.3 })).toMatchObject({ kind: "toFirstStop", stops: plan.stops });
    expect(planFrom({ ...saved, stops: [] }, { lat: 48.3, lon: 14.3 }).kind).toBe("direct");
    // A route from "my position" always starts where one is.
    expect(planFrom({ ...saved, start: null }, { lat: 48.3, lon: 14.3 }).kind).toBe("asPlanned");
  });

  it("show on the glasses list with their stops, and are selected like places", () => {
    const routes = [makeSavedRoute([], plan, { shape, distance: 4000, duration: 300 })];
    const data: NavData = { ...EMPTY_DATA, places: [{ id: "p1", label: "Zuhause", at: { lat: 47, lon: 13 } }], routes, destinationId: "s1", chargers: true };
    expect(listItems(data).map((i) => i.kind)).toEqual(["place", "route", "chargers"]);
    expect(cursorFor(data)).toBe(1);
    const view = listView(data, 1, "de");
    expect(view.body).toEqual([
      "    ○ Zuhause",
      "→ ● Büro · Route, 2 Stopps",
      "    Ladestation in der Nähe …",
      "",
      "    Unterwegs: zu Fuß (tippen = ändern)",
    ]);
    expect(listView({ ...data, destinationId: null }, 0, "de").body[1]).toBe("    ↑ Büro · Route, 2 Stopps");
    expect(routeLine(routes[0]!, "de")).toBe("Zuhause → Laden → Bäcker → Büro · 4,0 km · 5 min · Auto");
  });

  it("without a speech server the list does not offer speaking", () => {
    const view = listView(EMPTY_DATA, 0, "de", false);
    expect(view.footer).not.toContain("sprechen");
    expect(view.body.join(" ")).toContain("am Handy");
  });

  it("remember a running navigation only while a destination exists", () => {
    expect(parseData(JSON.stringify({ ...EMPTY_DATA, places: [{ id: "p1", label: "A", at: { lat: 1, lon: 1 } }], destinationId: "p1", activeSince: 5 })).activeSince).toBe(5);
    expect(parseData(JSON.stringify({ ...EMPTY_DATA, activeSince: 5 })).activeSince).toBeNull();
  });
});

describe("charging stations from OpenStreetMap", () => {
  it("reads power in any of the mapped spellings", () => {
    expect(parsePower("150 kW")).toBe(150);
    expect(parsePower("11kW")).toBe(11);
    expect(parsePower("22000 W")).toBe(22);
    expect(parsePower("50 kVA")).toBe(50);
    expect(parsePower("22 kW;50 kW")).toBe(50);
    expect(parsePower("3,7 kW")).toBe(3.7);
    expect(parsePower("yes")).toBeNull();
    expect(parsePower(undefined)).toBeNull();
  });

  it("parses a real Overpass answer: cars only, power, sockets, capacity", () => {
    const list = parseChargers(fixture)!;
    // The bike-only station (288 W) is left out; the one also for cars stays.
    expect(list.map((c) => c.id)).toEqual(["n6309021345", "n10753881307", "n445971871", "n4873087986", "n2382723067"]);
    const moon = list.find((c) => c.id === "n10753881307")!;
    expect(moon).toMatchObject({ name: "Moon Power", operator: "Moon Power", powerKw: 150, combo: 1, type2: 1, chademo: 0, capacity: 2 });
    expect(speedOf(moon)).toBe("fast");
    expect(socketsText(moon, "de")).toBe("CCS · Typ 2");
    expect(speedOf(list.find((c) => c.id === "n4873087986")!)).toBe("slow");
    expect(socketsText(list.find((c) => c.id === "n445971871")!, "en")).toBe("CCS ×2");
  });

  it("takes ways by their centre and rejects broken answers", () => {
    expect(parseChargers({ elements: [{ type: "way", id: 7, center: { lat: 47, lon: 13 }, tags: { amenity: "charging_station", "socket:chademo": "1" } }] })![0]).toMatchObject({ id: "w7", at: { lat: 47, lon: 13 }, chademo: 1 });
    expect(parseChargers({ elements: [{ type: "node", id: 1, lat: 47, lon: 13, tags: { access: "private" } }] })).toEqual([]);
    expect(parseChargers({ remark: "runtime error: timed out", elements: [] })).toBeNull();
    expect(parseChargers("nope")).toBeNull();
  });

  it("builds compact queries: a point radius, or boxes along the route", () => {
    expect(buildNearbyQuery({ lat: 47.812345, lon: 13.0456789 })).toBe('[out:json][timeout:12];nwr["amenity"="charging_station"](around:15000,47.8123,13.0457);out center tags qt;');
    const long = north(2000); // ~222 km north
    const query = buildCorridorQuery(long)!;
    expect(query.startsWith('[out:json][timeout:15];(nwr["amenity"="charging_station"](47.7820,13.0132,')).toBe(true);
    expect(query.endsWith(");out center tags qt;")).toBe(true);
    // One box per ~20 km.
    expect(query.match(/nwr\[/g)!.length).toBe(12);
    // A very long route gets at most MAX_BOXES boxes.
    expect(buildCorridorQuery(north(20_000))!.match(/nwr\[/g)!.length).toBeLessThanOrEqual(24);
    expect(buildCorridorQuery([])).toBeNull();
  });

  const station = (id: string, at: LatLng, powerKw: number | null, combo = 0, type2 = 0): Charger =>
    ({ id, at, name: id, operator: "", powerKw, combo, chademo: 0, type2, capacity: null });

  it("keeps only stations within the corridor, ordered along the route", () => {
    const route = north(101); // ~11 km
    const list = chargersAlong(route, [
      station("late", { lat: 47.89, lon: 13.045 }, 150),
      station("early", { lat: 47.81, lon: 13.041 }, 50),
      station("far", { lat: 47.85, lon: 13.1 }, 300),
    ]);
    expect(list.map((c) => c.charger.id)).toEqual(["early", "late"]);
    expect(list[0]!.along).toBeGreaterThan(1000);
    expect(list[0]!.along).toBeLessThan(1200);
    expect(list[1]!.off).toBeGreaterThan(300);
    expect(nextAhead(list, 0)?.charger.id).toBe("early");
    expect(nextAhead(list, 2000)?.charger.id).toBe("late");
    expect(nextAhead(list, 20_000)).toBeNull();
  });

  it("offers the three nearest fast ones, unknown ones after them, slow ones never when others exist", () => {
    const here = { lat: 47.8, lon: 13.04 };
    const picked = nearestFast([
      station("wallbox", { lat: 47.8001, lon: 13.04 }, 11, 0, 1),
      station("unknown", { lat: 47.801, lon: 13.04 }, null),
      station("hpc", { lat: 47.81, lon: 13.04 }, 300, 4),
      station("ccs", { lat: 47.805, lon: 13.04 }, null, 1),
    ], here);
    expect(picked.map((p) => p.charger.id)).toEqual(["ccs", "hpc", "unknown"]);
    expect(nearestFast([station("wallbox", here, 11, 0, 1)], here).map((p) => p.charger.id)).toEqual(["wallbox"]);
  });

  it("asks at most once per 30 s, reuses answers, and says why when it cannot", async () => {
    let now = 1_000_000;
    let calls = 0;
    let body = "";
    const source = createChargerSource({
      urls: ["https://overpass.test/api/interpreter"],
      clock: () => now,
      fetchImpl: async (_url, init) => {
        calls++;
        body = String(init?.body);
        expect(init?.headers).toBeUndefined();
        return new Response(JSON.stringify(fixture), { status: 200 });
      },
    });
    const here = { lat: 47.81, lon: 13.0 };
    expect((await source.nearby(here)).chargers.length).toBe(5);
    expect(body).toContain("data=");
    // Same place again: from memory, no request.
    expect((await source.nearby({ lat: 47.812, lon: 13.0 })).error).toBeNull();
    expect(calls).toBe(1);
    // Somewhere else too soon: refused with the wait.
    const refused = await source.along(north(10));
    expect(refused).toMatchObject({ error: "cooldown", waitS: 30 });
    now += 31_000;
    expect((await source.along(north(10))).error).toBeNull();
    expect(calls).toBe(2);
    now += 31_000;
    expect((await source.along(north(10))).error).toBeNull();
    expect(calls).toBe(2);
  });

  it("reports a timeout, a busy server and no connection", async () => {
    const failing = (thrown: unknown | null, status = 200) => createChargerSource({
      urls: ["https://a.test", "https://b.test"],
      timeoutMs: 20,
      fetchImpl: (_url, init) => new Promise((resolve, reject) => {
        if (thrown) { reject(thrown); return; }
        if (status !== 200) { resolve(new Response("", { status })); return; }
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });
    expect((await failing(null).nearby({ lat: 1, lon: 1 })).error).toBe("timeout");
    expect((await failing(null, 429).nearby({ lat: 1, lon: 1 })).error).toBe("busy");
    expect((await failing(new TypeError("Failed to fetch")).nearby({ lat: 1, lon: 1 })).error).toBe("offline");
  });

  it("shows the nearby list and errors on the glasses within one line", () => {
    const here = { lat: 47.8, lon: 13.04 };
    const list = nearestFast(parseChargers(fixture)!, { lat: 47.8164, lon: 12.9864 });
    const view = chargerView({ phase: "results", list, selected: 0 }, "de");
    expect(view.header).toBe("OpenGlance · Laden in der Nähe");
    expect(view.body[0]).toMatch(/^→ \d+ m · 150 kW · Moon Power$/);
    expect(view.body[1]).toBe("      CCS · Typ 2 · 2 Plätze");
    for (const line of view.body) expect(line.length).toBeLessThanOrEqual(46);
    expect(chargerView({ phase: "error", key: "c.cooldown", vars: { s: 12 } }, "de").body).toEqual(["Gerade erst gefragt.", "", "In 12 s nochmal halten."]);
    expect(here).toBeTruthy();
  });
});

describe("on the way", () => {
  it("shows the next charging station under the road, but not close to a turn", () => {
    const progress = {
      maneuver: { type: "right" as const, instruction: "", street: "Linzer Gasse", length: 900, time: 60, shapeIndex: 3 },
      distanceToManeuver: 800, distanceRemaining: 5000, secondsRemaining: 400, offRoute: false, arrived: false,
    };
    const options = { mode: "driving" as const, navigating: true, rerouting: false, error: null, mock: false, waitingForFix: false, locale: "de" as const, bigDistance: true, charger: "Laden in 12 km · 150 kW" };
    expect(buildView(progress, options).body).toEqual(["Linzer Gasse", "Laden in 12 km · 150 kW"]);
    expect(buildView({ ...progress, distanceToManeuver: 120 }, options).body).toEqual(["Linzer Gasse"]);
  });

  it("announces a stop on the way as a stop, not as the destination", () => {
    const announcer = new TurnAnnouncer();
    const progress = {
      maneuver: { type: "arrive" as const, instruction: "", length: 0, time: 0, shapeIndex: 9, via: 1 },
      distanceToManeuver: 190, distanceRemaining: 3000, secondsRemaining: 300, offRoute: false, arrived: false,
    };
    const context = { routeId: 1, mode: "driving" as const, locale: "de" as const, hasFix: true };
    expect(announcer.next(progress, context)?.text).toBe("In 200 Metern erreichen Sie Ihren Zwischenstopp.");
    expect(announcer.next({ ...progress, distanceToManeuver: 20 }, context)?.text).toBe("Zwischenstopp erreicht.");
  });
});

describe("the planner on the phone", () => {
  it("puts a charger picked along the way between the stops it lies between", () => {
    const line = north(101);
    const stops = [point("A", 47.81), point("C", 47.87)];
    expect(insertStop(stops, point("B", 47.84), line)!.map((s) => s.label)).toEqual(["A", "B", "C"]);
    expect(insertStop(stops, point("D", 47.89), line)!.map((s) => s.label)).toEqual(["A", "C", "D"]);
    expect(insertStop([...stops, point("X", 47.88)], point("B", 47.84), line)).toBeNull();
  });

  it("draws the route from its own points, with numbered stops and charger marks", () => {
    const svg = routeSvg(north(50), { start: { lat: 47.8, lon: 13.04 }, stops: [{ lat: 47.82, lon: 13.04 }], to: { lat: 47.849, lon: 13.04 }, chargers: [{ lat: 47.83, lon: 13.041 }] });
    expect(svg).toMatch(/^<svg class="route-svg" viewBox="0 0 320 200"/);
    expect(svg).toContain("<polyline");
    expect(svg).toContain('class="route-stop-n"');
    expect(svg).toContain(">1</text>");
    expect(svg).toContain('class="route-charger"');
    expect(simplifyTo(north(50), 10).length).toBe(2);
  });
});
