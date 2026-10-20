import { describe, expect, it } from "vitest";
import { cockpitModel } from "../src/cockpit/model";
import { composeCockpit } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { frameKey, type Frame } from "../src/screen/frame";
import type { PodState } from "../src/glasses/view";
import type { Caption } from "../src/podcast/parse";
import { previewEnabled, writePreview } from "./preview-util";

/**
 * Glasses previews for review (not shipped): the status cockpit frame for a demo state, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png (paused, a file open) and store/preview-cockpit-playing.png. Node has no canvas,
 * so these use the 5 x 7 pixel font; on the glasses the system font draws the text.
 */
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const captions: Caption[] = Array.from({ length: 40 }, (_, i) => ({ start: i * 62, end: i * 62 + 58, text: `Satz ${i + 1}` }));
const base: PodState = { locale: "de", captions, episode: "Folge 12: Neues vom Land", cursor: 14, source: "FILE", playing: false, failure: "" };

const states = [
  { file: "preview-cockpit.png", state: base },
  { file: "preview-cockpit-playing.png", state: { ...base, playing: true, cursor: 27, source: "RSS" as const } },
];

const frameOf = (state: PodState): Frame => composeCockpit(cockpitModel(state, NOW), pixelBackend());

describe("cockpit previews", () => {
  it("draws every demo state to a non-empty, repeatable frame", () => {
    for (const item of states) {
      const frame = frameOf(item.state);
      expect(frame.pixels.some((level) => level > 0), item.file).toBe(true);
      expect(frameKey(frameOf(item.state)), item.file).toBe(frameKey(frame));
    }
  });

  it.skipIf(!previewEnabled())("writes the preview PNGs to store/", async () => {
    for (const item of states) await writePreview(item.file, frameOf(item.state));
  });
});
