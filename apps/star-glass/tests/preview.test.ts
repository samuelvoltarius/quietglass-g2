import { describe, expect, it } from "vitest";
import { cockpitModel } from "../src/cockpit/model";
import { composeCockpit, demoPreviewFrame } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { frameKey, type Frame } from "../src/screen/frame";
import { createDemoNina, type DemoScene } from "../src/nina/demo";
import { demoForecast } from "../src/weather/demo";
import { DEFAULT_THRESHOLDS, evaluateWeather } from "../src/weather/warnings";
import type { Page, ViewState } from "../src/glasses/views";

/**
 * Glasses previews for review (not shipped): the cockpit frame for a demo state, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png (the imaging overview) and store/preview-cockpit-<state>.png for the other
 * pages and one alert. Node has no canvas, so these use the 5 x 7 pixel font; on the glasses the system font draws
 * the text. Without QG_PREVIEW the test only checks that the frames draw.
 */

const NOW = new Date(2026, 9, 17, 22, 5).getTime();

async function stateFor(page: Page, scene: DemoScene, calm: boolean): Promise<ViewState> {
  const status = await createDemoNina(() => NOW, scene).status();
  const forecast = demoForecast(NOW);
  const station = status.online ? status.weather : null;
  const warnings = calm ? [] : evaluateWeather({ now: NOW, forecast, station, thresholds: DEFAULT_THRESHOLDS });
  return {
    locale: "de", demo: false, connection: { kind: "ok" }, status, ageSeconds: 0, screen: "run", page, startCursor: 0, cursor: 0, armed: null,
    sending: false, message: "", hasPreview: true, now: NOW,
    weather: { enabled: true, forecast, warnings, location: "nina", error: null, thresholds: DEFAULT_THRESHOLDS },
  };
}

const frameOf = async (page: Page, scene: DemoScene, calm: boolean): Promise<Frame> =>
  composeCockpit(cockpitModel(await stateFor(page, scene, calm)), pixelBackend(), { preview: demoPreviewFrame(7) });

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
  const states: { file: string; page: Page; scene: DemoScene; calm: boolean }[] = [
    { file: "preview-cockpit.png", page: "overview", scene: "run", calm: true },
    { file: "preview-cockpit-alert.png", page: "overview", scene: "lost", calm: true },
    { file: "preview-cockpit-guiding.png", page: "guiding", scene: "run", calm: true },
    { file: "preview-cockpit-equipment.png", page: "equipment", scene: "run", calm: true },
    { file: "preview-cockpit-weather.png", page: "weather", scene: "run", calm: false },
    { file: "preview-cockpit-image.png", page: "image", scene: "run", calm: true },
  ];

  it("draws every demo state to a non-empty, repeatable frame", async () => {
    for (const state of states) {
      const frame = await frameOf(state.page, state.scene, state.calm);
      expect(frame.pixels.some((level) => level > 0), state.file).toBe(true);
      expect(frameKey(await frameOf(state.page, state.scene, state.calm)), state.file).toBe(frameKey(frame));
    }
  });

  it.skipIf(env.env["QG_PREVIEW"] === undefined)("writes the preview PNGs to store/", async () => {
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as { writeFileSync(path: string, data: Uint8Array): void };
    for (const state of states) fs.writeFileSync(`${env.cwd()}/store/${state.file}`, await greenPng(await frameOf(state.page, state.scene, state.calm)));
  });
});
