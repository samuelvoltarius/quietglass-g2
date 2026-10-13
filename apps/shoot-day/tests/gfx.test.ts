import { describe, expect, it } from "vitest";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  bitmapKey, createBitmap, drawPattern, drawText, encodePng, fillRect, getPixel, iconBitmap, line, textWidth,
} from "../src/glasses/gfx";
import { IMAGE_LIMITS, ImageLink, type ImageSlot } from "../src/glasses/images";

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("bitmap kit", () => {
  it("clips drawing at the edges instead of throwing", () => {
    const b = createBitmap(10, 10);
    fillRect(b, -5, -5, 30, 30);
    line(b, -20, -20, 40, 40, 255, 3);
    expect(b.pixels).toHaveLength(100);
    expect(getPixel(b, 99, 99)).toBe(0);
  });

  it("draws text in the pixel font and reports its width", () => {
    const b = createBitmap(80, 20);
    const width = drawText(b, "120", 2, 2, 2);
    expect(width).toBe(textWidth("120", 2));
    expect(b.pixels.some((v) => v > 0)).toBe(true);
    // Unknown characters stay blank, they never throw.
    expect(() => drawText(b, "~?", 0, 0, 1)).not.toThrow();
  });

  it("centres an icon pattern and keeps it inside the image", () => {
    const icon = iconBitmap(["#.#", ".#.", "#.#"], 64, 30);
    expect(icon.width).toBe(64);
    expect(icon.height).toBe(30);
    expect(getPixel(icon, 0, 0)).toBe(0);
    expect(icon.pixels.some((v) => v > 0)).toBe(true);
  });

  it("dim and mid cells of a pattern get their own gray level", () => {
    const b = createBitmap(4, 1);
    drawPattern(b, ["#+-."], 0, 0);
    expect([...b.pixels]).toEqual([255, 160, 85, 0]);
  });

  it("equal bitmaps have equal keys, a changed pixel changes the key", () => {
    const a = createBitmap(8, 8);
    const c = createBitmap(8, 8);
    expect(bitmapKey(a)).toBe(bitmapKey(c));
    fillRect(c, 1, 1, 1, 1);
    expect(bitmapKey(a)).not.toBe(bitmapKey(c));
  });
});

describe("PNG encoder", () => {
  it("writes a valid grayscale PNG whose pixels decode back", async () => {
    const b = createBitmap(37, 11);
    line(b, 0, 0, 36, 10);
    fillRect(b, 5, 5, 3, 3, 85);
    const png = encodePng(b);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(37);
    expect(view.getUint32(20)).toBe(11);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(0);
    // IDAT: length at 33, type at 37, data from 41 (after the 25-byte IHDR chunk).
    const length = view.getUint32(33);
    const raw = await inflate(png.slice(41, 41 + length));
    expect(raw).toHaveLength((37 + 1) * 11);
    for (let y = 0; y < 11; y += 1) {
      expect(raw[y * 38]).toBe(0);
      expect([...raw.slice(y * 38 + 1, (y + 1) * 38)]).toEqual([...b.pixels.slice(y * 37, (y + 1) * 37)]);
    }
  });

  it("splits big images over several stored blocks", async () => {
    const b = createBitmap(288, 144);
    fillRect(b, 10, 10, 200, 100, 255);
    const png = encodePng(b);
    const length = new DataView(png.buffer, png.byteOffset).getUint32(33);
    const raw = await inflate(png.slice(41, 41 + length));
    expect(raw).toHaveLength(289 * 144);
  });
});

describe("image link", () => {
  const slot: ImageSlot = { id: 5, name: "test", x: 0, y: 0, width: 64, height: 30, z: 5 };
  function bridge(result: unknown = "success") {
    const sent: unknown[] = [];
    const fake = { updateImageRawData: async (update: unknown) => { sent.push(update); return result; } } as unknown as EvenAppBridge;
    return { fake, sent };
  }

  it("sends a picture once and skips it while it is unchanged", async () => {
    const { fake, sent } = bridge();
    const link = new ImageLink();
    const b = createBitmap(64, 30);
    expect((await link.push(fake, slot, b)).sent).toBe(true);
    expect((await link.push(fake, slot, createBitmap(64, 30))).sent).toBe(false);
    fillRect(b, 3, 3, 4, 4);
    expect((await link.push(fake, slot, b)).sent).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("sends again after the page was rebuilt", async () => {
    const { fake, sent } = bridge();
    const link = new ImageLink();
    const b = createBitmap(64, 30);
    await link.push(fake, slot, b);
    link.reset();
    await link.push(fake, slot, b);
    expect(sent).toHaveLength(2);
  });

  it("reports a refused or failing image and does not remember it as shown", async () => {
    const refused = bridge("imageSizeInvalid");
    const link = new ImageLink();
    const b = createBitmap(64, 30);
    expect((await link.push(refused.fake, slot, b)).ok).toBe(false);
    const ok = bridge();
    expect((await link.push(ok.fake, slot, b)).sent).toBe(true);
    const broken = { updateImageRawData: async () => { throw new Error("ble gone"); } } as unknown as EvenAppBridge;
    expect((await new ImageLink().push(broken, slot, b)).reason).toBe("ble gone");
  });

  it("knows the SDK limits", () => {
    expect(IMAGE_LIMITS.maxContainers).toBe(4);
    expect(IMAGE_LIMITS.maxWidth).toBe(288);
  });
});
