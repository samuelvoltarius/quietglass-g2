export type PixelIcon = readonly string[];

/** The face / page sign sits in the top-right corner of the header. */
export const ICON_WIDTH = 64;
export const ICON_HEIGHT = 30;

export interface PixelBitmap {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** Builds the blocky icon as an easy-to-test grayscale bitmap. */
export function rasterizePixelIcon(pattern: PixelIcon, width = ICON_WIDTH, height = ICON_HEIGHT, padding = 1): PixelBitmap {
  const pixels = new Uint8Array(width * height);
  const rows = pattern.length;
  const columns = Math.max(1, ...pattern.map((row) => row.length));
  const scale = Math.max(1, Math.floor(Math.min((width - padding * 2) / columns, (height - padding * 2) / rows)));
  const left = Math.floor((width - columns * scale) / 2);
  const top = Math.floor((height - rows * scale) / 2);
  pattern.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] !== "#") continue;
      for (let py = 0; py < scale; py += 1) {
        for (let px = 0; px < scale; px += 1) {
          const targetX = left + x * scale + px;
          const targetY = top + y * scale + py;
          if (targetX >= 0 && targetX < width && targetY >= 0 && targetY < height) {
            pixels[targetY * width + targetX] = 255;
          }
        }
      }
    }
  });
  return { width, height, pixels };
}

/**
 * Encodes the bitmap as PNG. Despite the API name, SDK 0.0.16 and the
 * simulator expect encoded image bytes here; the phone host performs the
 * grayscale/Gray4 conversion before sending the image to the glasses.
 */
export async function renderPixelIcon(pattern: PixelIcon, width = ICON_WIDTH, height = ICON_HEIGHT): Promise<Uint8Array> {
  const bitmap = rasterizePixelIcon(pattern, width, height);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  for (let y = 0; y < bitmap.height; y += 1) {
    let x = 0;
    while (x < bitmap.width) {
      const level = bitmap.pixels[y * bitmap.width + x] ?? 0;
      let end = x + 1;
      while (end < bitmap.width && (bitmap.pixels[y * bitmap.width + end] ?? 0) === level) end += 1;
      if (level > 0) {
        ctx.fillStyle = `rgb(${level},${level},${level})`;
        ctx.fillRect(x, y, end - x, 1);
      }
      x = end;
    }
  }
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encode failed")), "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}
