import { describe, expect, it } from "vitest";
import { cockpitModel } from "../src/cockpit/model";
import { composeCockpit } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { frameKey, type Frame } from "../src/screen/frame";
import { EMPTY_MODEL, type HudModel } from "../src/hud/model";
import { previewEnabled, writePreview } from "./preview-util";

/**
 * Glasses previews for review (not shipped): the status cockpit frame for a demo state, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png (idle), preview-cockpit-open.png (two questions wait) and preview-cockpit-offline.png.
 * Node has no canvas, so these use the 5 x 7 pixel font; on the glasses the system font draws the text.
 */
const NOW = new Date(2026, 9, 17, 14, 5);
const base: HudModel = { ...EMPTY_MODEL, configured: true, online: true, screen: "status", feedAt: NOW.getTime() - 30_000 };
const card = (id: string, title: string, effect: string) => ({ id, title, text: "…", effect });

const states: { file: string; model: HudModel }[] = [
  { file: "preview-cockpit.png", model: { ...base, feed: { version: "v", status: "Alles ruhig", cards: [] } } },
  { file: "preview-cockpit-open.png", model: { ...base, feed: { version: "v", status: "Prüft Drucker — Schritt 1/2", cards: [card("a", "Drucker starten?", "physisch"), card("b", "Neues Modell testen?", "intern")] } } },
  { file: "preview-cockpit-offline.png", model: { ...EMPTY_MODEL, configured: true, screen: "status", problem: "Xaventra nicht erreichbar" } },
];

const frameOf = (model: HudModel): Frame => composeCockpit(cockpitModel(model, "de", NOW), pixelBackend());

describe("cockpit previews", () => {
  it("draws every demo state to a non-empty, repeatable frame", () => {
    for (const state of states) {
      const frame = frameOf(state.model);
      expect(frame.pixels.some((level) => level > 0), state.file).toBe(true);
      expect(frameKey(frameOf(state.model)), state.file).toBe(frameKey(frame));
    }
  });

  it.skipIf(!previewEnabled())("writes the preview PNGs to store/", async () => {
    for (const state of states) await writePreview(state.file, frameOf(state.model));
  });
});
