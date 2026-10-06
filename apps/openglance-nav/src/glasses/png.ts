/**
 * A grey pixel buffer that draws filled rectangles, and a small PNG encoder.
 *
 * Block graphics (the turn card) need nothing more, and doing them without a
 * canvas keeps them byte-for-byte testable in node. The PNG is 8-bit RGBA —
 * the same format a WebView canvas produces — so the Even app decodes it the
 * way it decodes every other image. Compression uses the platform's
 * `CompressionStream` when there is one, and stored (uncompressed) deflate
 * blocks otherwise; the glasses get the same pixels either way.
 */

export interface GrayCanvas {
  readonly width: number;
  readonly height: number;
  /** One byte per pixel, 0 = black … 255 = white, row by row. */
  readonly pixels: Uint8Array;
  fillStyle: string;
  fillRect(x: number, y: number, width: number, height: number): void;
}

/** Brightness of a CSS hex colour (#rgb or #rrggbb), 0…255; anything else is black. */
export function grayOf(color: string): number {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return 0;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

export function createGrayCanvas(width: number, height: number): GrayCanvas {
  const pixels = new Uint8Array(width * height);
  return {
    width, height, pixels, fillStyle: "#000",
    fillRect(x, y, w, h) {
      const value = grayOf(this.fillStyle);
      const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
      const x1 = Math.min(width, Math.round(x + w)), y1 = Math.min(height, Math.round(y + h));
      for (let row = y0; row < y1; row++) pixels.fill(value, row * width + x0, row * width + Math.max(x0, x1));
    },
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (const byte of bytes) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream made of stored blocks: valid, uncompressed, needs no library. */
export function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let at = 2;
  for (let i = 0; i < blocks; i++) {
    const chunk = data.subarray(i * 65535, Math.min(data.length, (i + 1) * 65535));
    out[at++] = i === blocks - 1 ? 1 : 0;
    out[at++] = chunk.length & 0xff; out[at++] = chunk.length >>> 8;
    out[at++] = ~chunk.length & 0xff; out[at++] = (~chunk.length >>> 8) & 0xff;
    out.set(chunk, at); at += chunk.length;
  }
  new DataView(out.buffer).setUint32(at, adler32(data));
  return out;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const Stream = (globalThis as { CompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> }).CompressionStream;
  if (!Stream) return zlibStored(data);
  try {
    const compressed = new Blob([data as BlobPart]).stream().pipeThrough(new Stream("deflate"));
    return new Uint8Array(await new Response(compressed).arrayBuffer());
  } catch {
    return zlibStored(data);
  }
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes grey pixels (one byte each) as an 8-bit RGBA PNG. */
export async function encodePng(width: number, height: number, gray: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const value = gray[y * width + x] ?? 0;
      raw.set([value, value, value, 255], row + 1 + x * 4);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8 bit, RGBA, deflate, adaptive filtering, no interlace
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
