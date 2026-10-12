import { describe, expect, it } from "vitest";
import { nearestPixel } from "../src/overview/layout";
import { project, thinPoints, wrapLongitude } from "../src/overview/project";
import type { LatLng } from "../src/geo/geometry";

// Ported from apps/map-glass (tests/map.test.ts) with the projection; the
// regressions they pin travelled with the code. Map drawing is in drive-map.test.ts.

const span = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);
const DEMO_ROUTE: LatLng[] = [
  { lat: 47.806, lon: 13.052 }, { lat: 47.807, lon: 13.053 }, { lat: 47.808, lon: 13.054 },
  { lat: 47.809, lon: 13.056 }, { lat: 47.8105, lon: 13.057 }, { lat: 47.811, lon: 13.059 },
];

describe("overview projection", () => {
  it("projects the route into the viewport", () => {
    // Uniform scale: a 1°×1° box near the equator is a square, centred in a 100×50 viewport.
    const result = project([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }], 100, 50, 10);
    expect(result[0]?.y).toBeCloseTo(40); expect(result[1]?.y).toBeCloseTo(10);
    expect(result[0]?.x).toBeCloseTo(35, 1); expect(result[1]?.x).toBeCloseTo(65, 1);
  });
  it("returns nothing for an empty route", () => { expect(project([], 100, 100)).toEqual([]); });
  it("puts a single repeated point in the centre instead of a corner", () => {
    expect(project([{ lat: 5, lon: 5 }, { lat: 5, lon: 5 }], 100, 60, 10)).toEqual([{ x: 50, y: 30 }, { x: 50, y: 30 }]);
  });
  it("centres a due-north route horizontally", () => {
    // Regression (Map Glass): lonSpan was clamped, so every x became `padding` and the route hugged the left edge.
    const pixels = project([{ lat: 47.80, lon: 13.05 }, { lat: 47.81, lon: 13.05 }], 288, 144, 28);
    expect(pixels.every((pixel) => Math.abs(pixel.x - 144) < 1e-6)).toBe(true);
    expect(pixels[0]?.y).toBeCloseTo(144 - 28); expect(pixels[1]?.y).toBeCloseTo(28);
  });
  it("does not blow sub-metre jitter up into a full-width zigzag", () => {
    // Regression (Map Glass): x and y were stretched independently, so ~1 m of GPS noise filled the width.
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
    for (const pixel of project(DEMO_ROUTE, 288, 144, 28)) {
      expect(pixel.x).toBeGreaterThanOrEqual(28 - 1e-9); expect(pixel.x).toBeLessThanOrEqual(260 + 1e-9);
      expect(pixel.y).toBeGreaterThanOrEqual(28 - 1e-9); expect(pixel.y).toBeLessThanOrEqual(116 + 1e-9);
    }
  });
  it("draws north up and east right", () => {
    const [start, end] = project([{ lat: 0, lon: 0 }, { lat: 0.01, lon: 0.01 }], 100, 100, 0);
    expect(end!.x).toBeGreaterThan(start!.x); expect(end!.y).toBeLessThan(start!.y);
  });
  it("keeps a route across the antimeridian contiguous", () => {
    // Regression (Map Glass): 179.99 → -179.99 was treated as a 360° span, flinging the points to opposite edges.
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
  it("handles a route far longer than a spread call could take", () => {
    // A cross-country Valhalla shape has well over 100 000 points.
    const long = Array.from({ length: 200_000 }, (_, i) => ({ lat: 47 + i * 1e-5, lon: 13 + i * 1e-5 }));
    const pixels = project(long, 288, 144, 28);
    expect(pixels).toHaveLength(200_000);
    expect(Number.isFinite(pixels[199_999]!.x)).toBe(true);
  });
});

describe("thinning the route for the image", () => {
  it("keeps short routes untouched", () => { expect(thinPoints([1, 2, 3], 10)).toEqual([1, 2, 3]); });
  it("caps the point count and always keeps both ends", () => {
    const points = Array.from({ length: 10_001 }, (_, i) => i);
    const thinned = thinPoints(points, 600);
    expect(thinned).toHaveLength(600);
    expect(thinned[0]).toBe(0);
    expect(thinned[599]).toBe(10_000);
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
    const pixels = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
    expect(nearestPixel({ lat: 0, lon: -179.9 }, geo, pixels)).toEqual({ x: 1, y: 0 });
  });
});
