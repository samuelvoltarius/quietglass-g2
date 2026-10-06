import type { Bitmap } from "./daybar";

/**
 * Encodes a grayscale pixel buffer as PNG for `updateImageRawData`, through
 * the same canvas path the pixel icon used. The host converts it to the G2's
 * 4-bit gray; drawing stays in the pure functions that produce the buffer.
 * Runs of equal pixels become one rectangle each.
 */
export async function encodeBitmap(bitmap: Bitmap): Promise<Uint8Array> {
  const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("2d canvas unavailable");
  ctx.imageSmoothingEnabled = false; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  for (let y = 0; y < bitmap.height; y++) {
    let x = 0;
    while (x < bitmap.width) {
      const level = bitmap.pixels[y * bitmap.width + x] ?? 0;
      let end = x + 1;
      while (end < bitmap.width && (bitmap.pixels[y * bitmap.width + end] ?? 0) === level) end++;
      if (level > 0) { ctx.fillStyle = `rgb(${level},${level},${level})`; ctx.fillRect(x, y, end - x, 1); }
      x = end;
    }
  }
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encode failed")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}
