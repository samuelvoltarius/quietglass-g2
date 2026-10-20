import { describe, expect, it } from "vitest";
import { talkCockpitModel } from "../src/cockpit/model";
import { composeCockpit } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { frameKey, type Frame } from "../src/screen/frame";
import type { TranscriptEntry } from "../src/companion/transcript";

/**
 * Glasses preview for review (not shipped): the summary cockpit frame for a demo conversation, green on black.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png. Node has no canvas, so this uses the 5 x 7 pixel font; on the glasses the
 * system font draws the text. Without QG_PREVIEW the test only checks that the frame draws.
 */

const T0 = new Date(2026, 9, 17, 13, 51).getTime();
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const log: TranscriptEntry[] = [
  { text: "Guten Tag, wie geht es Ihnen heute?", at: T0, speaker: "A", language: "de" },
  { text: "Gut danke, und Ihnen?", at: T0 + 3 * 60_000, speaker: "ME", language: "de" },
  { text: "Sehr gut. Was kostet das Angebot für die Wohnung", at: T0 + 7 * 60_000, speaker: "A", language: "de" },
  { text: "Das Angebot kostet vierhundert Euro, ist das in Ordnung?", at: T0 + 12 * 60_000, speaker: "ME", language: "de" },
];

function frame(): Frame {
  const model = talkCockpitModel({ log, locale: "de", now: NOW, translating: true, sourceLanguage: "auto", targetLanguage: "en" })!;
  return composeCockpit(model, pixelBackend());
}

/** A truecolor PNG of a frame: level 0 is black, level 15 full green. */
async function greenPng(source: Frame, scale = 1): Promise<Uint8Array> {
  const zlib = (await import(/* @vite-ignore */ "node:" + "zlib")) as unknown as {
    deflateSync(data: Uint8Array): Uint8Array;
    crc32(data: Uint8Array): number;
  };
  const width = source.width * scale; const height = source.height * scale;
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const level = source.pixels[Math.floor(y / scale) * source.width + Math.floor(x / scale)]!;
      const green = Math.round((level / 15) * 255);
      const at = y * (width * 3 + 1) + 1 + x * 3;
      raw[at] = Math.round(green * 0.1); raw[at + 1] = green; raw[at + 2] = Math.round(green * 0.25);
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
  hv.setUint32(0, width); hv.setUint32(4, height); header[8] = 8; header[9] = 2;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { png.set(part, offset); offset += part.length; }
  return png;
}

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cwd(): string } }).process;

describe("summary cockpit preview", () => {
  it("draws a non-empty, repeatable frame", () => {
    expect(frame().pixels.some((level) => level > 0)).toBe(true);
    expect(frameKey(frame())).toBe(frameKey(frame()));
  });

  it.skipIf(env.env["QG_PREVIEW"] === undefined)("writes the preview PNG to store/", async () => {
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as { writeFileSync(path: string, data: Uint8Array): void };
    fs.writeFileSync(`${env.cwd()}/store/preview-cockpit.png`, await greenPng(frame()));
  });
});
