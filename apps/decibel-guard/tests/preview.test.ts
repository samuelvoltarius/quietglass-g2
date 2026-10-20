import { describe, expect, it } from "vitest";
import { cockpitModel, type CockpitInput } from "../src/cockpit/model";
import { composeCockpit } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { frameKey, type Frame } from "../src/screen/frame";
import { createDose, DEFAULT_DOSE } from "../src/noise/dose";
import { greenPng } from "./preview-png";

/**
 * Glasses previews for review (not shipped): the cockpit frame for a demo state, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png (measuring, 72 dB, a third of the day) and store/preview-cockpit-high.png
 * (loud, past half of the limit). Node has no canvas, so these use the 5 x 7 pixel font; on the glasses the
 * system font draws the text.
 */

const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const dose = (fraction: number, seconds: number) => ({ ...createDose(), fraction, measuredSeconds: seconds, peakDb: 92, levelSeconds: seconds * 78, overSeconds: seconds / 8 });
const base: CockpitInput = { dose: dose(0.34, 5400), settings: DEFAULT_DOSE, listening: true, level: 72, barLevel: 72, peak: 78, calibrated: true, locale: "de", now: NOW };

const states: { file: string; frame: () => Frame }[] = [
  { file: "preview-cockpit.png", frame: () => composeCockpit(cockpitModel(base), pixelBackend()) },
  {
    file: "preview-cockpit-high.png",
    frame: () => composeCockpit(cockpitModel({ ...base, dose: dose(0.62, 9000), level: 91, barLevel: 90, peak: 96, calibrated: false }), pixelBackend()),
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
