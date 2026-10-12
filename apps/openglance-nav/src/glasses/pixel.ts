import { createGrayCanvas, encodePng } from "./png";

/** An image as rows of "#" (white) and "." (black), all rows the same length. */
export type PixelIcon = readonly string[];

/**
 * Draws a pixel pattern into a black image, each cell scaled up to a square of
 * whole pixels and the pattern centred. No canvas needed: the same bytes come
 * out in the app and in the tests.
 */
export async function renderPixelIcon(pattern: PixelIcon, width = 144, height = 144): Promise<Uint8Array> {
  const canvas = createGrayCanvas(width, height);
  const rows = pattern.length;
  const columns = Math.max(1, ...pattern.map((row) => row.length));
  const scale = Math.max(1, Math.floor(Math.min(width / columns, height / rows)));
  const left = Math.floor((width - columns * scale) / 2);
  const top = Math.floor((height - rows * scale) / 2);
  canvas.fillStyle = "#fff";
  pattern.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "#") { x++; continue; }
      let end = x;
      while (end < row.length && row[end] === "#") end++;
      canvas.fillRect(left + x * scale, top + y * scale, (end - x) * scale, scale);
      x = end;
    }
  });
  return encodePng(width, height, canvas.pixels);
}
