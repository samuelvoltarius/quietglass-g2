export type PixelIcon = readonly string[];

export async function renderPixelIcon(pattern: PixelIcon, width = 96, height = 144): Promise<Uint8Array> {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("2d canvas unavailable");
  ctx.imageSmoothingEnabled = false; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#555"; for (let y = 4; y < height; y += 8) ctx.fillRect(width - 2, y, 1, 3);
  const rows = pattern.length; const columns = Math.max(1, ...pattern.map((row) => row.length));
  // 12 px margin: a 10-column arrow is drawn 80 px wide, as large as the 96 px container allows.
  const scale = Math.max(1, Math.floor(Math.min((width - 12) / columns, (height - 12) / rows)));
  const left = Math.floor((width - 2 - columns * scale) / 2); const top = Math.floor((height - rows * scale) / 2);
  ctx.fillStyle = "#fff"; pattern.forEach((row, y) => { for (let x = 0; x < row.length; x += 1) if (row[x] === "#") ctx.fillRect(left + x * scale, top + y * scale, scale, scale); });
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encode failed")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

