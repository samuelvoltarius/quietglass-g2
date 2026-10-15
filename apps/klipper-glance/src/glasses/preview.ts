import { DIM, FULL, createBitmap, drawText, fillRect, textWidth, type Bitmap } from "./gfx";
import { RING_SIZE } from "./charts";

/**
 * The slicer's preview picture of the part being printed, in place of the
 * progress ring: the model "fills up" from the bottom as the print advances —
 * the printed share bright, the rest faint — with the percentage underneath.
 * Pure function of the picture and the percentage, so it is only resent when
 * the percentage changes.
 */

/** A decoded preview: one brightness value per pixel, 0 = background. */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly gray: Uint8Array;
}

/** Height of the label strip under the picture (percentage + thin bar). */
const LABEL = 26;
/** Brightness of the part that is not printed yet, as a share of its own value. */
const GHOST = 0.28;
/** Pixels at or below this count as background (transparent or black in the slicer image). */
const BACKGROUND = 12;

/** Rows and columns that hold anything but background, or null for an empty picture. */
export function contentBox(image: GrayImage): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = image.width, y0 = image.height, x1 = -1, y1 = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.gray[y * image.width + x]! <= BACKGROUND) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * `percent` is the label; `heightShare` (0..1, e.g. layer / layers) sets how much of
 * the model is lit — print progress counts file bytes, which does not follow the
 * part's height. Without it the percentage is used for both.
 */
export function previewFrame(image: GrayImage, percent: number, heightShare?: number | null, size = RING_SIZE): Bitmap {
  const value = Math.max(0, Math.min(100, Math.round(Number.isFinite(percent) ? percent : 0)));
  const share = heightShare != null && Number.isFinite(heightShare) ? Math.max(0, Math.min(1, heightShare)) : value / 100;
  const b = createBitmap(size, size);
  const box = contentBox(image);
  const areaW = size;
  const areaH = size - LABEL;

  if (box) {
    const srcW = box.x1 - box.x0 + 1;
    const srcH = box.y1 - box.y0 + 1;
    const scale = Math.min(areaW / srcW, areaH / srcH);
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const left = Math.floor((areaW - w) / 2);
    const top = Math.floor((areaH - h) / 2);

    // Stretch the model's own brightness range to the full scale: slicer previews are often dull.
    let low = 255, high = 0;
    for (let y = box.y0; y <= box.y1; y += 1) {
      for (let x = box.x0; x <= box.x1; x += 1) {
        const v = image.gray[y * image.width + x]!;
        if (v <= BACKGROUND) continue;
        if (v < low) low = v;
        if (v > high) high = v;
      }
    }
    const span = high - low;
    // A (nearly) single-coloured preview has nothing to stretch: show it evenly bright.
    const flat = span < 40;

    // The printed share, measured over the rows that hold the model, from the bottom up.
    const filledFrom = top + h - Math.round(share * h);
    for (let y = 0; y < h; y += 1) {
      const sy = box.y0 + Math.min(srcH - 1, Math.floor(y / scale));
      for (let x = 0; x < w; x += 1) {
        const sx = box.x0 + Math.min(srcW - 1, Math.floor(x / scale));
        const v = image.gray[sy * image.width + sx]!;
        if (v <= BACKGROUND) continue;
        const bright = flat ? 230 : 70 + Math.round(((v - low) / span) * (FULL - 70));
        const py = top + y;
        b.pixels[py * size + left + x] = py >= filledFrom ? bright : Math.max(24, Math.round(bright * GHOST));
      }
    }
  }

  // Label: "73 %" centred, a thin bar under it.
  const label = value + " %";
  const scale = 2;
  drawText(b, label, Math.round((size - textWidth(label, scale)) / 2), size - LABEL + 4, scale);
  const barY = size - 5;
  fillRect(b, 8, barY, size - 16, 2, DIM);
  fillRect(b, 8, barY, Math.round(((size - 16) * value) / 100), 2, FULL);
  return b;
}

/**
 * A made-up preview for the demo printer and the simulator: a bracket-like
 * shape, so the fill effect can be seen without a printer.
 */
export function demoPreview(width = 160, height = 120): GrayImage {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base = y > 80 && y < 110 && x > 15 && x < 145;
      const upright = x > 15 && x < 50 && y > 15 && y <= 80;
      const hole = (x - 32) ** 2 + (y - 40) ** 2 < 70;
      const rib = x >= 50 && x < 100 && y > 80 - (x - 50) * 1.2 && y <= 80;
      if ((base || upright || rib) && !hole) gray[y * width + x] = 120 + Math.round((x / width) * 100) - (y % 7 === 0 ? 30 : 0);
    }
  }
  return { width, height, gray };
}
