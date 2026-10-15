import { describe, expect, it } from "vitest";
import { contentBox, demoPreview, previewFrame, type GrayImage } from "../src/glasses/preview";
import { toGray } from "../src/glasses/thumb-decode";
import { createClient, MAX_THUMBNAIL_BYTES } from "../src/printer/client";
import { bitmapKey, getPixel } from "../src/glasses/gfx";
import { RING_SIZE } from "../src/glasses/charts";

/** A 40 x 40 picture with a uniformly grey 20 x 30 block in the middle. */
function block(): GrayImage {
  const width = 40, height = 40;
  const gray = new Uint8Array(width * height);
  for (let y = 5; y < 35; y += 1) for (let x = 10; x < 30; x += 1) gray[y * width + x] = 150;
  return { width, height, gray };
}

/** Brightest pixel in one row of the picture area. */
function rowMax(frame: ReturnType<typeof previewFrame>, y: number): number {
  let max = 0;
  for (let x = 0; x < frame.width; x += 1) max = Math.max(max, getPixel(frame, x, y));
  return max;
}

describe("the slicer preview frame", () => {
  it("finds the model inside its empty background", () => {
    expect(contentBox(block())).toEqual({ x0: 10, y0: 5, x1: 29, y1: 34 });
    expect(contentBox({ width: 4, height: 4, gray: new Uint8Array(16) })).toBeNull();
  });

  it("is ring-sized, so it drops into the ring's place", () => {
    const frame = previewFrame(block(), 50);
    expect(frame.width).toBe(RING_SIZE);
    expect(frame.height).toBe(RING_SIZE);
  });

  it("lights the printed share from the bottom up and keeps the rest faint", () => {
    const frame = previewFrame(block(), 50);
    // The model fills the 118 px picture area top to bottom: upper rows faint, lower rows bright.
    const upper = rowMax(frame, 20);
    const lower = rowMax(frame, 100);
    expect(upper).toBeGreaterThan(0);
    expect(upper).toBeLessThan(90);
    expect(lower).toBeGreaterThan(200);
  });

  it("is all faint at 0 % and all bright at 100 %", () => {
    expect(rowMax(previewFrame(block(), 0), 100)).toBeLessThan(90);
    expect(rowMax(previewFrame(block(), 100), 20)).toBeGreaterThan(200);
  });

  it("lights by layer height when the layer is known", () => {
    // 90 % of the bytes, but only a quarter of the layers: mostly faint.
    const frame = previewFrame(block(), 90, 0.25);
    expect(rowMax(frame, 60)).toBeLessThan(90);
    expect(rowMax(frame, 110)).toBeGreaterThan(200);
  });

  it("changes only when the percentage does", () => {
    const image = demoPreview();
    expect(bitmapKey(previewFrame(image, 42))).toBe(bitmapKey(previewFrame(image, 42.2)));
    expect(bitmapKey(previewFrame(image, 42))).not.toBe(bitmapKey(previewFrame(image, 43)));
  });

  it("still shows the percentage for an empty picture", () => {
    const frame = previewFrame({ width: 4, height: 4, gray: new Uint8Array(16) }, 73);
    let lit = 0;
    for (const value of frame.pixels) if (value > 0) lit += 1;
    expect(lit).toBeGreaterThan(50);
    expect(rowMax(frame, 40)).toBe(0);
  });

  it("clamps nonsense percentages", () => {
    expect(bitmapKey(previewFrame(block(), Number.NaN))).toBe(bitmapKey(previewFrame(block(), 0)));
    expect(bitmapKey(previewFrame(block(), 250))).toBe(bitmapKey(previewFrame(block(), 100)));
  });

  it("turns transparent pixels into background", () => {
    const rgba = [255, 255, 255, 0, 255, 255, 255, 255, 0, 0, 0, 255];
    expect([...toGray(rgba, 3, 1)]).toEqual([0, 255, 0]);
  });

  it("has a demo picture with something in it", () => {
    expect(contentBox(demoPreview())).not.toBeNull();
  });
});

describe("fetching the preview from the bridge", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const reply = (body: BodyInit | null, status = 200, type = "image/png"): Response =>
    new Response(body, { status, headers: { "content-type": type } });

  it("asks for the file by name and returns the picture", async () => {
    const urls: string[] = [];
    const client = createClient({
      baseUrl: "https://bridge.example/",
      token: "t",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input));
        expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer t");
        return reply(png);
      }) as typeof fetch,
    });
    expect(await client.thumbnail?.("parts/bracket v3.gcode")).toEqual(png);
    expect(urls).toEqual(["https://bridge.example/api/printer/thumb?file=parts%2Fbracket%20v3.gcode"]);
  });

  it("treats every failure as 'no picture'", async () => {
    const answers: Array<() => Promise<Response>> = [
      async () => reply(null, 404, "application/json"),
      async () => reply("{}", 200, "application/json"),
      async () => reply(new Uint8Array(MAX_THUMBNAIL_BYTES + 1)),
      async () => { throw new TypeError("offline"); },
    ];
    for (const answer of answers) {
      const client = createClient({ baseUrl: "https://bridge.example", fetchImpl: answer as unknown as typeof fetch });
      expect(await client.thumbnail?.("a.gcode")).toBeNull();
    }
    const client = createClient({ baseUrl: "https://bridge.example", fetchImpl: (async () => reply(png)) as unknown as typeof fetch });
    expect(await client.thumbnail?.("")).toBeNull();
  });
});
