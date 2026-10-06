import { afterEach, describe, expect, it, vi } from "vitest";
import { nearestPixel } from "../src/map/draw";
import { DEMO_ORIGIN, demoRoute, fetchRoute, parseRoute, project, readDestination, wrapLongitude, type GeoPoint } from "../src/map/model";

const span = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);

describe("map geometry", () => {
  it("projects the route into the viewport", () => {
    // Uniform scale: a 1°×1° box near the equator is a square, centred in a 100×50 viewport.
    const result = project([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }], 100, 50, 10);
    expect(result[0]?.y).toBeCloseTo(40); expect(result[1]?.y).toBeCloseTo(10);
    expect(result[0]?.x).toBeCloseTo(35, 1); expect(result[1]?.x).toBeCloseTo(65, 1);
  });
  it("rejects one-point routes", () => { expect(() => parseRoute({ points: [{ lat: 1, lon: 2 }] })).toThrow(); });
  it("normalizes bridge data", () => { expect(parseRoute({ points: [{ lat: 1, lon: 2 }, { lat: 2, lon: 3 }], instruction: "Links" }).source).toBe("bridge"); });

  it("returns nothing for an empty route", () => { expect(project([], 100, 100)).toEqual([]); });
  it("puts a single repeated point in the centre instead of a corner", () => {
    expect(project([{ lat: 5, lon: 5 }, { lat: 5, lon: 5 }], 100, 60, 10)).toEqual([{ x: 50, y: 30 }, { x: 50, y: 30 }]);
  });
  it("centres a due-north route horizontally", () => {
    // Regression: lonSpan was clamped to 0.00001, so every x became `padding` and the route hugged the left edge.
    const pixels = project([{ lat: 47.80, lon: 13.05 }, { lat: 47.81, lon: 13.05 }], 288, 144, 28);
    expect(pixels.every((pixel) => Math.abs(pixel.x - 144) < 1e-6)).toBe(true);
    expect(pixels[0]?.y).toBeCloseTo(144 - 28); expect(pixels[1]?.y).toBeCloseTo(28);
  });
  it("does not blow sub-metre jitter up into a full-width zigzag", () => {
    // Regression: x and y were stretched independently, so ~1 m of GPS noise across a 1 km northbound route filled all 232 px.
    const route = [{ lat: 47.800, lon: 13.05 }, { lat: 47.803, lon: 13.05001 }, { lat: 47.806, lon: 13.05 }, { lat: 47.809, lon: 13.05001 }];
    expect(span(project(route, 288, 144, 28).map((pixel) => pixel.x))).toBeLessThan(2);
  });
  it("keeps a right-angle turn a right angle", () => {
    // 1 km east then 1 km north at 60°N: lon degrees are half as long there.
    const pixels = project([{ lat: 60, lon: 10 }, { lat: 60, lon: 10.018 }, { lat: 60.009, lon: 10.018 }], 400, 400, 0);
    const [a, b, c] = pixels as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
    const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
    expect(Math.abs(dot)).toBeLessThan(1e-6);
    expect(Math.abs(b.x - a.x)).toBeCloseTo(Math.abs(c.y - b.y), -1);
  });
  it("keeps every point inside the padded viewport", () => {
    const pixels = project(demoRoute().points, 288, 144, 28);
    for (const pixel of pixels) { expect(pixel.x).toBeGreaterThanOrEqual(28 - 1e-9); expect(pixel.x).toBeLessThanOrEqual(260 + 1e-9); expect(pixel.y).toBeGreaterThanOrEqual(28 - 1e-9); expect(pixel.y).toBeLessThanOrEqual(116 + 1e-9); }
  });
  it("draws north up and east right", () => {
    const [start, end] = project([{ lat: 0, lon: 0 }, { lat: 0.01, lon: 0.01 }], 100, 100, 0);
    expect(end!.x).toBeGreaterThan(start!.x); expect(end!.y).toBeLessThan(start!.y);
  });
  it("keeps a route across the antimeridian contiguous", () => {
    // Regression: 179.99 → -179.99 was treated as a 360° span, flinging the points to opposite edges.
    const crossing = project([{ lat: -17, lon: 179.99 }, { lat: -17.01, lon: -179.99 }], 288, 144, 28);
    const sameShapeElsewhere = project([{ lat: -17, lon: 9.99 }, { lat: -17.01, lon: 10.01 }], 288, 144, 28);
    crossing.forEach((pixel, index) => { expect(pixel.x).toBeCloseTo(sameShapeElsewhere[index]!.x, 6); expect(pixel.y).toBeCloseTo(sameShapeElsewhere[index]!.y, 6); });
  });
  it("wraps longitude differences into -180…180", () => {
    expect(wrapLongitude(0)).toBe(0); expect(wrapLongitude(359.98)).toBeCloseTo(-0.02); expect(wrapLongitude(-359.98)).toBeCloseTo(0.02); expect(wrapLongitude(190)).toBe(-170);
  });
  it("survives routes at the poles", () => {
    const pixels = project([{ lat: 90, lon: 0 }, { lat: 89.99, lon: 90 }], 100, 100, 10);
    expect(pixels.every((pixel) => Number.isFinite(pixel.x) && Number.isFinite(pixel.y))).toBe(true);
  });
});

describe("marker placement", () => {
  it("snaps the position to the nearest route point", () => {
    const geo = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 2 }];
    const pixels = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
    expect(nearestPixel({ lat: 0.1, lon: 1.2 }, geo, pixels)).toEqual({ x: 1, y: 0 });
  });
  it("measures across the antimeridian the short way", () => {
    const geo = [{ lat: 0, lon: 170 }, { lat: 0, lon: 179.9 }];
    const pixels = [{ x: 0, y: 0 }, { x: 9, y: 0 }];
    expect(nearestPixel({ lat: 0, lon: -179.9 }, geo, pixels)).toEqual({ x: 9, y: 0 });
  });
});

describe("parsing bridge routes", () => {
  const two = [{ lat: 1, lon: 2 }, { lat: 2, lon: 3 }];
  it("drops invalid points but keeps the valid ones", () => {
    expect(parseRoute({ points: [{ lat: 1, lon: 2 }, { lat: "x", lon: 1 }, null, { lat: 2, lon: 3 }] }).points).toEqual(two);
  });
  it("throws when too few valid points remain", () => { expect(() => parseRoute({ points: [{ lat: 1, lon: 2 }, { lat: Number.NaN, lon: 0 }] })).toThrow("geometry"); });
  it("rejects coordinates outside the globe", () => {
    // Regression: lat 200 (e.g. swapped/scaled fields) was accepted and drawn.
    expect(() => parseRoute({ points: [{ lat: 1, lon: 2 }, { lat: 200, lon: 3 }] })).toThrow("geometry");
  });
  it("rejects a null body with a readable error", () => {
    // Regression: `parseRoute(null)` threw a TypeError reading `points` of null.
    expect(() => parseRoute(null)).toThrow("at least two points");
  });
  it("defaults optional fields", () => { expect(parseRoute({ points: two })).toMatchObject({ instruction: "", road: "", distanceMeters: 0 }); });
  it("leaves a missing instruction empty instead of hard-coding German", () => {
    // Regression: the fallback was "Route folgen" in every language; the UI now substitutes a translated text.
    expect(parseRoute({ points: two, instruction: "   " }).instruction).toBe("");
    expect(demoRoute().instruction).toBe("");
    expect(demoRoute("Turn right onto X").instruction).toBe("Turn right onto X");
  });
  it("starts the demo route at the exported demo origin", () => { expect(demoRoute().points[0]).toEqual(DEMO_ORIGIN); });
  it("rounds the distance shown on the lens and never shows it negative", () => {
    expect(parseRoute({ points: two, distanceMeters: 182.3456 }).distanceMeters).toBe(182);
    expect(parseRoute({ points: two, distanceMeters: -5 }).distanceMeters).toBe(0);
  });
});

describe("destination input", () => {
  const fallback: GeoPoint = { lat: 47.8131, lon: 13.0458 };
  it("parses stored coordinates", () => { expect(readDestination("48.2", "16.37", fallback)).toEqual({ lat: 48.2, lon: 16.37 }); });
  it("uses the default when nothing is stored", () => { expect(readDestination(null, null, fallback)).toBe(fallback); });
  it("never turns a blank field into 0,0", () => {
    // Regression: Number("") is 0, so clearing a field routed to the Gulf of Guinea.
    expect(readDestination("", "13.0", fallback)).toBe(fallback);
    expect(readDestination("  ", "  ", fallback)).toBe(fallback);
  });
  it("accepts a decimal comma", () => {
    // Regression: "47,8131" (German keyboard) became NaN and the bridge answered 400.
    expect(readDestination("47,8131", "13,0458", fallback)).toEqual({ lat: 47.8131, lon: 13.0458 });
  });
  it("rejects text and out-of-range values", () => {
    expect(readDestination("north", "13", fallback)).toBe(fallback);
    expect(readDestination("95", "13", fallback)).toBe(fallback);
  });
});

describe("fetching a route", () => {
  afterEach(() => { vi.useRealTimers(); });
  const body = { points: [{ lat: 1, lon: 2 }, { lat: 2, lon: 3 }], instruction: "Links", distanceMeters: 50, road: "A" };
  it("sends origin, destination and language as query parameters", async () => {
    const fetchImpl = vi.fn(async (_url: URL, _init: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
    const route = await fetchRoute("http://127.0.0.1:8791/route", { lat: 1, lon: 2 }, { lat: 3, lon: 4 }, "it", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(route.instruction).toBe("Links");
    const url = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(Object.fromEntries(url.searchParams)).toEqual({ lat: "1", lon: "2", destLat: "3", destLon: "4", lang: "it" });
  });
  it("rejects (not throws) on a malformed bridge address", async () => {
    // Regression: `new URL("127.0.0.1:8791")` threw outside the try and became an unhandled rejection.
    await expect(fetchRoute("127.0.0.1:8791", { lat: 0, lon: 0 }, { lat: 1, lon: 1 }, "en", { fetchImpl: vi.fn() as unknown as typeof fetch })).rejects.toThrow();
  });
  it("rejects HTTP errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 502 }));
    await expect(fetchRoute("http://b/route", { lat: 0, lon: 0 }, { lat: 1, lon: 1 }, "en", { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow("HTTP 502");
  });
  it("times out a bridge that never answers", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = fetchRoute("http://b/route", { lat: 0, lon: 0 }, { lat: 1, lon: 1 }, "en", { timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});
