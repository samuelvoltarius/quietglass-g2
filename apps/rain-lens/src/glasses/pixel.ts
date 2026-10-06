import type { Bitmap } from "./bitmap";

/**
 * Encodes a grey-level bitmap as the PNG the image container expects. The
 * host turns it into 4-bit grey for the glasses, so level n maps to n × 17.
 * This is the only part of the image pipeline that needs a browser.
 */
export async function encodePng(bitmap: Bitmap): Promise<Uint8Array> {
  const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("2d canvas unavailable");
  const image = ctx.createImageData(bitmap.width, bitmap.height);
  bitmap.pixels.forEach((level, index) => { const grey = level * 17; image.data.set([grey, grey, grey, 255], index * 4); });
  ctx.putImageData(image, 0, 0);
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encode failed")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}
