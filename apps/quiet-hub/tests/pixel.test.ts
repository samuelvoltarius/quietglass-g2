import { describe, expect, it } from "vitest";
import { rasterizePixelIcon } from "../src/glasses/pixel";

describe("rasterizePixelIcon", () => {
  it("returns a centered row-major grayscale bitmap", () => {
    const bitmap = rasterizePixelIcon(["#."], 20, 20);
    expect(bitmap.pixels).toBeInstanceOf(Uint8Array);
    expect(bitmap.pixels).toHaveLength(400);
    expect(bitmap.pixels).toContain(255);
    expect(bitmap.pixels).toContain(0);
  });
});
