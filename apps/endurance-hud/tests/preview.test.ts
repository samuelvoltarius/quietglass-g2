import { describe, expect, it } from "vitest";
import { cockpitModel, type CockpitInput } from "../src/cockpit/model";
import { composeCockpit } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { frameKey, type Frame } from "../src/screen/frame";
import { demoTelemetry, type Telemetry } from "../src/telemetry/model";
import { greenPng } from "./preview-png";

/**
 * Glasses previews for review (not shipped): the cockpit frame for a demo state, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png (the sample bike workout) and store/preview-cockpit-run.png (running, zone 5).
 * Node has no canvas, so these use the 5 x 7 pixel font; on the glasses the system font draws the text.
 */

const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const bike: Telemetry = { ...demoTelemetry(), source: "garmin" };
const run: Telemetry = { ...bike, sport: "run", speedKph: 0, paceSecPerKm: 342, powerWatts: 0, heartRate: 176, cadence: 168, distanceKm: 8.4, elapsedSeconds: 2870 };
const base: CockpitInput = { locale: "de", sport: "bike", data: bike, mode: { kind: "live" }, maxHr: 190, now: NOW, hrMax: 158 };

const states: { file: string; frame: () => Frame }[] = [
  { file: "preview-cockpit.png", frame: () => composeCockpit(cockpitModel(base), pixelBackend()) },
  { file: "preview-cockpit-run.png", frame: () => composeCockpit(cockpitModel({ ...base, sport: "run", data: run, hrMax: 178 }), pixelBackend()) },
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
