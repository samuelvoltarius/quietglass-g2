/**
 * Pure drawing for the G2 image containers — no canvas, no DOM, so every
 * graphic is testable in node and previewable as a PNG.
 *
 * Pixels are grey levels 0…15. The phone host converts every image to 4-bit
 * grey ("gray4") before it crosses BLE, so sixteen levels is all the display
 * can show; on the G2 they are sixteen brightnesses of green. 0 is off.
 *
 * Image containers are at most 288 × 144 (SDK `ImageContainerProperty`), and
 * every update is a full transfer of the image over BLE — draw rarely.
 *
 * Shared Quietglass convention: each app carries its own copy of this file.
 */

export const MAX_LEVEL = 15;

export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** Row-major grey levels, 0…15. */
  readonly pixels: Uint8Array;
}

export function createBitmap(width: number, height: number): Bitmap {
  return { width, height, pixels: new Uint8Array(width * height) };
}

export function pixel(bitmap: Bitmap, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return 0;
  return bitmap.pixels[y * bitmap.width + x] ?? 0;
}

/** Sets one pixel; anything outside the bitmap is clipped. */
export function plot(bitmap: Bitmap, x: number, y: number, level: number): void {
  const px = Math.round(x); const py = Math.round(y);
  if (px < 0 || py < 0 || px >= bitmap.width || py >= bitmap.height) return;
  bitmap.pixels[py * bitmap.width + px] = Math.max(0, Math.min(MAX_LEVEL, Math.round(level)));
}

export function fillRect(bitmap: Bitmap, x: number, y: number, width: number, height: number, level: number): void {
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) plot(bitmap, x + column, y + row, level);
}

export function strokeRect(bitmap: Bitmap, x: number, y: number, width: number, height: number, level: number): void {
  fillRect(bitmap, x, y, width, 1, level); fillRect(bitmap, x, y + height - 1, width, 1, level);
  fillRect(bitmap, x, y, 1, height, level); fillRect(bitmap, x + width - 1, y, 1, height, level);
}

/** Straight line with a square brush `thickness` pixels wide. */
export function line(bitmap: Bitmap, x0: number, y0: number, x1: number, y1: number, level: number, thickness = 1): void {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  const offset = Math.floor(thickness / 2);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x0 + ((x1 - x0) * step) / steps); const y = Math.round(y0 + ((y1 - y0) * step) / steps);
    fillRect(bitmap, x - offset, y - offset, thickness, thickness, level);
  }
}

export function fillCircle(bitmap: Bitmap, cx: number, cy: number, radius: number, level: number): void {
  for (let y = -radius; y <= radius; y += 1) for (let x = -radius; x <= radius; x += 1) if (x * x + y * y <= radius * radius + radius) plot(bitmap, cx + x, cy + y, level);
}

/** `#` cells of a text pattern, each drawn as a `scale` × `scale` block. */
export function drawPattern(bitmap: Bitmap, pattern: readonly string[], x: number, y: number, scale: number, level: number): void {
  pattern.forEach((row, rowIndex) => { for (let column = 0; column < row.length; column += 1) if (row[column] === "#") fillRect(bitmap, x + column * scale, y + rowIndex * scale, scale, scale, level); });
}

/**
 * The pixel icons' original framing: centred with a 10 px margin, scaled by a
 * whole number, beside the dotted column divider.
 */
export function drawIcon(bitmap: Bitmap, pattern: readonly string[], level = MAX_LEVEL): void {
  const rows = pattern.length; const columns = Math.max(1, ...pattern.map((row) => row.length));
  const scale = Math.max(1, Math.floor(Math.min((bitmap.width - 20) / columns, (bitmap.height - 20) / rows)));
  drawPattern(bitmap, pattern, Math.floor((bitmap.width - 2 - columns * scale) / 2), Math.floor((bitmap.height - rows * scale) / 2), scale, level);
}

/** Dotted vertical rule at the right edge that separates the icon column from the text. */
export function columnDivider(bitmap: Bitmap): void {
  for (let y = 4; y < bitmap.height; y += 8) fillRect(bitmap, bitmap.width - 2, y, 1, 3, 5);
}

/**
 * 3 × 5 pixel font for chart labels: digits, A–Z and a few signs. Lower case
 * is drawn as upper case; anything else as a space. Text inside an image
 * cannot be translated by the glasses, so labels stay short and mostly numeric.
 */
const FONT: Readonly<Record<string, readonly string[]>> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"], "1": [".#.", "##.", ".#.", ".#.", "###"], "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", ".##", "..#", "###"], "4": ["#.#", "#.#", "###", "..#", "..#"], "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"], "7": ["###", "..#", "..#", ".#.", ".#."], "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
  A: [".#.", "#.#", "###", "#.#", "#.#"], B: ["##.", "#.#", "##.", "#.#", "##."], C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."], E: ["###", "#..", "##.", "#..", "###"], F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"], H: ["#.#", "#.#", "###", "#.#", "#.#"], I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", ".#."], K: ["#.#", "#.#", "##.", "#.#", "#.#"], L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "###", "#.#", "#.#"], N: ["##.", "#.#", "#.#", "#.#", "#.#"], O: [".#.", "#.#", "#.#", "#.#", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."], Q: [".#.", "#.#", "#.#", "##.", ".##"], R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: [".##", "#..", ".#.", "..#", "##."], T: ["###", ".#.", ".#.", ".#.", ".#."], U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."], W: ["#.#", "#.#", "###", "###", "#.#"], X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."], Z: ["###", "..#", ".#.", "#..", "###"],
  "+": ["...", ".#.", "###", ".#.", "..."], "-": ["...", "...", "###", "...", "..."], "%": ["#.#", "..#", ".#.", "#..", "#.#"],
  ":": ["...", ".#.", "...", ".#.", "..."], "/": ["..#", "..#", ".#.", "#..", "#.."], ".": ["...", "...", "...", "...", ".#."], "°": ["##.", "##.", "...", "...", "..."],
};

/** Width in pixels of `text` at `scale`, without trailing spacing. */
export function textWidth(text: string, scale: number): number {
  const count = Array.from(text).length;
  return count === 0 ? 0 : count * 4 * scale - scale;
}

/** Draws `text` with its top-left corner at (x, y); returns the width drawn. */
export function drawText(bitmap: Bitmap, text: string, x: number, y: number, scale: number, level: number): number {
  Array.from(text.toUpperCase()).forEach((char, index) => { const glyph = FONT[char]; if (glyph) drawPattern(bitmap, glyph, x + index * 4 * scale, y, scale, level); });
  return textWidth(text, scale);
}

/**
 * Snaps a reading to `step` with hysteresis: the shown value only moves once
 * the reading is three quarters of a step away from it. Without this a value
 * sitting on a boundary would flip every sample and cost a transfer each time.
 */
export function quantize(previous: number | null, value: number | null, step: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const snapped = Math.round(value / step) * step;
  if (previous === null) return snapped;
  return Math.abs(value - previous) < step * 0.75 ? previous : snapped;
}
