import { describe, expect, it } from "vitest";
import { blit, createFrame, crop, frameKey, tiles, type Frame } from "../src/screen/frame";
import { crosshair, dashedCircle, dashedLine, fillRect, line, read, triangle } from "../src/screen/draw";
import { canvasBackend, drawText, ELLIPSIS, fitFont, fitText, pixelBackend, type TextBackend } from "../src/screen/text";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { encodeGreyPng } from "../src/screen/png";

/** A measuring backend: every character is 0.6 x size wide; it renders full boxes so positions can be checked. */
const measuring: TextBackend = {
  name: "measure",
  measure: (text, font) => Math.round(Array.from(text).length * font.size * 0.6),
  render: (text, font) => {
    const width = Math.max(1, Math.round(Array.from(text).length * font.size * 0.6)); const height = Math.round(font.size * 0.7);
    return { width, height, baseline: height, left: 0, alpha: new Uint8Array(width * height).fill(255) };
  },
};

const lit = (frame: Frame): number => frame.pixels.reduce((sum, level) => sum + (level > 0 ? 1 : 0), 0);
const bounds = (frame: Frame): { left: number; right: number; top: number; bottom: number } => {
  let left = Infinity; let right = -1; let top = Infinity; let bottom = -1;
  for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) if (frame.pixels[y * frame.width + x]! > 0) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  return { left, right, top, bottom };
};

describe("frame and tiles", () => {
  it("cuts a 576 x 288 frame into four 288 x 144 tiles in container order", () => {
    const frame = createFrame();
    fillRect(frame, 300, 10, 1, 1, 9); fillRect(frame, 5, 200, 1, 1, 7);
    const [nw, ne, sw, se] = tiles(frame);
    expect([nw, ne, sw, se].map((tile) => `${tile.width}x${tile.height}`)).toEqual(Array(4).fill("288x144"));
    expect(read(ne, 12, 10)).toBe(9);
    expect(read(sw, 5, 56)).toBe(7);
    expect(lit(nw) + lit(se)).toBe(0);
  });
  it("gives equal pictures equal keys and different ones different keys", () => {
    const a = createFrame(20, 20); const b = createFrame(20, 20);
    expect(frameKey(a)).toBe(frameKey(b));
    fillRect(b, 3, 3, 1, 1, 1);
    expect(frameKey(a)).not.toBe(frameKey(b));
    expect(frameKey(createFrame(10, 40))).not.toBe(frameKey(a));
  });
  it("crops and blits with clipping", () => {
    const frame = createFrame(10, 10); fillRect(frame, 0, 0, 10, 10, 4);
    const piece = crop(frame, 8, 8, 4, 4);
    expect(lit(piece)).toBe(4);
    const target = createFrame(5, 5); blit(target, piece, 3, 3);
    expect(read(target, 3, 3)).toBe(4); expect(read(target, 4, 4)).toBe(4); expect(read(target, 2, 2)).toBe(0); expect(lit(target)).toBe(4);
  });
});

describe("primitives", () => {
  it("draws dashed lines with gaps and solid lines without", () => {
    const solid = createFrame(40, 3); line(solid, 0, 1, 39, 1, 15);
    const dashed = createFrame(40, 3); dashedLine(dashed, 0, 1, 39, 1, 15, { dash: 4, gap: 4 });
    expect(lit(solid)).toBe(40);
    expect(lit(dashed)).toBe(20);
  });
  it("draws a dashed circle round its centre", () => {
    const frame = createFrame(60, 60); dashedCircle(frame, 30, 30, 20, 9);
    expect(bounds(frame)).toEqual({ left: 10, right: 50, top: 10, bottom: 50 });
    expect(read(frame, 30, 30)).toBe(0);
  });
  it("points a triangle where it is told (0 = up)", () => {
    const up = createFrame(30, 30); triangle(up, 15, 15, 8, 0, 15);
    const box = bounds(up);
    expect(box.top).toBeLessThan(10); expect(box.bottom).toBeLessThan(22);
    const right = createFrame(30, 30); triangle(right, 15, 15, 8, 90, 15);
    expect(bounds(right).right).toBeGreaterThan(21);
  });
  it("leaves the crosshair centre point lit and its gap free, with a black halo", () => {
    const frame = createFrame(40, 40); fillRect(frame, 0, 0, 40, 40, 5);
    crosshair(frame, 20, 20, 15, { arm: 9, gap: 3 });
    expect(read(frame, 20, 20)).toBe(15);
    expect(read(frame, 22, 20)).toBe(0);
    expect(read(frame, 26, 20)).toBe(15);
    expect(read(frame, 26, 21)).toBe(0);
  });
});

describe("text layout", () => {
  const font = { size: 20 };
  it("keeps text that fits and cuts longer text with an ellipsis", () => {
    expect(fitText(measuring, "REGEN", font, 100)).toBe("REGEN");
    // 12 px per character: 100 px hold 8 characters, the ellipsis one of them.
    expect(fitText(measuring, "REGEN IN 25 MINUTEN", font, 100)).toBe("REGEN I" + ELLIPSIS);
    expect(measuring.measure(fitText(measuring, "REGEN IN 25 MINUTEN", font, 100), font)).toBeLessThanOrEqual(100);
    expect(fitText(measuring, "ABC", font, 5)).toBe("");
  });
  it("does not leave a space before the ellipsis", () => {
    expect(fitText(measuring, "AB CDEFGH", font, 48)).toBe("AB" + ELLIPSIS);
  });
  it("picks the biggest size that fits", () => {
    expect(fitFont(measuring, "TROCKEN", font, [40, 32, 24], 200).size).toBe(40);
    expect(fitFont(measuring, "TROCKEN BIS 18:00", font, [40, 32, 24], 270).size).toBe(24);
    expect(fitFont(measuring, "A VERY VERY LONG LINE", font, [40, 32, 24], 50).size).toBe(24);
  });
  it("aligns left, right and centre", () => {
    const at = (align: "left" | "right" | "center"): ReturnType<typeof bounds> => { const frame = createFrame(200, 40); drawText(frame, measuring, "ABCD", 100, 0, font, { align }); return bounds(frame); };
    expect(at("left").left).toBe(100);
    expect(at("right").right).toBe(99);
    const centre = at("center"); expect(centre.left).toBe(76); expect(centre.right).toBe(123);
  });
  it("sits every backend on the same baseline", () => {
    const frame = createFrame(200, 60); drawText(frame, pixelBackend(), "X", 0, 10, { size: 40 });
    const other = createFrame(200, 60); drawText(other, measuring, "X", 0, 10, { size: 40 });
    expect(bounds(frame).bottom).toBe(bounds(other).bottom);
  });
  it("draws a black halo when asked", () => {
    const frame = createFrame(60, 30); fillRect(frame, 0, 0, 60, 30, 6);
    drawText(frame, pixelBackend(), "I", 10, 0, { size: 20 }, { halo: true, level: 15 });
    expect(Array.from(frame.pixels)).toContain(0);
    expect(Array.from(frame.pixels)).toContain(15);
  });
  it("draws with the pixel font in node and measures what it draws", () => {
    const backend = pixelBackend(); const frame = createFrame(300, 40);
    const drawn = drawText(frame, backend, "Böen 72", 0, 0, { size: 20 });
    const box = bounds(frame);
    expect(box.right - box.left + 1).toBe(drawn.width);
  });
  it("has no canvas backend without a canvas, and refuses a canvas that cannot measure", () => {
    expect(canvasBackend(null)).toBeNull();
    expect(canvasBackend({ width: 0, height: 0, getContext: () => ({ drawImage: () => undefined }) })).toBeNull();
  });
  it("reads coverage back from a canvas as grey", () => {
    const pixels = new Uint8ClampedArray(400 * 400 * 4);
    const ctx = { font: "", fillStyle: "", textBaseline: "", measureText: (text: string) => ({ width: text.length * 10 }), clearRect: () => undefined, fillText: () => undefined,
      getImageData: (_x: number, _y: number, w: number, h: number) => { const data = new Uint8ClampedArray(w * h * 4); data[3] = 255; data[7] = 128; void pixels; return { data }; } };
    const backend = canvasBackend({ width: 0, height: 0, getContext: () => ctx })!;
    expect(backend.name).toBe("canvas");
    const glyphs = backend.render("AB", { size: 20 });
    expect(glyphs.alpha[0]).toBe(255);
    expect(glyphs.alpha[1]).toBeGreaterThan(128);
    expect(backend.render("AB", { size: 20 })).toBe(glyphs);
  });
});

describe("tile sender", () => {
  const setup = () => {
    const sent: string[] = [];
    const sender = createTileSender(tileSlots(21, "cockpit"), async (slot) => { sent.push(slot.name); return true; });
    return { sent, sender };
  };
  it("sends all four tiles of the first frame, then only the tiles that changed", async () => {
    const { sent, sender } = setup();
    const frame = createFrame();
    await sender.push(frame);
    expect(sent).toEqual(["cockpit-nw", "cockpit-ne", "cockpit-sw", "cockpit-se"]);
    await sender.push(createFrame());
    expect(sent).toHaveLength(4);
    const clock = createFrame(); fillRect(clock, 500, 5, 30, 10, 15);
    await sender.push(clock);
    expect(sent.slice(4)).toEqual(["cockpit-ne"]);
    const loop = createFrame(); fillRect(loop, 500, 5, 30, 10, 15); fillRect(loop, 100, 100, 20, 100, 9);
    await sender.push(loop);
    expect(sent.slice(5)).toEqual(["cockpit-nw", "cockpit-sw"]);
    expect(sender.sent()).toBe(7);
    expect(sender.idle()).toBe(true);
  });
  it("sends everything again after a page rebuild", async () => {
    const { sent, sender } = setup();
    await sender.push(createFrame()); sender.reset(); await sender.push(createFrame());
    expect(sent).toHaveLength(8);
  });
  it("lets the newest frame win while a transfer is in flight", async () => {
    const sent: string[] = []; let release: (() => void) | null = null;
    const sender = createTileSender(tileSlots(21, "c"), (slot) => new Promise((resolve) => { sent.push(slot.name); release = () => resolve(true); }));
    const first = createFrame(); fillRect(first, 0, 0, 10, 10, 3);
    void sender.push(first);
    expect(sender.idle()).toBe(false);
    const second = createFrame(); fillRect(second, 0, 0, 10, 10, 8);
    const done = sender.push(second);
    for (let i = 0; i < 6 && release; i += 1) { const go = release as () => void; release = null; go(); await new Promise((r) => setTimeout(r, 0)); }
    await done;
    // The first nw transfer was under way; then the second frame's nw, and the three blank tiles once.
    expect(sent).toEqual(["c-nw", "c-nw", "c-ne", "c-sw", "c-se"]);
  });
  it("tries a failed tile again with the next push", async () => {
    let fail = true; const sent: string[] = [];
    const sender = createTileSender(tileSlots(1, "t"), async (slot) => { sent.push(slot.name); return !(fail && slot.name === "t-se"); });
    await sender.push(createFrame());
    fail = false;
    await sender.push(createFrame());
    expect(sent).toEqual(["t-nw", "t-ne", "t-sw", "t-se", "t-se"]);
  });
  it("encodes a valid 8-bit grey PNG", () => {
    const png = encodeGreyPng(createFrame(288, 144));
    expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png[24]).toBe(8); expect(png[25]).toBe(0);
  });
});
