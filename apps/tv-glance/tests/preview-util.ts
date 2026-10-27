import type { Frame } from "../src/screen/frame";

/**
 * A PNG of a frame for the store: RGBA, the glasses' green, and a TRANSPARENT
 * background (store review 21.10.2026 - the hub puts its own scene behind it;
 * a black background is rejected). Level 0 is fully transparent.
 */
export async function storePng(frame: Frame): Promise<Uint8Array> {
  const zlib = (await import(/* @vite-ignore */ "node:" + "zlib")) as unknown as {
    deflateSync(data: Uint8Array): Uint8Array;
    crc32(data: Uint8Array): number;
  };
  const { width, height } = frame;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const level = frame.pixels[y * width + x]!;
      const at = y * (width * 4 + 1) + 1 + x * 4;
      raw[at] = 40; raw[at + 1] = 255; raw[at + 2] = 90; raw[at + 3] = Math.round((level / 15) * 255);
    }
  }
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length); const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, zlib.crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13); const hv = new DataView(header.buffer);
  hv.setUint32(0, width); hv.setUint32(4, height); header[8] = 8; header[9] = 6;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { png.set(part, offset); offset += part.length; }
  return png;
}

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cwd(): string } }).process;
export const previewEnabled = (): boolean => env.env["QG_PREVIEW"] !== undefined;

/** Writes store/screenshots/<file> (only used by the QG_PREVIEW-gated preview test). */
export async function writePreview(file: string, frame: Frame): Promise<void> {
  const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as { writeFileSync(path: string, data: Uint8Array): void; mkdirSync(path: string, options: { recursive: boolean }): void };
  fs.mkdirSync(`${env.cwd()}/store/screenshots`, { recursive: true });
  fs.writeFileSync(`${env.cwd()}/store/screenshots/${file}`, await storePng(frame));
}
