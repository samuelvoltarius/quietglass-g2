import { describe, expect, it } from "vitest";
import { cockpitModel, demoHistory, type FeedStatus } from "../src/cockpit/model";
import { composeCockpit } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { frameKey, type Frame } from "../src/screen/frame";
import { demoPositions } from "../src/markets/model";
import { previewEnabled, writePreview } from "./preview-util";

/**
 * Glasses previews for review (not shipped): the cockpit frame for a demo state, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png (portfolio) and store/preview-cockpit-position.png (one position). Node has no
 * canvas, so these use the 5 x 7 pixel font; on the glasses the system font draws the text.
 */
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const live: FeedStatus = { source: "live", updatedAt: NOW - 5_000, failed: false, errors: [] };

const states: { file: string; frame: () => Frame }[] = [
  { file: "preview-cockpit.png", frame: () => composeCockpit(cockpitModel({ positions: demoPositions(), status: live, history: demoHistory(NOW), page: { kind: "overview" }, now: NOW, locale: "de" }), pixelBackend()) },
  { file: "preview-cockpit-position.png", frame: () => composeCockpit(cockpitModel({ positions: demoPositions(), status: live, history: demoHistory(NOW), page: { kind: "position", index: 1 }, now: NOW, locale: "de" }), pixelBackend()) },
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
