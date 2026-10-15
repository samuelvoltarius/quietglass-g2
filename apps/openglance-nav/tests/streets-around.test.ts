import { describe, expect, it } from "vitest";
import { AROUND_RADIUS_M, AROUND_REFETCH_EDGE_M, boxAround, classesFor, spanMeters, wellInside } from "../src/overview/streets";

// 15.10.: on a 116 km route the map never showed a side street - the streets
// were asked for the whole route's box, which is above every class limit.
describe("streets around the car", () => {
  const salzburg = { lat: 47.8, lon: 13.04 };

  it("asks for major and minor roads by car, and footpaths too on foot", () => {
    const car = boxAround(salzburg, AROUND_RADIUS_M.driving)!;
    expect(classesFor(car, "driving")).toEqual(["major", "minor"]);
    const foot = boxAround(salzburg, AROUND_RADIUS_M.walking)!;
    expect(classesFor(foot, "walking")).toEqual(["major", "minor", "path"]);
    expect(spanMeters(car)).toBeGreaterThan(3_000);
  });

  it("fetches again only near the edge of what was loaded", () => {
    const box = boxAround(salzburg, AROUND_RADIUS_M.driving)!;
    expect(wellInside(box, salzburg, AROUND_REFETCH_EDGE_M)).toBe(true);
    // 1.5 km north: within 600 m of the edge (radius 1.9 km).
    expect(wellInside(box, { lat: salzburg.lat + 1_500 / 111_320, lon: salzburg.lon }, AROUND_REFETCH_EDGE_M)).toBe(false);
  });
});
