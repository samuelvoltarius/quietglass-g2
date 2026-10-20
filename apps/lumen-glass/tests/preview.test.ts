import { describe, expect, it } from "vitest";
import { cockpitModel } from "../src/cockpit/model";
import { composeCockpit } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { frameKey, type Frame } from "../src/screen/frame";
import { parseStatus, type LumenStatus } from "../src/lumen/client";
import { previewEnabled, writePreview } from "./preview-util";

/**
 * Glasses previews for review (not shipped): the moth cockpit frame for a demo state, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png (awake, golden hour near) and store/preview-cockpit-sleepy.png (curled up).
 * Node has no canvas, so these use the 5 x 7 pixel font; on the glasses the system font draws the text.
 */
const NOW = new Date(2026, 9, 17, 14, 5).getTime();

const status = (licht: number, zustand: string, geste: string, streak: number, window: Record<string, unknown> | null): LumenStatus =>
  parseStatus({
    kreatur: { licht, zustand, geste, streak },
    quest: { id: 1, titel: "Reflected Light", aufgabe: "Photograph a reflection.", medium: "foto", dauer_min: 15 },
    ...(window ? { naechstes_lichtfenster: window } : {}),
  });

const frameOf = (s: LumenStatus): Frame => composeCockpit(cockpitModel({ status: s, error: null, demo: false, locale: "de", now: NOW }), pixelBackend());

const states = [
  { file: "preview-cockpit.png", frame: () => frameOf(status(72, "wach", "kreist im Licht", 6, { art: "golden", in_minuten: 24 })) },
  { file: "preview-cockpit-sleepy.png", frame: () => frameOf(status(8, "eingerollt", "wartet. Er geht nicht weg.", 0, null)) },
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
