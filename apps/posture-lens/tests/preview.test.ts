import { describe, expect, it } from "vitest";
import { cockpitModel, type CockpitInput } from "../src/cockpit/model";
import { composeCockpit } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { frameKey, type Frame } from "../src/screen/frame";
import { addSample, calibrate, createMonitor, DEFAULT_SETTINGS } from "../src/posture/monitor";
import { greenPng } from "./preview-png";

/**
 * Glasses previews for review (not shipped): the cockpit frame for a demo state, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png (upright: calm, no needle) and store/preview-cockpit-leaning.png (leaning, the
 * warning one minute away). Node has no canvas, so these use the 5 x 7 pixel font; on the glasses the system font
 * draws the text.
 */

const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const settings = { ...DEFAULT_SETTINGS, smoothing: 1 };
const saved = calibrate(createMonitor(), { x: 0, y: 0, z: 1 }, NOW - 40 * 60_000);
const upright = addSample(saved, { x: 0, y: 0, z: 1 }, settings, NOW - 20 * 60_000);
const tilted = addSample(addSample(upright, { x: 0, y: 1, z: 1 }, settings, NOW - 20_000), { x: 0, y: 1, z: 1 }, settings, NOW - 5_000);
const base: Pick<CockpitInput, "settings" | "locale" | "now"> = { settings, locale: "de", now: NOW };

const states: { file: string; frame: () => Frame }[] = [
  { file: "preview-cockpit.png", frame: () => composeCockpit(cockpitModel({ ...base, monitor: { ...upright, goodSeconds: 1500, leaningSeconds: 120 } }), pixelBackend()) },
  {
    file: "preview-cockpit-leaning.png",
    frame: () => composeCockpit(cockpitModel({ ...base, monitor: { ...tilted, goodSeconds: 1500, leaningSeconds: 140 }, digitsAngle: 31, gaugeAngle: 32 }), pixelBackend()),
  },
];

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cwd(): string } }).process;

describe("cockpit previews", () => {
  it("draws every demo state to a non-empty, repeatable frame", () => {
    for (const state of states) {
      const frame = state.frame();
      expect(frame.pixels.some((level) => level > 0), state.file).toBe(true);
      expect(frameKey(state.frame()), state.file).toBe(frameKey(frame));
    }
  });

  it.skipIf(env.env["QG_PREVIEW"] === undefined)("writes the preview PNGs to store/", async () => {
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as { writeFileSync(path: string, data: Uint8Array): void };
    for (const state of states) fs.writeFileSync(`${env.cwd()}/store/${state.file}`, await greenPng(state.frame()));
  });
});
