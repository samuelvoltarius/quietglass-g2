import type { GrayImage } from "./preview";

/** Longest side the preview is reduced to before it is kept; the frame is 144 px anyway. */
const MAX_SIDE = 192;

/**
 * Turns the slicer's PNG preview into brightness values, using the WebView's
 * own image decoder. Transparent pixels become background (0). Returns null
 * when the picture cannot be decoded here — the ring is shown instead.
 */
export async function decodeThumbnail(bytes: Uint8Array): Promise<GrayImage | null> {
  try {
    if (typeof createImageBitmap !== "function") return null;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const source = await createImageBitmap(new Blob([copy.buffer], { type: "image/png" }));
    const scale = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) return null;
    context.drawImage(source, 0, 0, width, height);
    source.close?.();
    const rgba = context.getImageData(0, 0, width, height).data;
    return { width, height, gray: toGray(rgba, width, height) };
  } catch {
    return null;
  }
}

/** Luminance weighted by alpha, so a transparent background reads as 0. */
export function toGray(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const r = rgba[i * 4]!, g = rgba[i * 4 + 1]!, b = rgba[i * 4 + 2]!, a = rgba[i * 4 + 3]!;
    gray[i] = Math.round(((0.299 * r + 0.587 * g + 0.114 * b) * a) / 255);
  }
  return gray;
}
