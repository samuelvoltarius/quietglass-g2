import { describe, it, expect, vi } from "vitest";
import {
  bearingDegrees, bearingDelta, decodePolyline, distanceMeters, formatDistance,
  formatDuration, formatEta, projectOntoPath, remainingAlong,
} from "../src/geo/geometry";
import {
  createMockProvider, createValhallaProvider, describeError, mapValhallaType, parseValhalla,
} from "../src/routing/provider";
import {
  DEFAULT_SETTINGS, needsReroute, progressOf, startNavigation, update,
} from "../src/nav/navigator";

const BERLIN = { lat: 52.52, lon: 13.405 };
const HAMBURG = { lat: 53.551, lon: 9.993 };

describe("geodesy", () => {
  it("measures a known distance", () => {
    // Berlin to Hamburg is about 255 km.
    expect(distanceMeters(BERLIN, HAMBURG) / 1000).toBeCloseTo(255, 0);
  });

  it("is zero for the same point", () => {
    expect(distanceMeters(BERLIN, BERLIN)).toBeCloseTo(0, 6);
  });

  it("computes bearings", () => {
    expect(bearingDegrees({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 3);
    expect(bearingDegrees({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 3);
  });

  it("takes the shorter way round when comparing bearings", () => {
    expect(bearingDelta(350, 10)).toBe(20);
    expect(bearingDelta(10, 350)).toBe(-20);
    // Exactly opposite: both directions are equally far, so either sign is
    // correct. Only the magnitude is meaningful here.
    expect(Math.abs(bearingDelta(0, 180))).toBe(180);
  });
});

describe("polyline decoding", () => {
  it("decodes at precision 5", () => {
    const points = decodePolyline("_p~iF~ps|U_ulLnnqC", 5);
    expect(points).toHaveLength(2);
    expect(points[0]?.lat).toBeCloseTo(38.5, 4);
    expect(points[0]?.lon).toBeCloseTo(-120.2, 4);
  });

  it("scales by ten between precision 5 and 6 — the classic Valhalla trap", () => {
    const at5 = decodePolyline("_p~iF~ps|U", 5)[0];
    const at6 = decodePolyline("_p~iF~ps|U", 6)[0];
    expect(at5!.lat / at6!.lat).toBeCloseTo(10, 6);
  });

  it("returns nothing for an empty string", () => {
    expect(decodePolyline("", 6)).toEqual([]);
  });
});

describe("projection onto a route", () => {
  // A straight line heading north.
  const path = Array.from({ length: 11 }, (_, i) => ({ lat: 52.0 + i * 0.001, lon: 13.0 }));

  it("finds the nearest point on the line", () => {
    const projection = projectOntoPath({ lat: 52.0045, lon: 13.0 }, path);
    expect(projection?.distance).toBeLessThan(5);
    expect(projection?.index).toBe(4);
  });

  it("measures how far off the line a position is", () => {
    // About 100 m east at this latitude.
    const projection = projectOntoPath({ lat: 52.005, lon: 13.00147 }, path);
    expect(projection!.distance).toBeGreaterThan(80);
    expect(projection!.distance).toBeLessThan(120);
  });

  it("clamps to the ends rather than extrapolating", () => {
    const before = projectOntoPath({ lat: 51.9, lon: 13.0 }, path);
    expect(before?.index).toBe(0);
    expect(before?.t).toBe(0);
  });

  it("handles degenerate paths", () => {
    expect(projectOntoPath(BERLIN, [])).toBeNull();
    expect(projectOntoPath(BERLIN, [BERLIN])?.distance).toBeCloseTo(0, 3);
  });

  it("measures the remaining distance along the path", () => {
    const projection = projectOntoPath({ lat: 52.005, lon: 13.0 }, path)!;
    // Five of ten segments left, each about 111 m.
    expect(remainingAlong(path, projection) / 1000).toBeCloseTo(0.556, 1);
  });
});

describe("formatting", () => {
  it("shows a precision a driver can act on", () => {
    expect(formatDistance(12)).toBe("now");
    expect(formatDistance(247)).toBe("250 m");
    expect(formatDistance(1420)).toBe("1.4 km");
    expect(formatDistance(24_300)).toBe("24 km");
    expect(formatDistance(-1)).toBe("--");
  });

  it("formats durations and arrival times", () => {
    expect(formatDuration(90)).toBe("2 min");
    expect(formatDuration(4500)).toBe("1 h 15 min");
    expect(formatEta(3600, new Date("2026-09-25T10:00:00").getTime())).toBe("11:00");
    expect(formatEta(-5, Date.now())).toBe("--");
  });
});

describe("Valhalla parsing", () => {
  const response = {
    trip: {
      summary: { length: 2.6, time: 390 },
      legs: [{
        shape: "_p~iF~ps|U_ulLnnqC",
        maneuvers: [
          { type: 1, instruction: "Head north", street_names: ["Mock Street"], length: 0.8, time: 120, begin_shape_index: 0 },
          { type: 10, instruction: "Turn right", street_names: ["Example Road"], length: 1.2, time: 180, begin_shape_index: 1 },
          { type: 4, instruction: "You have arrived", length: 0, time: 0, begin_shape_index: 1 },
        ],
      }],
    },
  };

  it("reads shape, manoeuvres and summary", () => {
    const { route, error } = parseValhalla(response);
    expect(error).toBeNull();
    expect(route?.maneuvers).toHaveLength(3);
    expect(route?.shape.length).toBeGreaterThan(0);
  });

  it("converts kilometres to metres", () => {
    const { route } = parseValhalla(response);
    expect(route?.distance).toBe(2600);
    expect(route?.maneuvers[0]?.length).toBe(800);
  });

  it("keeps the street name", () => {
    expect(parseValhalla(response).route?.maneuvers[1]?.street).toBe("Example Road");
  });

  it("reports a router error rather than pretending to have a route", () => {
    expect(parseValhalla({ error: "No path could be found" }).error).toContain("No path");
  });

  it("rejects a response with no legs", () => {
    expect(parseValhalla({ trip: { legs: [] } }).error).toBe("no route found");
    expect(parseValhalla(null).error).toBe("unreadable response");
  });

  it("rejects a route with no geometry instead of navigating into nothing", () => {
    expect(parseValhalla({ trip: { legs: [{ maneuvers: [] }] } }).error).toContain("geometry");
  });

  it("maps manoeuvre types, defaulting to straight rather than inventing a turn", () => {
    expect(mapValhallaType(10)).toBe("right");
    expect(mapValhallaType(15)).toBe("left");
    expect(mapValhallaType(26)).toBe("roundabout");
    expect(mapValhallaType(999)).toBe("straight");
  });

  it("posts to the /route endpoint with the right costing", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/route");
      expect(JSON.parse(String(init?.body)).costing).toBe("bicycle");
      return new Response(JSON.stringify(response), { status: 200 });
    });
    const provider = createValhallaProvider({ url: "https://v.example/", fetchImpl: fetchImpl as never });
    const outcome = await provider.route({ from: BERLIN, to: HAMBURG, mode: "cycling" });
    expect(outcome.error).toBeNull();
  });

  it("reports transport failures without leaking internals", () => {
    expect(describeError(new TypeError("Failed to fetch"))).toBe("router unreachable");
    expect(describeError(new DOMException("x", "AbortError"))).toBe("routing timed out");
  });
});

describe("navigating", () => {
  const route = () => createMockProvider().route({ from: { lat: 52, lon: 13 }, to: HAMBURG, mode: "driving" });

  it("starts at the first manoeuvre", async () => {
    const { route: r } = await route();
    const state = startNavigation(r!);
    expect(state.maneuverIndex).toBe(0);
    expect(state.arrived).toBe(false);
  });

  it("advances by progress along the route, not by proximity", async () => {
    const { route: r } = await route();
    let state = startNavigation(r!);
    // Shape index 20 is past the second manoeuvre, which begins at 16.
    state = update(state, r!.shape[20]!);
    expect(state.maneuverIndex).toBe(1);
  });

  it("counts down the distance to the next manoeuvre", async () => {
    const { route: r } = await route();
    let state = startNavigation(r!);
    state = update(state, r!.shape[2]!);
    const near = progressOf(state).distanceToManeuver;

    state = update(state, r!.shape[10]!);
    expect(progressOf(state).distanceToManeuver).toBeLessThan(near);
  });

  it("shrinks the remaining distance as the route is covered", async () => {
    const { route: r } = await route();
    let state = update(startNavigation(r!), r!.shape[1]!);
    const early = progressOf(state).distanceRemaining;
    state = update(state, r!.shape[30]!);
    expect(progressOf(state).distanceRemaining).toBeLessThan(early);
  });

  it("does not reroute on a single noisy fix", async () => {
    const { route: r } = await route();
    let state = startNavigation(r!);
    state = update(state, { lat: r!.shape[5]!.lat + 0.01, lon: r!.shape[5]!.lon });
    expect(state.offRouteFixes).toBe(1);
    expect(needsReroute(state)).toBe(false);
  });

  it("reroutes after persistent deviation", async () => {
    const { route: r } = await route();
    let state = startNavigation(r!);
    const strayed = { lat: r!.shape[5]!.lat + 0.01, lon: r!.shape[5]!.lon };
    for (let i = 0; i < DEFAULT_SETTINGS.offRouteFixes; i++) state = update(state, strayed);
    expect(needsReroute(state)).toBe(true);
    expect(progressOf(state).offRoute).toBe(true);
  });

  it("forgets the deviation once back on the route", async () => {
    const { route: r } = await route();
    let state = startNavigation(r!);
    state = update(state, { lat: r!.shape[5]!.lat + 0.01, lon: r!.shape[5]!.lon });
    state = update(state, r!.shape[5]!);
    expect(state.offRouteFixes).toBe(0);
    expect(needsReroute(state)).toBe(false);
  });

  it("detects arrival at the destination", async () => {
    const { route: r } = await route();
    const state = update(startNavigation(r!), r!.shape[r!.shape.length - 1]!);
    expect(state.arrived).toBe(true);
    expect(progressOf(state).arrived).toBe(true);
  });

  it("stays arrived even if a later fix drifts away", async () => {
    const { route: r } = await route();
    let state = update(startNavigation(r!), r!.shape[r!.shape.length - 1]!);
    state = update(state, { lat: 0, lon: 0 });
    expect(state.arrived).toBe(true);
  });

  it("reports the full route before the first fix", async () => {
    const { route: r } = await route();
    const progress = progressOf(startNavigation(r!));
    expect(progress.distanceRemaining).toBe(r!.distance);
    expect(progress.secondsRemaining).toBe(r!.duration);
  });
});
