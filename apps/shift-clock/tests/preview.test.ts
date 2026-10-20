import { describe, expect, it } from "vitest";
import { cockpitModel, type CockpitInput } from "../src/cockpit/model";
import { composeCockpit } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { frameKey, type Frame } from "../src/screen/frame";
import { STOPPED, type TimeEntry } from "../src/tracking/clock";

/**
 * Glasses previews for review (not shipped): the cockpit frame for a few demo states, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png (a shift running), store/preview-cockpit-pause.png (PAUSE), preview-cockpit-armed.png
 * (STOPP?) and preview-cockpit-done.png (FEIERABEND). Node has no canvas, so these use the 5 x 7 pixel font; on the glasses
 * the system font draws the text. Without QG_PREVIEW the test only checks that the frames draw.
 */

const at = (h: number, m = 0, day = 14): number => new Date(2026, 9, day, h, m).getTime();
const entry = (id: string, day: number, from: [number, number], to: [number, number]): TimeEntry =>
  ({ id, project: "Kunde Müller", startedAt: at(...from, day), endedAt: at(...to, day) });

/** Monday-Tuesday full days, today 08:30-12:00, a break, running since 12:25. */
const entries: TimeEntry[] = [
  entry("a", 12, [8, 0], [16, 30]), entry("b", 13, [8, 15], [16, 45]), entry("c", 14, [8, 30], [12, 0]),
];
const running = { project: "Kunde Müller", startedAt: at(12, 25) };

function input(over: Partial<CockpitInput>): CockpitInput {
  return { clock: running, entries, now: at(14, 5), locale: "de", targetHours: 8, armed: false, demo: false, projectCount: 2, ...over };
}

function frameFor(over: Partial<CockpitInput>): Frame {
  return composeCockpit(cockpitModel(input(over)), pixelBackend());
}

/** A truecolor PNG of a frame: level 0 is black, level 15 full green. */
async function greenPng(frame: Frame, scale = 1): Promise<Uint8Array> {
  const zlib = (await import(/* @vite-ignore */ "node:" + "zlib")) as unknown as {
    deflateSync(data: Uint8Array): Uint8Array;
    crc32(data: Uint8Array): number;
  };
  const width = frame.width * scale; const height = frame.height * scale;
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const level = frame.pixels[Math.floor(y / scale) * frame.width + Math.floor(x / scale)]!;
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

describe("cockpit previews", () => {
  const states: { file: string; over: Partial<CockpitInput>; headline: string }[] = [
    { file: "preview-cockpit.png", over: {}, headline: "NOCH 2:50" },
    { file: "preview-cockpit-pause.png", over: { clock: STOPPED, now: at(12, 12) }, headline: "PAUSE 0:12" },
    { file: "preview-cockpit-armed.png", over: { armed: true }, headline: "STOPP?" },
    { file: "preview-cockpit-done.png", over: { clock: STOPPED, entries: [...entries, entry("d", 14, [12, 25], [17, 0])], now: at(17, 10) }, headline: "FEIERABEND" },
  ];

  it("draws every state to a non-empty, repeatable frame with the expected headline", () => {
    for (const state of states) {
      expect(cockpitModel(input(state.over)).headline, state.file).toEqual([state.headline]);
      const frame = frameFor(state.over);
      expect(frame.pixels.some((level) => level > 0), state.file).toBe(true);
      expect(frameKey(frameFor(state.over)), state.file).toBe(frameKey(frame));
    }
  });

  it.skipIf(env.env["QG_PREVIEW"] === undefined)("writes the preview PNGs to store/", async () => {
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as { writeFileSync(path: string, data: Uint8Array): void };
    for (const state of states) fs.writeFileSync(`${env.cwd()}/store/${state.file}`, await greenPng(frameFor(state.over)));
  });
});
