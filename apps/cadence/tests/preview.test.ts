import { describe, expect, it } from "vitest";
import { cockpitModel } from "../src/cockpit/model";
import { composeCockpit } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { frameKey, type Frame } from "../src/screen/frame";
import { DEFAULT_SETTINGS, createState, start } from "../src/metronome/engine";
import { greenPng } from "./preview-png";

/**
 * Glasses previews for review (not shipped): the cockpit frame for a demo state, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png (the beat running, 100 bpm) and store/preview-cockpit-ready.png (ready, no item).
 * Node has no canvas, so these use the 5 x 7 pixel font; on the glasses the system font draws the text.
 */

const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const running = start(createState(), NOW - 12 * 60_000 - 1_000);

const states: { file: string; frame: () => Frame }[] = [
  {
    file: "preview-cockpit.png",
    frame: () => composeCockpit(cockpitModel({
      state: running, settings: DEFAULT_SETTINGS, now: NOW, locale: "de", item: "Tonleitern", sessionSeconds: 12 * 60,
      todaySeconds: 34 * 60, todayCount: 2, best: 112,
    }), pixelBackend()),
  },
  {
    file: "preview-cockpit-ready.png",
    frame: () => composeCockpit(cockpitModel({ state: createState(), settings: DEFAULT_SETTINGS, now: NOW, locale: "de" }), pixelBackend()),
  },
  // The store screenshot (English): the old simulator capture still offered "Hold", which the temple pad never delivers (step log 21.10.2026).
  {
    file: "screenshot.png",
    frame: () => composeCockpit(cockpitModel({
      state: running, settings: DEFAULT_SETTINGS, now: NOW, locale: "en", item: "Scales", sessionSeconds: 12 * 60,
      todaySeconds: 34 * 60, todayCount: 2, best: 112,
    }), pixelBackend()),
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
