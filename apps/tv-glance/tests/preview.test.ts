import { describe, expect, it } from "vitest";
import { cockpitModel } from "../src/cockpit/model";
import { composeCockpit } from "../src/cockpit/compose";
import { pixelBackend, drawText } from "../src/screen/text";
import { createFrame, frameKey, type Frame } from "../src/screen/frame";
import { appsView, dpadView, startView, type ViewState } from "../src/glasses/views";
import type { TextView } from "../src/glasses/page";
import { DEMO_SOURCES } from "../src/tv/demo";
import type { Locale } from "../src/i18n";
import { previewEnabled, writePreview } from "./preview-util";

/**
 * Store screenshots (not shipped): 576 x 288 RGBA with a transparent background, English first, one German last.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts   -> store/screenshots/NN-*.png
 *
 * Node has no canvas, so text uses the 5 x 7 pixel font; on the glasses the system font draws it.
 */
const NOW = new Date(2026, 9, 25, 20, 15).getTime();
const backend = pixelBackend();

function state(locale: Locale, over: Partial<ViewState> = {}): ViewState {
  return {
    locale, demo: true, connection: { kind: "ok" }, dpad: true, pendingVolume: 0, flash: null, armed: false, now: NOW,
    tv: { name: "Demo TV", power: "on", activity: "playing", app: "Netflix", title: "The Night Train", source: "Netflix", volume: 18, muted: false, sources: [...DEMO_SOURCES], apps: [] },
    entries: DEMO_SOURCES.map((s) => ({ label: s, id: s })),
    ...over,
  };
}

/** A text page roughly as the glasses lay it out: header, body rows, footer. */
function textFrame(view: TextView): Frame {
  const frame = createFrame();
  const font = { size: 22, weight: 600 };
  drawText(frame, backend, view.header, 8, 6, font, { level: 15, maxWidth: 560 });
  view.body.forEach((row, index) => drawText(frame, backend, row, 8, 44 + index * 29, font, { level: 15, maxWidth: 560 }));
  drawText(frame, backend, view.footer, 8, 258, { size: 18, weight: 600 }, { level: 9, maxWidth: 560 });
  return frame;
}

const shots: { file: string; frame: () => Frame }[] = [
  { file: "01-remote-en.png", frame: () => composeCockpit(cockpitModel(state("en")), backend) },
  { file: "02-start-en.png", frame: () => textFrame(startView(state("en"), 0)) },
  { file: "03-apps-en.png", frame: () => textFrame(appsView(state("en"), 3)) },
  { file: "04-dpad-en.png", frame: () => textFrame(dpadView(state("en"), 4)) },
  { file: "05-remote-de.png", frame: () => composeCockpit(cockpitModel(state("de", { tv: { ...state("de").tv!, activity: "paused" } })), backend) },
];

describe("store screenshots", () => {
  it("every shot is a non-empty, repeatable frame", () => {
    for (const shot of shots) {
      const frame = shot.frame();
      expect(frame.width).toBe(576);
      expect(frame.height).toBe(288);
      expect(frame.pixels.some((level) => level > 0), shot.file).toBe(true);
      expect(frameKey(shot.frame())).toBe(frameKey(frame));
    }
  });

  it.skipIf(!previewEnabled())("writes the transparent PNGs to store/screenshots/", async () => {
    for (const shot of shots) await writePreview(shot.file, shot.frame());
  });
});
