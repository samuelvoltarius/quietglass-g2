import { describe, expect, it } from "vitest";
import { approachSteps, APPROACH_WINDOW_M, BAR_STEPS, cardKey } from "../src/glasses/turncard";
import { crc32, encodePng, grayOf, zlibStored } from "../src/glasses/png";

describe("approach bar", () => {
  it("is empty far away, fills as the turn comes closer, full at the turn", () => {
    expect(approachSteps(1000, 2000, "walking")).toBe(0);
    expect(approachSteps(APPROACH_WINDOW_M.walking, 2000, "walking")).toBe(0);
    expect(approachSteps(75, 2000, "walking")).toBe(BAR_STEPS / 2);
    expect(approachSteps(0, 2000, "walking")).toBe(BAR_STEPS);
    const steps = [600, 450, 300, 150, 0].map((d) => approachSteps(d, 5000, "driving"));
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  it("spans a short stretch instead of the whole window, so it starts empty after a quick double turn", () => {
    expect(approachSteps(40, 40, "driving")).toBe(0);
    expect(approachSteps(20, 40, "driving")).toBe(BAR_STEPS / 2);
  });

  it("never leaves 0…BAR_STEPS", () => {
    for (const d of [-5, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      const s = approachSteps(d, 0, "cycling");
      expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(BAR_STEPS);
    }
  });

  it("changes key only when what it shows changes", () => {
    expect(cardKey({ label: "250 m", steps: 2 })).toBe(cardKey({ label: "250 m", steps: 2 }));
    expect(cardKey({ label: "250 m", steps: 2 })).not.toBe(cardKey({ label: "250 m", steps: 3 }));
    expect(cardKey(null)).toBe("blank");
  });
});

describe("PNG encoder", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes stored deflate blocks that decompress to the input", async () => {
    const data = new Uint8Array(70_000).map((_, i) => i % 251);
    const stream = new Blob([zlibStored(data) as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(data);
  });

  it("reads hex colours as grey", () => {
    expect(grayOf("#fff")).toBe(255); expect(grayOf("#000000")).toBe(0); expect(grayOf("red")).toBe(0);
    expect(grayOf("#808080")).toBe(128);
  });

  it("keeps the image size in the header", async () => {
    const png = await encodePng(3, 2, new Uint8Array(6));
    const view = new DataView(png.buffer, png.byteOffset);
    expect([view.getUint32(16), view.getUint32(20), png[24], png[25]]).toEqual([3, 2, 8, 6]);
  });
});
