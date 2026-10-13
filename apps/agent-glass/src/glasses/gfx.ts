/**
 * Tiny drawing kit for the glasses' image containers.
 *
 * Everything is a pure function over a grayscale bitmap (0 = black, 255 =
 * brightest green), so every frame can be tested without a browser. The bitmap
 * is encoded as PNG by hand (stored deflate blocks, no canvas): SDK 0.0.16 and
 * the simulator take encoded image bytes, and the phone host converts them to
 * Gray4 before they cross BLE.
 */

export interface Bitmap {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** Dimmed ink for grids, tracks and secondary marks (Gray4 keeps it distinct from 255). */
export const DIM = 85;
export const MID = 160;
export const FULL = 255;

export function createBitmap(width: number, height: number, fill = 0): Bitmap {
  return { width, height, pixels: new Uint8Array(width * height).fill(fill) };
}

export function setPixel(b: Bitmap, x: number, y: number, value = FULL): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= b.width || py >= b.height) return;
  b.pixels[py * b.width + px] = value;
}

export function getPixel(b: Bitmap, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= b.width || y >= b.height) return 0;
  return b.pixels[y * b.width + x] ?? 0;
}

export function fillRect(b: Bitmap, x: number, y: number, w: number, h: number, value = FULL): void {
  for (let py = Math.round(y); py < Math.round(y) + Math.round(h); py += 1) {
    for (let px = Math.round(x); px < Math.round(x) + Math.round(w); px += 1) setPixel(b, px, py, value);
  }
}

export function strokeRect(b: Bitmap, x: number, y: number, w: number, h: number, value = FULL, thickness = 1): void {
  fillRect(b, x, y, w, thickness, value);
  fillRect(b, x, y + h - thickness, w, thickness, value);
  fillRect(b, x, y, thickness, h, value);
  fillRect(b, x + w - thickness, y, thickness, h, value);
}

/** Bresenham line, `thickness` pixels wide (a square brush). */
export function line(b: Bitmap, x0: number, y0: number, x1: number, y1: number, value = FULL, thickness = 1): void {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const tx = Math.round(x1);
  const ty = Math.round(y1);
  const dx = Math.abs(tx - x);
  const dy = -Math.abs(ty - y);
  const sx = x < tx ? 1 : -1;
  const sy = y < ty ? 1 : -1;
  let err = dx + dy;
  const half = Math.floor((thickness - 1) / 2);
  for (;;) {
    fillRect(b, x - half, y - half, thickness, thickness, value);
    if (x === tx && y === ty) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/**
 * Blits a character pattern: `#` full, `+` mid, `-` dim, anything else clear.
 * Each cell becomes a `scale` x `scale` block.
 */
export function drawPattern(b: Bitmap, pattern: readonly string[], x: number, y: number, scale = 1): void {
  pattern.forEach((row, py) => {
    for (let px = 0; px < row.length; px += 1) {
      const c = row[px];
      const value = c === "#" ? FULL : c === "+" ? MID : c === "-" ? DIM : 0;
      if (value > 0) fillRect(b, x + px * scale, y + py * scale, scale, scale, value);
    }
  });
}

/** Centres a pattern in a width x height icon, as large as fits (integer scale). */
export function iconBitmap(pattern: readonly string[], width = 64, height = 30, padding = 1): Bitmap {
  const b = createBitmap(width, height);
  const rows = pattern.length;
  const columns = Math.max(1, ...pattern.map((row) => row.length));
  const scale = Math.max(1, Math.floor(Math.min((width - padding * 2) / columns, (height - padding * 2) / rows)));
  drawPattern(b, pattern, Math.floor((width - columns * scale) / 2), Math.floor((height - rows * scale) / 2), scale);
  return b;
}

// ---- pixel font (5 x 7) -------------------------------------------------

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": [".###.", "#...#", "....#", "..##.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  "%": ["##..#", "##..#", "...#.", "..#..", ".#...", "#..##", "#..##"],
  ".": [".....", ".....", ".....", ".....", ".....", "..#..", "..#.."],
  ":": [".....", "..#..", "..#..", ".....", "..#..", "..#..", "....."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;

/** Width in pixels of `text` at `scale` (one scaled column between glyphs). */
export function textWidth(text: string, scale = 1): number {
  return text.length === 0 ? 0 : text.length * (GLYPH_WIDTH + 1) * scale - scale;
}

/** Draws text in the 5 x 7 pixel font; unknown characters are left blank. Returns the width drawn. */
export function drawText(b: Bitmap, text: string, x: number, y: number, scale = 1, value = FULL): number {
  let cursor = x;
  for (const char of text.toUpperCase()) {
    const glyph = GLYPHS[char];
    if (glyph) {
      glyph.forEach((row, py) => {
        for (let px = 0; px < GLYPH_WIDTH; px += 1) {
          if (row[px] === "#") fillRect(b, cursor + px * scale, y + py * scale, scale, scale, value);
        }
      });
    }
    cursor += (GLYPH_WIDTH + 1) * scale;
  }
  return textWidth(text, scale);
}

// ---- identity + PNG -------------------------------------------------------

/** Cheap content key (FNV-1a over the pixels): equal bitmaps give equal keys, so nothing is resent. */
export function bitmapKey(b: Bitmap): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < b.pixels.length; i += 1) {
    hash ^= b.pixels[i] ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${b.width}x${b.height}:${hash.toString(16)}`;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = (crcTable[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + (bytes[i] ?? 0)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes the bitmap as an 8-bit grayscale PNG (uncompressed deflate; small images, no canvas needed). */
export function encodePng(b: Bitmap): Uint8Array {
  const stride = b.width + 1;
  const raw = new Uint8Array(stride * b.height);
  for (let y = 0; y < b.height; y += 1) {
    raw[y * stride] = 0;
    raw.set(b.pixels.subarray(y * b.width, (y + 1) * b.width), y * stride + 1);
  }
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const zlib = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  let at = 2;
  for (let i = 0; i < blocks; i += 1) {
    const part = raw.subarray(i * 65535, Math.min(raw.length, (i + 1) * 65535));
    zlib[at++] = i === blocks - 1 ? 1 : 0;
    zlib[at++] = part.length & 0xff;
    zlib[at++] = part.length >>> 8;
    zlib[at++] = ~part.length & 0xff;
    zlib[at++] = (~part.length >>> 8) & 0xff;
    zlib.set(part, at);
    at += part.length;
  }
  new DataView(zlib.buffer).setUint32(at, adler32(raw));

  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, b.width);
  hv.setUint32(4, b.height);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
