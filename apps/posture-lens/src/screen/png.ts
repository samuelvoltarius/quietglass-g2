import type { Frame } from "./frame";

/**
 * Full-screen kit: an 8-bit greyscale PNG encoder without canvas (stored
 * deflate blocks; the phone host converts the image to 4-bit grey before it
 * crosses Bluetooth, so the PNG size itself does not matter). Level n becomes
 * grey n x 17. Meant to be copied into other Quietglass G2 apps.
 */

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1; let b = 0;
  for (let i = 0; i < bytes.length; i += 1) { a = (a + bytes[i]!) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length); const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodeGreyPng(frame: Frame): Uint8Array {
  const stride = frame.width + 1;
  const raw = new Uint8Array(stride * frame.height);
  for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) raw[y * stride + 1 + x] = Math.min(15, frame.pixels[y * frame.width + x]!) * 17;
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const zlib = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  zlib[0] = 0x78; zlib[1] = 0x01;
  let at = 2;
  for (let i = 0; i < blocks; i += 1) {
    const part = raw.subarray(i * 65535, Math.min(raw.length, (i + 1) * 65535));
    zlib[at++] = i === blocks - 1 ? 1 : 0;
    zlib[at++] = part.length & 0xff; zlib[at++] = part.length >>> 8;
    zlib[at++] = ~part.length & 0xff; zlib[at++] = (~part.length >>> 8) & 0xff;
    zlib.set(part, at); at += part.length;
  }
  new DataView(zlib.buffer).setUint32(at, adler32(raw));
  const header = new Uint8Array(13); const hv = new DataView(header.buffer);
  hv.setUint32(0, frame.width); hv.setUint32(4, frame.height); header[8] = 8; header[9] = 0;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
