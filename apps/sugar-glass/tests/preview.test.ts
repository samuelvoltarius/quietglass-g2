import { describe, expect, it } from "vitest";
import { cockpitModel } from "../src/cockpit/model";
import { composeCockpit } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { frameKey, type Frame } from "../src/screen/frame";
import { DEFAULT_LIMITS } from "../src/ns/alerts";
import { demoPump, demoReadings, demoTreatments, type DemoScene } from "../src/ns/demo";
import type { ViewState } from "../src/glasses/views";
import { previewEnabled, writePreview } from "./preview-util";

/**
 * Glasses previews for review (not shipped): the cockpit frame for a demo state, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png (glucose in range), preview-cockpit-low.png (low alert) and
 * preview-cockpit-pump.png. Node has no canvas, so these use the 5 x 7 pixel font; on the glasses the system font
 * draws the text.
 */
const NOW = new Date(2026, 9, 17, 14, 5).getTime();

function frameFor(scene: DemoScene, page: "glucose" | "pump"): Frame {
  const state: ViewState = {
    locale: "de", demo: false, connection: { kind: "ok" }, page, unit: "mgdl", limits: DEFAULT_LIMITS, now: NOW,
    data: { readings: demoReadings(scene, NOW), pump: demoPump(scene, NOW), treatments: demoTreatments(NOW) },
  };
  return composeCockpit(cockpitModel(state), pixelBackend());
}

const states = [
  { file: "preview-cockpit.png", frame: () => frameFor("normal", "glucose") },
  { file: "preview-cockpit-low.png", frame: () => frameFor("low", "glucose") },
  { file: "preview-cockpit-pump.png", frame: () => frameFor("normal", "pump") },
];

describe("cockpit previews", () => {
  it("draws every demo state to a non-empty, repeatable frame", () => {
    for (const state of states) {
      const frame = state.frame();
      expect(frame.pixels.some((level) => level > 0), state.file).toBe(true);
      expect(frameKey(state.frame()), state.file).toBe(frameKey(frame));
    }
  });

  it.skipIf(!previewEnabled())("writes the preview PNGs to store/", async () => {
    for (const state of states) await writePreview(state.file, state.frame());
  });
});
