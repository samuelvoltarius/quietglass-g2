export type PixelIcon = readonly string[];

/** The sign sits in the top-right corner of the header. */
export const ICON_WIDTH = 64;
export const ICON_HEIGHT = 30;

export async function renderPixelIcon(pattern: PixelIcon, width = ICON_WIDTH, height = ICON_HEIGHT): Promise<Uint8Array> {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("2d canvas unavailable");
  ctx.imageSmoothingEnabled = false; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
  const rows = pattern.length; const columns = Math.max(1, ...pattern.map((row) => row.length));
  const scale = Math.max(1, Math.floor(Math.min((width - 2) / columns, (height - 2) / rows)));
  const left = Math.floor((width - columns * scale) / 2); const top = Math.floor((height - rows * scale) / 2);
  ctx.fillStyle = "#fff"; pattern.forEach((row, y) => { for (let x = 0; x < row.length; x += 1) if (row[x] === "#") ctx.fillRect(left + x * scale, top + y * scale, scale, scale); });
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encode failed")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

