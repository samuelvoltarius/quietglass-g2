import { describe, expect, it } from "vitest";
import { parseRoute, project } from "../src/map/model";
describe("map geometry", () => {
  it("projects the route into the viewport", () => { const result = project([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }], 100, 50, 10); expect(result).toEqual([{ x: 10, y: 40 }, { x: 90, y: 10 }]); });
  it("rejects one-point routes", () => { expect(() => parseRoute({ points: [{ lat: 1, lon: 2 }] })).toThrow(); });
  it("normalizes bridge data", () => { expect(parseRoute({ points: [{ lat: 1, lon: 2 }, { lat: 2, lon: 3 }], instruction: "Links" }).source).toBe("bridge"); });
});
