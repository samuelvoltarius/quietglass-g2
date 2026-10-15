import { describe, expect, it } from "vitest";
import type { LatLng } from "../src/geo/geometry";
import {
  limitAt, overLimit, parseSpeedLimits, speedColumn, speedLine, SpeedMeter, SPEED_STALE_MS,
} from "../src/nav/speed";
import { buildTraceUrl, createRouteStreetSource, fittingPoints } from "../src/overview/route-streets";
import { buildView } from "../src/glasses/view";
import { sameView } from "../src/glasses/diff";
import { createMockProvider } from "../src/routing/provider";
import { progressOf, startNavigation, update } from "../src/nav/navigator";

const north = (km: number): LatLng[] => Array.from({ length: km * 10 + 1 }, (_, i) => ({ lat: 47.8 + (i * 100) / 111_320, lon: 13.04 }));

describe("speed from the GPS", () => {
  it("converts m/s to km/h and smooths jumps", () => {
    const meter = new SpeedMeter();
    expect(meter.kmh(0)).toBeNull();
    meter.push(10, 1000); // 36 km/h
    expect(meter.kmh(1000)).toBe(36);
    meter.push(20, 2000); // 72 km/h → halfway
    expect(meter.kmh(2000)).toBe(54);
  });

  it("is unknown (never 0) without a valid reading, and once it is older than 5 s", () => {
    const meter = new SpeedMeter();
    meter.push(undefined, 0);
    expect(meter.kmh(0)).toBeNull();
    meter.push(14, 1000);
    expect(meter.kmh(1000 + SPEED_STALE_MS)).toBe(50);
    expect(meter.kmh(1001 + SPEED_STALE_MS)).toBeNull();
    // iOS reports -1 when it cannot tell.
    meter.push(-1, 2000);
    expect(meter.kmh(2000)).toBeNull();
    // Standing still is a real 0.
    meter.push(0, 3000);
    expect(meter.kmh(3000)).toBe(0);
  });

  it("starts afresh after a gap instead of averaging with an old value", () => {
    const meter = new SpeedMeter();
    meter.push(30, 0);
    meter.push(10, 10_000);
    expect(meter.kmh(10_000)).toBe(36);
  });
});

describe("speed limits from trace_attributes", () => {
  const answer = { edges: [
    { begin_shape_index: 0, end_shape_index: 2, speed_limit: 50 },
    { begin_shape_index: 2, end_shape_index: 4, speed_limit: 50 },
    { begin_shape_index: 4, end_shape_index: 6 },
    { begin_shape_index: 6, end_shape_index: 8, speed_limit: "unlimited" },
    { begin_shape_index: 8, end_shape_index: 10, speed_limit: 100 },
    { begin_shape_index: 9, end_shape_index: 99, speed_limit: 30 },
  ] };

  it("joins edges with the same limit and keeps unknown and unlimited roads without one", () => {
    expect(parseSpeedLimits(answer, 11)).toEqual([
      { from: 0, to: 4, limit: 50 },
      { from: 4, to: 8, limit: null },
      { from: 8, to: 10, limit: 100 },
    ]);
    expect(parseSpeedLimits({ error: "x" }, 11)).toBeNull();
  });

  it("finds the limit for the segment the car is on", () => {
    const spans = parseSpeedLimits(answer, 11)!;
    expect(limitAt(spans, 0)).toBe(50);
    expect(limitAt(spans, 3)).toBe(50);
    expect(limitAt(spans, 5)).toBeNull();
    expect(limitAt(spans, 9)).toBe(100);
    expect(limitAt(spans, 10)).toBeNull();
  });

  it("asks for speed limit and speed in the same request as the names", () => {
    const request = JSON.parse(decodeURIComponent(buildTraceUrl("https://valhalla.test", north(1), "driving").split("?json=")[1]!));
    expect(request.filters.attributes).toEqual(expect.arrayContaining(["edge.names", "edge.speed_limit", "edge.speed"]));
    expect(request.units).toBe("kilometers");
  });

  it("cuts a long route to a prefix whose URL a public server accepts", () => {
    const shape = north(100);
    const count = fittingPoints("https://valhalla.test", shape, "driving", 2000);
    expect(count).toBeGreaterThan(10);
    expect(count).toBeLessThan(shape.length);
    expect(buildTraceUrl("https://valhalla.test", shape.slice(0, count), "driving").length).toBeLessThanOrEqual(2000);
    expect(buildTraceUrl("https://valhalla.test", shape.slice(0, count + 1), "driving").length).toBeGreaterThan(2000);
    expect(fittingPoints("https://valhalla.test", north(1), "driving", 100_000)).toBe(11);
  });

  it("returns names and limits from one answer, sending only the prefix", async () => {
    let asked = "";
    const source = createRouteStreetSource({
      url: "https://valhalla.test",
      maxUrlLength: 2000,
      fetchImpl: async (input) => {
        asked = String(input);
        return new Response(JSON.stringify({ edges: [{ begin_shape_index: 0, end_shape_index: 5, speed_limit: 80, names: ["B1"], road_class: "primary" }] }));
      },
    });
    const result = await source.load(north(100), "driving");
    expect(asked.length).toBeLessThanOrEqual(2000);
    expect(result.error).toBeNull();
    expect(result.limits).toEqual([{ from: 0, to: 5, limit: 80 }]);
    expect(result.streets[0]?.name).toBe("B1");
  });
});

describe("speed limits of a long route on a public server (0.14.0)", () => {
  it("asks in up to `chunks` parts, one after the other, and maps the limits onto the whole route", async () => {
    const asked: string[] = [];
    const source = createRouteStreetSource({
      url: "https://valhalla.test",
      maxUrlLength: 2000,
      chunks: 4,
      chunkGapMs: 0,
      fetchImpl: async (input) => {
        asked.push(String(input));
        return new Response(JSON.stringify({ edges: [{ begin_shape_index: 0, end_shape_index: 5, speed_limit: 50 + asked.length * 10, names: ["B1"], road_class: "primary" }] }));
      },
    });
    const shape = north(100);
    const first = fittingPoints("https://valhalla.test", shape, "driving", 2000);
    const result = await source.load(shape, "driving");
    expect(asked.length).toBeGreaterThan(1);
    expect(asked.length).toBeLessThanOrEqual(4);
    for (const url of asked) expect(url.length).toBeLessThanOrEqual(2000);
    // The second part starts on the last point of the first: its indices are shifted by first - 1.
    expect(result.limits[0]).toEqual({ from: 0, to: 5, limit: 60 });
    expect(result.limits[1]).toEqual({ from: first - 1, to: first - 1 + 5, limit: 70 });
    expect(result.error).toBeNull();
  });

  it("keeps the earlier parts when a later one fails", async () => {
    let calls = 0;
    const source = createRouteStreetSource({
      url: "https://valhalla.test", maxUrlLength: 2000, chunks: 3, chunkGapMs: 0,
      fetchImpl: async () => {
        calls += 1;
        if (calls > 1) return new Response("busy", { status: 429 });
        return new Response(JSON.stringify({ edges: [{ begin_shape_index: 0, end_shape_index: 5, speed_limit: 80 }] }));
      },
    });
    const result = await source.load(north(100), "driving");
    expect(result.error).toBeNull();
    expect(result.limits).toEqual([{ from: 0, to: 5, limit: 80 }]);
  });
});

describe("speed on the glasses", () => {
  it("shows speed and limit, marks more than 5 km/h over the limit, and a dash when unknown", () => {
    expect(speedColumn({ kmh: 52, limit: 50 })).toBe("52\nkm/h\n\n[50]");
    expect(speedColumn({ kmh: 56, limit: 50 })).toBe("!56!\nkm/h\n\n[50]");
    expect(speedColumn({ kmh: null, limit: null })).toBe("—\nkm/h");
    expect(speedLine({ kmh: 52, limit: 50 })).toBe("52 | 50 km/h");
    expect(speedLine({ kmh: 57, limit: 50 })).toBe("!57! | 50 km/h");
    expect(speedLine({ kmh: null, limit: 30 })).toBe("— | 30 km/h");
    expect(overLimit(55, 50)).toBe(false);
    expect(overLimit(56, 50)).toBe(true);
    expect(overLimit(null, 50)).toBe(false);
  });

  async function progress() {
    const { route } = await createMockProvider().route({ from: { lat: 52, lon: 13 }, to: { lat: 53, lon: 14 }, mode: "driving" });
    return progressOf(update(startNavigation(route!), route!.shape[2]!));
  }
  const base = { navigating: true, rerouting: false, error: null, mock: false, waitingForFix: false } as const;

  it("puts the speed in the view while driving or cycling, in both layouts, never on foot", async () => {
    const p = await progress();
    const speed = { kmh: 52, limit: 50 };
    expect(buildView(p, { ...base, mode: "driving", bigDistance: true, speed }).speed).toBe("52\nkm/h\n\n[50]");
    expect(buildView(p, { ...base, mode: "cycling", layout: "overview", speed }).speed).toBe("52 | 50 km/h");
    expect(buildView(p, { ...base, mode: "walking", bigDistance: true, speed }).speed).toBeUndefined();
    expect(buildView(p, { ...base, mode: "driving", bigDistance: true }).speed).toBeUndefined();
  });

  it("redraws when only the speed changed", async () => {
    const p = await progress();
    const a = buildView(p, { ...base, mode: "driving", bigDistance: true, speed: { kmh: 50, limit: 50 } });
    const b = buildView(p, { ...base, mode: "driving", bigDistance: true, speed: { kmh: 51, limit: 50 } });
    expect(sameView(a, b)).toBe(false);
  });
});
