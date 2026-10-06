import { describe, expect, it } from "vitest";
import { validateEvenHubPageContainer } from "@evenrealities/even_hub_sdk";
import {
  approachSteps, APPROACH_WINDOW_M, BAR_STEPS, CARD_HEIGHT, CARD_WIDTH, cardKey, drawTurnCard, labelWidth, renderTurnCardPng,
} from "../src/glasses/turncard";
import { createGrayCanvas, crc32, encodePng, grayOf, zlibStored } from "../src/glasses/png";
import { formatDistance } from "../src/geo/geometry";
import { buildView } from "../src/glasses/view";
import { buildPage } from "../src/glasses/render";
import { pixelArrowFor } from "../src/glasses/icons";
import { sameView } from "../src/glasses/diff";
import type { ManeuverType } from "../src/routing/provider";

const progress = {
  maneuver: { type: "right" as const, instruction: "Turn right", street: "Example Road", length: 400, time: 60, shapeIndex: 0 },
  distanceToManeuver: 250, distanceRemaining: 1200, secondsRemaining: 300, offRoute: false, arrived: false,
};
const options = { mode: "driving" as const, navigating: true, rerouting: false, error: null, mock: false, waitingForFix: false };

describe("approach bar", () => {
  it("is empty far away, fills as the turn comes closer, full at the turn", () => {
    expect(approachSteps(1000, 2000, "walking")).toBe(0);
    expect(approachSteps(APPROACH_WINDOW_M.walking, 2000, "walking")).toBe(0);
    expect(approachSteps(75, 2000, "walking")).toBe(BAR_STEPS / 2);
    expect(approachSteps(0, 2000, "walking")).toBe(BAR_STEPS);
    const steps = [600, 450, 300, 150, 0].map((d) => approachSteps(d, 5000, "driving"));
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  it("spans a short stretch instead of the whole window, so it starts empty after a quick double turn", () => {
    expect(approachSteps(40, 40, "driving")).toBe(0);
    expect(approachSteps(20, 40, "driving")).toBe(BAR_STEPS / 2);
  });

  it("never leaves 0…BAR_STEPS", () => {
    for (const d of [-5, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      const s = approachSteps(d, 0, "cycling");
      expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(BAR_STEPS);
    }
  });

  it("changes key only when what it shows changes", () => {
    expect(cardKey({ label: "250 m", steps: 2 })).toBe(cardKey({ label: "250 m", steps: 2 }));
    expect(cardKey({ label: "250 m", steps: 2 })).not.toBe(cardKey({ label: "250 m", steps: 3 }));
    expect(cardKey(null)).toBe("blank");
  });
});

describe("turn card drawing", () => {
  it("fits every distance label at full size, in both languages", () => {
    for (const locale of ["en", "de"] as const) {
      for (const meters of [0, 25, 250, 990, 1000, 1234, 9999, 10_000, 99_999, 999_999, -1]) {
        expect(labelWidth(formatDistance(meters, locale))).toBeLessThanOrEqual(CARD_WIDTH);
      }
    }
  });

  it("draws large digits and the bar's filled and empty blocks", () => {
    const canvas = createGrayCanvas(CARD_WIDTH, CARD_HEIGHT);
    drawTurnCard(canvas, { label: "250 m", steps: 3 });
    const at = (x: number, y: number) => canvas.pixels[y * CARD_WIDTH + x]!;
    // Digit "2" top bar: 5-pixel blocks starting at (5, 2).
    expect(at(7, 4)).toBe(255);
    const barY = CARD_HEIGHT - 10;
    const block = (CARD_WIDTH - 4 * (BAR_STEPS - 1)) / BAR_STEPS;
    const centres = Array.from({ length: BAR_STEPS }, (_, i) => Math.round(i * (block + 4) + block / 2));
    expect(centres.map((x) => at(x, barY))).toEqual(centres.map((_, i) => (i < 3 ? 255 : grayOf("#333"))));
    // Nothing outside the digits and the bar.
    expect(at(CARD_WIDTH - 1, 10)).toBe(0);
  });

  it("stays black when there is no turn to show", () => {
    const canvas = createGrayCanvas(CARD_WIDTH, CARD_HEIGHT);
    drawTurnCard(canvas, null);
    expect(canvas.pixels.every((value) => value === 0)).toBe(true);
  });

  it("encodes a PNG of the card size", async () => {
    const png = await renderTurnCardPng({ label: "1,2 km", steps: 8 });
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(CARD_WIDTH);
    expect(view.getUint32(20)).toBe(CARD_HEIGHT);
    const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    if (env?.["OPENGLANCE_PREVIEW"] === "1") {
      const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { writeFileSync(path: string, data: Uint8Array): void };
      const preview = await renderTurnCardPng({ label: "250 m", steps: 5 });
      fs.writeFileSync(new URL("../docs/turn-card-preview.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), preview);
    }
  });
});

describe("PNG encoder", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes stored deflate blocks that decompress to the input", async () => {
    const data = new Uint8Array(70_000).map((_, i) => i % 251);
    const stream = new Blob([zlibStored(data) as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(data);
  });

  it("reads hex colours as grey", () => {
    expect(grayOf("#fff")).toBe(255); expect(grayOf("#000000")).toBe(0); expect(grayOf("red")).toBe(0);
    expect(grayOf("#808080")).toBe(128);
  });

  it("keeps the image size in the header", async () => {
    const png = await encodePng(3, 2, new Uint8Array(6));
    const view = new DataView(png.buffer, png.byteOffset);
    expect([view.getUint32(16), view.getUint32(20), png[24], png[25]]).toEqual([3, 2, 8, 6]);
  });
});

describe("turn layout on the glasses", () => {
  it("shows the distance on the card instead of repeating it in the text", () => {
    const view = buildView(progress, { ...options, bigDistance: true });
    expect(view.big).toBe("250 m");
    expect(view.body).toEqual(["Example Road"]);
    expect(view.body.join(" ")).not.toMatch(/\d/);
    expect(view.footer).toBe("");
  });

  it("keeps the text distance without the card, and in the overview", () => {
    expect(buildView(progress, options).big).toBeUndefined();
    const overview = buildView(progress, { ...options, bigDistance: true, layout: "overview" });
    expect(overview.big).toBeUndefined();
    expect(overview.body[0]).toContain("250 m");
  });

  it("has no card while not navigating, off route or arrived", () => {
    expect(buildView(null, { ...options, navigating: false, bigDistance: true }).big).toBeUndefined();
    expect(buildView({ ...progress, offRoute: true }, { ...options, bigDistance: true }).big).toBeUndefined();
    expect(buildView({ ...progress, arrived: true }, { ...options, bigDistance: true }).big).toBeUndefined();
  });

  it("counts a changed big distance as a changed view", () => {
    const a = buildView(progress, { ...options, bigDistance: true });
    const b = buildView({ ...progress, distanceToManeuver: 200 }, { ...options, bigDistance: true });
    expect(sameView(a, b)).toBe(false);
  });

  it("puts the card right of the arrow and the text below the card, as a valid page", () => {
    const page = buildPage(buildView(progress, { ...options, bigDistance: true }), pixelArrowFor("right"));
    const [icon, card] = page.imageObject ?? [];
    expect(icon).toMatchObject({ containerName: "pixel-icon", xPosition: 0, yPosition: 36, width: 96, height: 144 });
    expect(card).toMatchObject({ containerName: "turn-distance", xPosition: 104, yPosition: 36, width: 288, height: 64 });
    const body = page.textObject?.find((text) => text.containerName === "body");
    expect(body?.yPosition).toBeGreaterThanOrEqual(100);
    expect((body?.yPosition ?? 0) + (body?.height ?? 0)).toBeLessThanOrEqual(252);
    expect(body?.isEventCapture).toBe(1);
    expect(page.containerTotalNum).toBe(5);
    const result = validateEvenHubPageContainer(page);
    expect(result.valid, JSON.stringify(result)).toBe(true);
  });

  it("draws every arrow on the same 10 × 10 grid", () => {
    const types: ManeuverType[] = ["depart", "arrive", "left", "slightLeft", "sharpLeft", "right", "slightRight", "sharpRight", "straight", "uturn", "roundabout", "merge", "fork", "exit"];
    for (const type of types) {
      const icon = pixelArrowFor(type);
      expect(icon).toHaveLength(10);
      for (const row of icon) expect(row, type).toMatch(/^[.#]{10}$/);
    }
  });
});
