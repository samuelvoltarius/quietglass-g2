import { describe, expect, it } from "vitest";
import { validateEvenHubPageContainer } from "@evenrealities/even_hub_sdk";
import {
  BAR_STEPS, CARD_HEIGHT, CARD_WIDTH, DIGIT_SCALE, drawTurnCard, labelWidth, renderTurnCardPng,
} from "../src/glasses/turncard";
import { createGrayCanvas, grayOf } from "../src/glasses/png";
import { formatDistance, formatDistanceBig } from "../src/geo/geometry";
import { buildView } from "../src/glasses/view";
import { buildPage } from "../src/glasses/render";
import { ARROW_GRID, ARROW_SIZE, pixelArrowFor } from "../src/glasses/icons";
import { renderPixelIcon } from "../src/glasses/pixel";
import { sameView } from "../src/glasses/diff";
import { fitStreetText, MAX_FONT_PX, MIN_FONT_PX, STREET_WIDTH } from "../src/glasses/street";
import type { ManeuverType } from "../src/routing/provider";

const progress = {
  maneuver: { type: "right" as const, instruction: "Turn right", street: "Example Road", length: 400, time: 60, shapeIndex: 0 },
  distanceToManeuver: 250, distanceRemaining: 1200, secondsRemaining: 300, offRoute: false, arrived: false,
};
const options = { mode: "driving" as const, navigating: true, rerouting: false, error: null, mock: false, waitingForFix: false };

describe("distance card drawing", () => {
  it("is the largest image the glasses accept, with digits twice as tall as the first card had", () => {
    expect([CARD_WIDTH, CARD_HEIGHT]).toEqual([288, 144]);
    expect(DIGIT_SCALE * 7).toBeGreaterThanOrEqual(70);
  });

  it("fits every number-and-unit label at full size, in both languages; words may shrink a step", () => {
    for (const locale of ["en", "de"] as const) {
      for (const meters of [20, 25, 250, 990, 1000, 1234, 9949, 9950, 10_000, 99_999, 999_999]) {
        for (const label of [formatDistance(meters, locale), formatDistanceBig(meters, locale)]) {
          // Up to 99 km the digits are drawn at full size; "100 km" and more shrink a step or two.
          expect(labelWidth(label, meters < 95_000 ? DIGIT_SCALE : DIGIT_SCALE - 3), label).toBeLessThanOrEqual(CARD_WIDTH);
        }
      }
      // "jetzt" is a hair wider than the card at full size: drawing shrinks it, and nothing leaves the image.
      const canvas = createGrayCanvas(CARD_WIDTH, CARD_HEIGHT);
      drawTurnCard(canvas, { label: formatDistanceBig(0, locale), steps: BAR_STEPS });
      expect(canvas.pixels.some((value) => value === 255)).toBe(true);
    }
  });

  it("rounds the big distance calmly: 50 m steps from 200 m, 10 m below, tenths of a kilometre above", () => {
    expect(formatDistanceBig(960)).toBe("950 m");
    expect(formatDistanceBig(512)).toBe("500 m");
    expect(formatDistanceBig(230)).toBe("250 m");
    expect(formatDistanceBig(199)).toBe("200 m");
    expect(formatDistanceBig(124)).toBe("120 m");
    expect(formatDistanceBig(1234, "de")).toBe("1,2 km");
    expect(formatDistanceBig(1234)).toBe("1.2 km");
    expect(formatDistanceBig(15, "de")).toBe("jetzt");
    expect(formatDistanceBig(Number.NaN)).toBe("--");
  });

  it("draws large digits centred, and the bar's filled and empty blocks", () => {
    const canvas = createGrayCanvas(CARD_WIDTH, CARD_HEIGHT);
    drawTurnCard(canvas, { label: "250 m", steps: 3 });
    const at = (x: number, y: number) => canvas.pixels[y * CARD_WIDTH + x]!;
    // "250 m" is 250 px wide at scale 10, so it starts at x = 19. Digit "2": top bar covers glyph columns 1 to 3.
    expect(labelWidth("250 m")).toBe(250);
    expect(at(19 + 15, 6 + 5)).toBe(255);
    expect(at(19 + 5, 6 + 5)).toBe(0);
    // The digits are 70 px tall: the last row of the glyph is still white, the row below is not.
    expect(at(19 + 15, 6 + 65)).toBe(255);
    expect(at(19 + 15, 6 + 72)).toBe(0);
    // The bar: thick (36 px) blocks, white where filled, dim grey where empty.
    const barY = 100 + 18;
    const block = (CARD_WIDTH - 6 * (BAR_STEPS - 1)) / BAR_STEPS;
    const centres = Array.from({ length: BAR_STEPS }, (_, i) => Math.round(i * (block + 6) + block / 2));
    expect(centres.map((x) => at(x, barY))).toEqual(centres.map((_, i) => (i < 3 ? 255 : grayOf("#333"))));
    expect(at(centres[0]!, 100 + 35)).toBe(255);
    expect(at(centres[0]!, 100 + 37)).toBe(0);
    // Nothing outside the digits and the bar.
    expect(at(CARD_WIDTH - 1, 10)).toBe(0);
    expect(at(5, 10)).toBe(0);
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
  });
});

const TYPES: ManeuverType[] = ["depart", "arrive", "left", "slightLeft", "sharpLeft", "right", "slightRight", "sharpRight", "straight", "uturn", "roundabout", "merge", "fork", "exit"];
const white = (icon: readonly string[]): number => icon.join("").split("#").length - 1;

describe("big arrows", () => {
  it("are drawn on one square grid that scales to whole pixels in the 144 px image", () => {
    expect(ARROW_SIZE).toBe(144);
    expect(ARROW_SIZE % ARROW_GRID).toBe(0);
    for (const type of TYPES) {
      const icon = pixelArrowFor(type);
      expect(icon, type).toHaveLength(ARROW_GRID);
      for (const row of icon) expect(row, type).toMatch(new RegExp(`^[.#]{${ARROW_GRID}}$`));
    }
    expect(pixelArrowFor()).toHaveLength(ARROW_GRID);
    expect(white(pixelArrowFor())).toBe(0);
  });

  it("are thick: every arrow covers at least a seventh of the image", () => {
    for (const type of TYPES) expect(white(pixelArrowFor(type)), type).toBeGreaterThan((ARROW_GRID * ARROW_GRID) / 7);
  });

  it("have a stem and head that read from afar: the straight arrow's stem is 32 px, its head 80", () => {
    const rows = pixelArrowFor("straight");
    const run = (row: string): number => row.split(".").reduce((best, part) => Math.max(best, part.length), 0) * (ARROW_SIZE / ARROW_GRID);
    expect(run(rows[60]!)).toBeGreaterThanOrEqual(30);
    expect(run(rows[60]!)).toBeLessThanOrEqual(34);
    expect(Math.max(...rows.map(run))).toBeGreaterThanOrEqual(78);
  });

  it("point the right way: left is the mirror of right, slight and sharp differ from the plain turn", () => {
    const mirror = (icon: readonly string[]): string[] => icon.map((row) => [...row].reverse().join(""));
    expect(pixelArrowFor("left")).toEqual(mirror(pixelArrowFor("right")));
    expect(pixelArrowFor("slightLeft")).toEqual(mirror(pixelArrowFor("slightRight")));
    expect(pixelArrowFor("sharpLeft")).toEqual(mirror(pixelArrowFor("sharpRight")));
    expect(pixelArrowFor("right")).not.toEqual(pixelArrowFor("slightRight"));
    expect(pixelArrowFor("right")).not.toEqual(pixelArrowFor("sharpRight"));
    expect(pixelArrowFor("right")).not.toEqual(pixelArrowFor("left"));
    expect(pixelArrowFor("straight")).not.toEqual(pixelArrowFor("roundabout"));
    expect(pixelArrowFor("uturn")).not.toEqual(pixelArrowFor("arrive"));
    // The straight arrow is symmetric; a right turn ends on the right edge, a left turn on the left.
    const straight = pixelArrowFor("straight");
    expect(straight.map((row) => [...row].reverse().join(""))).toEqual(straight);
    const columns = (icon: readonly string[]): number[] => icon.flatMap((row) => [...row].flatMap((c, i) => (c === "#" ? [i] : [])));
    expect(Math.max(...columns(pixelArrowFor("right")))).toBeGreaterThan(ARROW_GRID * 0.8);
    expect(Math.min(...columns(pixelArrowFor("left")))).toBeLessThan(ARROW_GRID * 0.2);
  });

  it("render to a PNG of the arrow size", async () => {
    const png = await renderPixelIcon(pixelArrowFor("right"));
    const view = new DataView(png.buffer, png.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([144, 144]);
  });
});

describe("road name picture", () => {
  // A fake measure: every character is `size * 0.55` wide.
  const measure = (text: string, size: number): number => text.length * size * 0.55;

  it("uses the biggest type that fits the line", () => {
    const short = fitStreetText(measure, "Example Road");
    expect(short.size).toBe(MAX_FONT_PX);
    expect(short.text).toBe("Example Road");
    const medium = fitStreetText(measure, "Bundesstraße Salzburg Nord");
    expect(medium.size).toBeLessThan(MAX_FONT_PX);
    expect(medium.size).toBeGreaterThanOrEqual(MIN_FONT_PX);
    expect(medium.width).toBeLessThanOrEqual(STREET_WIDTH);
  });

  it("cuts with an ellipsis, at the smallest size, what cannot fit", () => {
    const fitted = fitStreetText(measure, "A very long road name that no type size could ever bring onto one line of the display");
    expect(fitted.size).toBe(MIN_FONT_PX);
    expect(fitted.text.endsWith("…")).toBe(true);
    expect(fitted.width).toBeLessThanOrEqual(STREET_WIDTH);
  });
});

describe("turn layout on the glasses", () => {
  it("shows the distance on the card instead of repeating it in the text", () => {
    const view = buildView(progress, { ...options, bigDistance: true });
    expect(view.big).toBe("250 m");
    expect(view.body).toEqual(["Example Road"]);
    expect(view.body.join(" ")).not.toMatch(/\d/);
    // Far from the turn the footer still gives remaining distance and arrival.
    expect(view.footer).toMatch(/1\.2 km/);
  });

  it("keeps the text distance without the card, and in the overview", () => {
    expect(buildView(progress, options).big).toBeUndefined();
    const overview = buildView(progress, { ...options, bigDistance: true, layout: "overview" });
    expect(overview.big).toBeUndefined();
    expect(overview.body[0]).toContain("250 m");
  });

  it("leaves only arrow, distance and road within 200 m of the turn", () => {
    const near = buildView({ ...progress, distanceToManeuver: 150 }, { ...options, bigDistance: true });
    expect(near.footer).toBe("");
    expect(near.big).toBe("150 m");
    expect(near.body).toEqual(["Example Road"]);
    const edge = buildView({ ...progress, distanceToManeuver: 200 }, { ...options, bigDistance: true });
    expect(edge.footer).not.toBe("");
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

  it("puts arrow and distance side by side above the full-width road name, as a valid page", () => {
    const page = buildPage(buildView(progress, { ...options, bigDistance: true }), "turns");
    const [arrow, card, left, right] = page.imageObject ?? [];
    expect(arrow).toMatchObject({ containerName: "pixel-icon", width: 144, height: 144 });
    expect(card).toMatchObject({ containerName: "turn-distance", width: 288, height: 144 });
    expect((arrow?.xPosition ?? 0) + 144).toBeLessThanOrEqual(card?.xPosition ?? 0);
    expect((card?.xPosition ?? 0) + 288).toBeLessThanOrEqual(576);
    expect([left?.xPosition, right?.xPosition, left?.width, right?.width]).toEqual([0, 288, 288, 288]);
    expect(left?.yPosition).toBeGreaterThanOrEqual(144);
    const body = page.textObject?.find((text) => text.containerName === "body");
    expect(body?.yPosition).toBeGreaterThanOrEqual((left?.yPosition ?? 0) + (left?.height ?? 0));
    expect((body?.yPosition ?? 0) + (body?.height ?? 0)).toBeLessThanOrEqual(252);
    expect(body?.isEventCapture).toBe(1);
    expect(page.containerTotalNum).toBe(6);
    expect(page.imageObject).toHaveLength(4);
    const result = validateEvenHubPageContainer(page);
    expect(result.valid, JSON.stringify(result)).toBe(true);
  });
});
