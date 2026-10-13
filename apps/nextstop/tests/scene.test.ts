import { describe, expect, it } from "vitest";
import {
  ImageRawDataUpdateResult, StartUpPageCreateResult, validateEvenHubPageContainer,
} from "@evenrealities/even_hub_sdk";
import recorded from "../src/demo/plan-salzburg.json";
import { demoJourneys, demoPosition } from "../src/demo/demo";
import { buildSteps, guideState, type Step } from "../src/route/guide";
import { arrivalOf, departureOf, type TransitLeg, type WalkLeg } from "../src/route/journey";
import type { TurnType, WalkNav } from "../src/route/walk";
import { beatOf, guideScene, plainScene, type Scene } from "../src/route/scene";
import { menuFor } from "../src/route/menu";
import { buildPage, createPage, rebuildPage, updatePage } from "../src/glasses/render";
import { sameScene } from "../src/glasses/diff";
import {
  ARROW_SIZE, BODY_ID, CARD_HEIGHT, CARD_WIDTH, IMAGES, RIDE_BAND, SCREEN_HEIGHT, SCREEN_WIDTH, STREET_HEIGHT, STREET_HALF,
  WAIT_BAND, type PageKind,
} from "../src/glasses/layout";
import { ARROW_GRID, pixelArrowFor } from "../src/glasses/icons";
import { renderPixelIcon } from "../src/glasses/pixel";
import { createGrayCanvas } from "../src/glasses/png";
import {
  APPROACH_WINDOW_M, BAR_FULL_M, BAR_STEPS, approachSteps, bigDistance, drawBigNumber, drawTurnCard, labelWidth, numberKey,
  type BigNumber,
} from "../src/glasses/turncard";
import { BUS_CYCLE, BUS_FRAMES, busFrame, drawBusScene } from "../src/glasses/bus";
import { fitText } from "../src/glasses/words";
import { fitStreetText, MAX_FONT_PX, MIN_FONT_PX } from "../src/glasses/street";
import { departureBoard } from "../src/glasses/view";
import { placesView } from "../src/route/view";
import { locales } from "../src/i18n";

const HOME = { name: "Heim", lat: 47.796, lon: 13.016 };
const T0 = new Date("2026-10-13T12:00:00Z");
const journey = demoJourneys(recorded, T0, HOME, "de")[0]!;
const steps = buildSteps(journey);
const bus1 = journey.legs[1] as TransitLeg;
const walk1 = journey.legs[0] as WalkLeg;
const at = (now: Date) => demoPosition(journey, now)!;

const TURN_TYPES: readonly TurnType[] = [
  "depart", "arrive", "straight", "left", "slightLeft", "sharpLeft", "right", "slightRight", "sharpRight", "uturn", "roundabout",
];

function nav(toNext: number, type: TurnType = "left", street: string | null = "Sterneckstraße"): WalkNav {
  return {
    next: { type, ...(street ? { street } : {}), length: 200, shapeIndex: 3 },
    toNext, remaining: toNext + 300, off: 1, atEnd: false,
  };
}

/** The scene of step `index` for a walker at the stop, `walk` as given. */
function walkScene(walk: WalkNav | null, locale: "de" | "en" = "de"): Scene {
  const now = new Date(T0.getTime() + 60000);
  return guideScene(guideState(steps, now, at(now)), now, at(now), locale, { walk });
}

function size(png: Uint8Array): [number, number] {
  const view = new DataView(png.buffer, png.byteOffset);
  return [view.getUint32(16), view.getUint32(20)];
}

/** Bounding box of the white pixels of a grey buffer. */
function ink(pixels: Uint8Array, width: number, height: number, min = 200) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if ((pixels[y * width + x] ?? 0) >= min) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

describe("the approach bar", () => {
  it("is empty at the start of the window, rises, and is full within 50 m of the turn", () => {
    expect(BAR_FULL_M).toBe(50);
    expect(approachSteps(APPROACH_WINDOW_M + 100)).toBe(0);
    expect(approachSteps(APPROACH_WINDOW_M)).toBe(0);
    const steps = [150, 130, 110, 90, 70, 51, 50, 49, 20, 0].map((d) => approachSteps(d));
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(approachSteps(51)).toBeLessThan(BAR_STEPS);
    expect(approachSteps(50)).toBe(BAR_STEPS);
    expect(approachSteps(49)).toBe(BAR_STEPS);
    expect(approachSteps(0)).toBe(BAR_STEPS);
  });

  it("spans a short stretch by itself and never leaves 0…BAR_STEPS", () => {
    expect(approachSteps(80, 60)).toBe(0);
    expect(approachSteps(55, 60)).toBeGreaterThan(0);
    for (const d of [-5, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      const s = approachSteps(d, 0);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(BAR_STEPS);
    }
  });
});

describe("the big distance", () => {
  it("rounds calmly: 50 m steps from 200 m, 10 m below, tenths of a kilometre above", () => {
    expect(bigDistance(960, "de")).toBe("950 m");
    expect(bigDistance(512, "de")).toBe("500 m");
    expect(bigDistance(230, "de")).toBe("250 m");
    expect(bigDistance(124, "de")).toBe("120 m");
    expect(bigDistance(40, "de")).toBe("40 m");
    expect(bigDistance(1234, "de")).toBe("1,2 km");
    expect(bigDistance(1234, "en")).toBe("1.2 km");
    expect(bigDistance(12_000, "en")).toBe("12 km");
    expect(bigDistance(8, "de")).toBe("jetzt");
    expect(bigDistance(8, "en")).toBe("now");
    expect(bigDistance(Number.NaN, "de")).toBe("--");
  });

  it("fits the card at full size for every label, in both languages", () => {
    for (const locale of locales) {
      for (const metres of [0, 14, 15, 25, 99, 250, 990, 1000, 1234, 9949, 9950, 15_000]) {
        const label = bigDistance(metres, locale);
        // "jetzt" is a hair too wide at full size and shrinks a step; everything else fits at 10.
        if (/^\d/.test(label)) expect(labelWidth(label, 10), label).toBeLessThanOrEqual(CARD_WIDTH);
      }
    }
  });
});

describe("drawing the distance card", () => {
  it("draws digits of 70 px height and a bar of 36 px, filled to the steps", () => {
    const canvas = createGrayCanvas(CARD_WIDTH, CARD_HEIGHT);
    drawTurnCard(canvas, { label: "250 m", steps: 3 });
    const digits = ink({ ...canvas, pixels: canvas.pixels.map((v, i) => (i >= 90 * CARD_WIDTH ? 0 : v)) }.pixels, CARD_WIDTH, CARD_HEIGHT);
    expect(digits?.height).toBe(70);
    const at = (x: number, y: number) => canvas.pixels[y * CARD_WIDTH + x]!;
    // Bar blocks: 3 of 8 white, the rest dim grey, 36 px thick.
    const block = (CARD_WIDTH - 6 * 7) / 8;
    const y = 100 + 18;
    expect([0, 1, 2].map((i) => at(Math.round(i * (block + 6)) + 2, y))).toEqual([255, 255, 255]);
    expect(at(Math.round(3 * (block + 6)) + 2, y)).toBeLessThan(80);
    expect(at(Math.round(3 * (block + 6)) + 2, y)).toBeGreaterThan(0);
    expect(at(2, 100)).toBe(255);
    expect(at(2, 135)).toBe(255);
    expect(at(2, 99)).toBe(0);
  });

  it("makes the bar completely white when it is full", () => {
    const canvas = createGrayCanvas(CARD_WIDTH, CARD_HEIGHT);
    drawTurnCard(canvas, { label: "jetzt", steps: BAR_STEPS });
    const row = Array.from(canvas.pixels.slice(118 * CARD_WIDTH, 119 * CARD_WIDTH));
    const whites = row.filter((v) => v === 255).length;
    expect(whites).toBeGreaterThan(CARD_WIDTH - 6 * 7 - 8);
    expect(row.filter((v) => v > 0 && v < 255)).toHaveLength(0);
  });
});

describe("the arrows", () => {
  it("exist for every turn, 72 cells a side, and the left ones mirror the right ones", () => {
    for (const type of TURN_TYPES) {
      const grid = pixelArrowFor(type);
      expect(grid, type).toHaveLength(ARROW_GRID);
      expect(grid.every((line) => line.length === ARROW_GRID)).toBe(true);
      expect(grid.join("")).toContain("#");
    }
    const mirror = (lines: readonly string[]) => lines.map((line) => [...line].reverse().join(""));
    expect(pixelArrowFor("left")).toEqual(mirror(pixelArrowFor("right")));
    expect(pixelArrowFor("slightLeft")).toEqual(mirror(pixelArrowFor("slightRight")));
    expect(pixelArrowFor("left")).not.toEqual(pixelArrowFor("right"));
    expect(pixelArrowFor(undefined).join("")).not.toContain("#");
  });

  it("is drawn as a 144 x 144 image with thick strokes", async () => {
    const png = await renderPixelIcon(pixelArrowFor("right"), ARROW_SIZE, ARROW_SIZE);
    expect(size(png)).toEqual([144, 144]);
    // The head is wider than 70 px at its widest row.
    const widest = Math.max(...pixelArrowFor("right").map((line) => (line.match(/#/g) ?? []).length)) * 2;
    expect(widest).toBeGreaterThanOrEqual(70);
  });
});

describe("big numbers", () => {
  const draw = (card: BigNumber, width: number, height: number) => {
    const canvas = createGrayCanvas(width, height);
    drawBigNumber(canvas, card, width, height);
    return canvas.pixels;
  };

  it("fills most of the height of the halt count: one digit ~110 px, two digits still fit 144 px", () => {
    const one = ink(draw({ value: "2", unit: "" }, 144, RIDE_BAND), 144, RIDE_BAND);
    expect(one!.height).toBeGreaterThanOrEqual(100);
    const two = ink(draw({ value: "12", unit: "" }, 144, RIDE_BAND), 144, RIDE_BAND);
    expect(two!.height).toBeGreaterThanOrEqual(80);
    expect(two!.x0).toBeGreaterThanOrEqual(0);
    expect(two!.x1).toBeLessThan(144);
  });

  it("draws the countdown big with a half-size unit on the same baseline, inside the image", () => {
    for (const value of ["1", "2", "9", "12", "59"]) {
      const pixels = draw({ value, unit: "min" }, 288, WAIT_BAND);
      const box = ink(pixels, 288, WAIT_BAND)!;
      expect(box.height, value).toBeGreaterThanOrEqual(90);
      expect(box.x0).toBeGreaterThanOrEqual(0);
      expect(box.x1).toBeLessThan(288);
    }
    // "min" sits low: nothing of it above the middle of the digits.
    const pixels = draw({ value: "2", unit: "min" }, 288, WAIT_BAND);
    const all = ink(pixels, 288, WAIT_BAND)!;
    const rightPart = ink(pixels.map((v, i) => (i % 288 < 150 ? 0 : v)), 288, WAIT_BAND)!;
    expect(rightPart.y1).toBe(all.y1);
    expect(rightPart.height).toBeLessThan(all.height * 0.6);
  });

  it("inverts to a white field with black glyphs, for the pulse", () => {
    const normal = draw({ value: "!", unit: "" }, 144, RIDE_BAND);
    const inverted = draw({ value: "!", unit: "", inverted: true }, 144, RIDE_BAND);
    expect(normal[0]).toBe(0);
    expect(inverted[0]).toBe(255);
    expect(numberKey({ value: "!", unit: "" })).not.toBe(numberKey({ value: "!", unit: "", inverted: true }));
  });

  it("fits a word such as 'jetzt' and an hour countdown without leaving the image", () => {
    for (const value of ["jetzt", "now", "1h05", "2h30"]) {
      const box = ink(draw({ value, unit: "" }, 288, WAIT_BAND), 288, WAIT_BAND)!;
      expect(box.x0).toBeGreaterThanOrEqual(0);
      expect(box.x1).toBeLessThan(288);
    }
  });
});

describe("the bus", () => {
  const frame = (n: number) => {
    const canvas = createGrayCanvas(288, WAIT_BAND);
    drawBusScene(canvas, n);
    return canvas.pixels;
  };

  it("has six frames at a 500 ms beat: it arrives, stands for a while, and comes again", () => {
    expect(BUS_FRAMES).toBe(6);
    expect(Array.from({ length: BUS_CYCLE + 2 }, (_, tick) => busFrame(tick))).toEqual([0, 1, 2, 3, 4, 5, 5, 5, 5, 0, 1]);
    expect(busFrame(-1)).toBeGreaterThanOrEqual(0);
  });

  it("drives in from the left: every frame differs, the first is mostly outside, the last stands at the sign", () => {
    const frames = [-1, 0, 1, 2, 3, 4, 5].map(frame);
    for (let i = 1; i < frames.length; i++) expect(frames[i], `frame ${i - 1}`).not.toEqual(frames[i - 1]);
    const white = (pixels: Uint8Array) => pixels.filter((v) => v === 255).length;
    expect(white(frames[1]!)).toBeGreaterThan(white(frames[0]!));
    expect(white(frames[2]!)).toBeGreaterThan(white(frames[1]!) - 1);
    // Frame 0: only the tail end of the bus is in the picture (left of x=30), nothing beyond.
    const first = ink(frame(0).map((v, i) => (Math.floor(i / 288) < 100 ? v : 0)), 288, WAIT_BAND)!;
    expect(first.x0).toBe(0);
    // Last frame: the bus body, well clear of the sign (x >= 246).
    const body = (n: number) => frame(n)[82 * 288 + 150];
    expect(body(5)).toBe(255);
    expect(body(0)).toBe(0);
    // The empty stop has the road and the sign, and no bus.
    expect(frame(-1)[112 * 288 + 5]).toBe(255);
    expect(frame(-1)[82 * 288 + 150]).toBe(0);
  });
});

describe("words as pictures", () => {
  const measure = (text: string, size: number) => text.length * size * 0.5;

  it("fits the biggest size that is wide enough, and cuts with an ellipsis only at the smallest", () => {
    expect(fitText(measure, "Halte", 270, 64).size).toBe(64);
    expect(fitText(measure, "Halte", 100, 64).size).toBe(40);
    expect(fitText(measure, "Aussteigen", 270, 56).size).toBeLessThanOrEqual(54);
    const cut = fitText(measure, "Ein sehr langer Straßenname an der Salzach", 270, 46, 30);
    expect(cut.text.endsWith("…")).toBe(true);
    expect(cut.size).toBe(30);
    expect(cut.width).toBeLessThanOrEqual(270);
    expect(fitStreetText(measure, "Bahnhofstraße").size).toBeLessThanOrEqual(MAX_FONT_PX);
    expect(fitStreetText(measure, "x".repeat(200)).size).toBe(MIN_FONT_PX);
  });
});

describe("the walking page", () => {
  it("shows arrow, distance and street as pictures, and the next vehicle as one small line", () => {
    const scene = walkScene(nav(400));
    expect(scene.kind).toBe("walk");
    expect(scene.images.map((image) => image.id)).toEqual([4, 5, 6, 7]);
    expect(scene.view.body).toHaveLength(1);
    expect(scene.view.body[0]).toMatch(/^Dann: O-Bus 2 Richtung .+ · in \d+ min$/);
    expect(scene.view.body[0]!.length).toBeLessThanOrEqual(50);
    expect(scene.animated).toBe(false);
  });

  it("draws every picture at the size of its container", async () => {
    const scene = walkScene(nav(400));
    const sizes = await Promise.all(scene.images.map(async (image) => size(await image.render())));
    expect(sizes).toEqual([[144, 144], [288, 144], [288, STREET_HEIGHT], [288, STREET_HEIGHT]]);
    expect(STREET_HALF * 2).toBe(576);
  });

  it("sends a new distance only when the rounded label or a bar block changes", () => {
    const key = (m: number) => walkScene(nav(m)).images.find((image) => image.id === 5)!.key;
    expect(key(412)).toBe(key(398));
    expect(key(412)).not.toBe(key(360));
    // Inside 50 m the bar is full; 10 m steps still change the label.
    expect(key(48)).not.toBe(key(31));
    expect(key(300)).not.toBe(key(140));
    expect(key(500)).toBe(key(510));
  });

  it("fills the bar completely under 50 m and puts the distance in the card key", () => {
    expect(walkScene(nav(49)).images.find((image) => image.id === 5)!.key).toContain("|8");
    expect(walkScene(nav(49)).images.find((image) => image.id === 5)!.key).toContain("50 m");
    expect(walkScene(nav(300)).images.find((image) => image.id === 5)!.key).toContain("|0");
  });

  it("changes the arrow with the turn, and names the street, or the turn when there is none", () => {
    const keyOf = (scene: Scene, id: number) => scene.images.find((image) => image.id === id)!.key;
    expect(keyOf(walkScene(nav(100, "left")), 4)).not.toBe(keyOf(walkScene(nav(100, "right")), 4));
    expect(keyOf(walkScene(nav(100, "left")), 6)).toBe("street:Sterneckstraße");
    expect(keyOf(walkScene(nav(100, "left", null)), 6)).toBe("street:links abbiegen");
    expect(keyOf(walkScene(nav(100, "left", null), "en"), 6)).toBe("street:turn left");
    expect(keyOf(walkScene(nav(40, "arrive", null)), 6)).toBe("street:Salzburg Vogelweiderstraße");
  });

  it("falls back to text while there is no walking route, and shows 'what is left' for a walk to the goal", () => {
    expect(walkScene(null).kind).toBe("text");
    const now = new Date(T0.getTime() + 60000);
    const last = steps.findIndex((step) => step.kind === "walk" && (step as Extract<Step, { kind: "walk" }>).leg.toDestination);
    const state = guideState(steps, now, at(now), { index: last, autoAtSet: 0 });
    expect(state.step.kind).toBe("walk");
    const scene = guideScene(state, now, at(now), "de", { walk: nav(250, "right") });
    expect(scene.kind).toBe("walk");
    expect(scene.view.body[0]).toMatch(/^noch 5[0-9]0 m · \d+ min zu Fuß$/);
  });

  it("keeps the 'in 4 min' when the vehicle's headsign is too long for the line", () => {
    const long: TransitLeg = { ...bus1, headsign: "Salzburg Bergheim Gewerbegebiet Süd Betriebsgelände Ost" };
    const walkStep: Step = { kind: "walk", leg: walk1, transfer: false, next: long };
    const state = { ...guideState(steps, T0, at(T0)), step: walkStep };
    const scene = guideScene(state, T0, at(T0), "de", { walk: nav(120) });
    expect(scene.view.body[0]!.length).toBeLessThanOrEqual(50);
    expect(scene.view.body[0]).toMatch(/… · in \d+ min$/);
  });
});

describe("waiting at the stop", () => {
  const board = (secondsBefore: number, beat = 0, locale: "de" | "en" = "de"): Scene => {
    const now = new Date(departureOf(bus1).getTime() - secondsBefore * 1000);
    const stop = bus1.stops[0]!.stop;
    const position = { lat: stop.lat, lon: stop.lon, accuracy: 10 };
    return guideScene(guideState(steps, now, position), now, position, locale, { beat });
  };

  it("shows the countdown in big digits and the line and direction as text", () => {
    const scene = board(150);
    expect(scene.kind).toBe("wait");
    expect(scene.images.map((image) => image.id)).toEqual([4, 5]);
    expect(scene.images[0]!.key).toBe("count:2|min|n");
    expect(scene.view.body[0]).toMatch(/^> O-Bus 2 Richtung /);
    expect(scene.view.body[1]).toMatch(/^um \d\d:\d\d .*\(in 2 min\)$/);
    expect(scene.view.body).toHaveLength(4);
    expect(scene.view.body.every((line) => line.length <= 50)).toBe(true);
    expect(board(150, 0, "en").view.body[0]).toMatch(/^> O-Bus 2 towards /);
  });

  it("counts down by the minute and sends nothing in between", () => {
    const keys = [300, 240, 200, 150, 125, 95, 61].map((seconds) => board(seconds).images[0]!.key);
    expect(keys).toEqual(["count:5|min|n", "count:4|min|n", "count:3|min|n", "count:2|min|n", "count:2|min|n", "count:1|min|n", "count:1|min|n"]);
    expect(sameScene(board(130), board(121))).toBe(true);
  });

  it("is still, with an empty stop, until the last minute", () => {
    const scene = board(150);
    expect(scene.animated).toBe(false);
    expect(scene.images[1]!.key).toBe("bus:-1");
    // The beat changes nothing before that.
    expect(sameScene(board(150, 0), board(150, 3))).toBe(true);
  });

  it("brings the bus in under a minute, one frame per beat, at least 500 ms apart", () => {
    const scenes = [0, 1, 2, 3, 4, 5].map((beat) => board(30, beat));
    expect(scenes.every((scene) => scene.animated)).toBe(true);
    expect(scenes.map((scene) => scene.images[1]!.key)).toEqual(["bus:0", "bus:1", "bus:2", "bus:3", "bus:4", "bus:5"]);
    expect(scenes[0]!.images[0]!.key).toBe("count:jetzt||n");
    expect(board(30, 0, "en").images[0]!.key).toBe("count:now||n");
    // Frame time: the redraw timer runs at 500 ms.
    expect(beatOf(1000)).toBe(2);
    expect(beatOf(1499)).toBe(2);
    expect(beatOf(1500)).toBe(3);
    // The same beat is the same picture: no resend.
    expect(sameScene(board(30, 4), board(20, 4))).toBe(true);
    expect(sameScene(board(30, 4), board(30, 5))).toBe(false);
  });

  it("draws both pictures at the size of their containers", async () => {
    const scene = board(30, 2);
    const sizes = await Promise.all(scene.images.map(async (image) => size(await image.render())));
    expect(sizes).toEqual([[288, WAIT_BAND], [288, WAIT_BAND]]);
  });

  it("says 'Umsteigen' in front of the line on a change", () => {
    const bus2 = journey.legs[3] as TransitLeg;
    const now = new Date(departureOf(bus2).getTime() - 120000);
    const stop = bus2.stops[0]!.stop;
    const position = { lat: stop.lat, lon: stop.lon, accuracy: 10 };
    const scene = guideScene(guideState(steps, now, position, { index: 3, autoAtSet: guideState(steps, now, position).auto }), now, position, "de");
    expect(scene.kind).toBe("wait");
    expect(scene.view.body[0]).toMatch(/^> Umsteigen: /);
  });
});

describe("riding", () => {
  /** A ride with a stop every five minutes, so the count of halts left is easy to place. */
  const slow: TransitLeg = {
    ...bus1,
    stops: bus1.stops.map((s, i) => ({ ...s, scheduled: new Date(departureOf(bus1).getTime() + i * 5 * 60000), expected: new Date(departureOf(bus1).getTime() + i * 5 * 60000), source: "scheduled" as const })),
  };
  const slowSteps = buildSteps({ ...journey, legs: [journey.legs[0]!, slow, ...journey.legs.slice(2)] });
  const stops = slow.stops.length;

  const ride = (stopIndex: number, secondsAfter = 60, beat = 0, locale: "de" | "en" = "de"): Scene => {
    const now = new Date(slow.stops[stopIndex]!.expected.getTime() + secondsAfter * 1000);
    return guideScene(guideState(slowSteps, now, null), now, null, locale, { beat });
  };

  it("has more than three stops, so the cases below exist", () => {
    expect(stops).toBeGreaterThanOrEqual(5);
  });

  it("shows 'noch 2 Halte' as pictures, with the stop to get off at and its time as text", () => {
    const scene = ride(stops - 4);
    expect(scene.kind).toBe("ride");
    expect(scene.images.map((image) => image.id)).toEqual([4, 5, 6]);
    expect(scene.images[1]!.key).toBe("digits:3||n");
    expect(scene.images[0]!.key).toContain("noch");
    expect(scene.images[2]!.key).toContain("Halte");
    const alight = slow.stops[stops - 1]!;
    expect(scene.view.body[0]).toMatch(new RegExp(`^> Aussteigen: .+ · an \\d\\d:\\d\\d$`));
    expect(scene.view.body[0]).toContain(alight.stop.name.replace(/\s*\(.*\)$/, "").slice(0, 10));
    expect(scene.animated).toBe(false);
    expect(ride(stops - 3).images[1]!.key).toBe("digits:2||n");
    expect(ride(stops - 3).view.body[1]).toBe("Danach aussteigen – bereit machen!");
    expect(ride(stops - 4).view.body[1]).toMatch(/^Nächster Halt: /);
  });

  it("pulses 'get off' every beat when the next stop is the one to get off at", () => {
    const quiet = ride(stops - 2);
    expect(quiet.animated).toBe(true);
    expect(quiet.images[1]!.key).toBe("digits:!||n");
    expect(ride(stops - 2, 60, 1).images[1]!.key).toBe("digits:!||i");
    expect(ride(stops - 2, 60, 2).images[1]!.key).toBe("digits:!||n");
    expect(quiet.images[2]!.key).toContain("Aussteigen");
    expect(quiet.images[0]!.key).toContain("Nächster");
    expect(sameScene(ride(stops - 2, 60, 0), ride(stops - 2, 60, 2))).toBe(true);
    expect(sameScene(ride(stops - 2, 60, 0), ride(stops - 2, 60, 1))).toBe(false);
    expect(ride(stops - 2, 60, 0, "en").images[2]!.key).toContain("Get off");
  });

  it("does not warn when the vehicle is merely arriving at a stop on the way", () => {
    // Demo ride of O-Bus 10: at minute 24 it is arriving at the third stop, with 7 halts left.
    const now = new Date(T0.getTime() + 24 * 60000);
    const state = guideState(steps, now, at(now));
    expect(state.progress?.arriving).toBe(true);
    const scene = guideScene(state, now, at(now), "de");
    expect(scene.kind).toBe("ride");
    expect(scene.animated).toBe(false);
    expect(scene.images[1]!.key).toBe(`digits:${state.stopsLeft}||n`);
    expect(scene.view.body[1]).toMatch(/^Nächster Halt: /);
  });

  it("only the digit changes between the beats of the pulse - the words are not sent again", () => {
    const a = ride(stops - 2, 60, 0), b = ride(stops - 2, 60, 1);
    expect(a.images.map((i) => i.key === b.images.find((o) => o.id === i.id)!.key)).toEqual([true, false, true]);
  });

  it("draws the three pictures at the size of their containers", async () => {
    const scene = ride(stops - 2, 60, 1);
    const sizes = await Promise.all(scene.images.map(async (image) => size(await image.render())));
    expect(sizes).toEqual([[144, RIDE_BAND], [144, RIDE_BAND], [288, RIDE_BAND]]);
  });

  it("stays inside the display and the line width", () => {
    for (const locale of locales) {
      for (let i = 0; i < stops; i++) {
        const scene = ride(i, 30, i, locale);
        expect(scene.view.body.length).toBeLessThanOrEqual(5);
        for (const line of scene.view.body) expect(line.length, line).toBeLessThanOrEqual(50);
        expect(scene.view.footer.length).toBeLessThanOrEqual(46);
      }
    }
  });

  it("leaves the arrival and the missed bus as plain text", () => {
    const done = guideScene(guideState(steps, new Date(journey.end.getTime() + 20 * 60000), null), new Date(journey.end.getTime() + 20 * 60000), null, "de");
    expect(done.kind).toBe("text");
    expect(arrivalOf(bus1).getTime()).toBeGreaterThan(departureOf(bus1).getTime());
  });
});

// ---- container limits -------------------------------------------------------------

function sampleScenes(): Record<PageKind, Scene> {
  const waitNow = new Date(departureOf(bus1).getTime() - 150000);
  const stop = bus1.stops[0]!.stop;
  const wait = guideScene(guideState(steps, waitNow, { lat: stop.lat, lon: stop.lon, accuracy: 10 }), waitNow, null, "de");
  const rideNow = new Date(departureOf(bus1).getTime() + 90000);
  const ride = guideScene(guideState(steps, rideNow, null), rideNow, null, "de");
  return {
    text: plainScene(placesView([{ id: "a", name: "Heim", lat: 0, lon: 0, isNow: false }], 0, T0, "de")),
    walk: walkScene(nav(300)),
    wait,
    ride,
  };
}

describe("the pages obey the container limits of the glasses", () => {
  const scenes = sampleScenes();
  const menu = menuFor("guide", "de");

  it("has a sample of every kind", () => {
    expect(Object.entries(scenes).map(([kind, scene]) => `${kind}=${scene.kind}`)).toEqual(["text=text", "walk=walk", "wait=wait", "ride=ride"]);
  });

  for (const kind of ["text", "walk", "wait", "ride"] as const) {
    it(`${kind}: at most four images of 20…288 x 20…144, exactly one event capture, all on the display, valid for the SDK`, () => {
      const page = buildPage(scenes[kind], menu);
      const images = page.imageObject ?? [];
      const texts = page.textObject ?? [];
      expect(images.length).toBeLessThanOrEqual(4);
      expect(images.length).toBe(IMAGES[kind].length);
      for (const image of images) {
        expect(image.width).toBeGreaterThanOrEqual(20); expect(image.width).toBeLessThanOrEqual(288);
        expect(image.height).toBeGreaterThanOrEqual(20); expect(image.height).toBeLessThanOrEqual(144);
        expect(image.xPosition! + image.width!).toBeLessThanOrEqual(SCREEN_WIDTH);
        expect(image.yPosition! + image.height!).toBeLessThanOrEqual(SCREEN_HEIGHT);
      }
      expect(texts.filter((text) => text.isEventCapture === 1)).toHaveLength(1);
      expect(texts.find((text) => text.isEventCapture === 1)?.containerID).toBe(BODY_ID);
      expect(page.containerTotalNum).toBe(images.length + texts.length);
      expect(page.containerTotalNum).toBeLessThanOrEqual(12);
      const ids = [...images, ...texts].map((c) => c.containerID);
      expect(new Set(ids).size).toBe(ids.length);
      // Images never overlap each other, and the text never sits on a picture.
      const boxes = images.map((i) => [i.xPosition!, i.yPosition!, i.xPosition! + i.width!, i.yPosition! + i.height!] as const);
      boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => {
        expect(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1], `${a} vs ${b}`).toBe(true);
      }));
      for (const text of texts) {
        const t = [text.xPosition!, text.yPosition!, text.xPosition! + text.width!, text.yPosition! + text.height!] as const;
        if (kind !== "text") for (const b of boxes) expect(t[2] <= b[0] || b[2] <= t[0] || t[3] <= b[1] || b[3] <= t[1], text.containerName).toBe(true);
        expect(t[3]).toBeLessThanOrEqual(SCREEN_HEIGHT);
      }
      const result = validateEvenHubPageContainer(page);
      expect(result.valid, JSON.stringify(result)).toBe(true);
    });
  }

  it("the walking page is the OpenGlance layout: arrow 144, card 288 x 144, street across the full width", () => {
    const page = buildPage(scenes.walk, menu);
    const [arrow, card, left, right] = page.imageObject!;
    expect([arrow!.width, arrow!.height, card!.width, card!.height]).toEqual([144, 144, 288, 144]);
    expect([left!.xPosition, right!.xPosition, left!.width, right!.width]).toEqual([0, 288, 288, 288]);
    expect(page.containerTotalNum).toBe(6);
  });

  it("the ride page spans the display edge to edge with three pictures in a row", () => {
    const page = buildPage(scenes.ride, menu);
    const images = page.imageObject!;
    expect(images).toHaveLength(3);
    expect(images[0]!.xPosition).toBe(0);
    expect(images[2]!.xPosition! + images[2]!.width!).toBe(576);
  });
});

// ---- creating, rebuilding and updating ----------------------------------------------

function recordingBridge() {
  const log: string[] = [];
  const bridge = {
    rebuildPageContainer: async (page: { imageObject?: { containerName: string }[] }) => { log.push(`rebuild:${(page.imageObject ?? []).map((i) => i.containerName).join("+") || "text"}`); return true; },
    createStartUpPageContainer: async () => { log.push("create"); return StartUpPageCreateResult.success; },
    textContainerUpgrade: async (u: { containerName?: string }) => { log.push(`text:${u.containerName}`); return true; },
    updateImageRawData: async (u: { containerName?: string }) => { log.push(`image:${u.containerName}`); return ImageRawDataUpdateResult.success; },
  };
  return { bridge: bridge as never, log };
}

describe("sending pages and pictures", () => {
  it("creates the first page once and sends each of its pictures once", async () => {
    const { bridge, log } = recordingBridge();
    const scenes = sampleScenes();
    const menu = menuFor("guide", "de");
    expect((await createPage(bridge, scenes.walk, menu)).ok).toBe(true);
    expect(log.filter((entry) => entry === "create")).toHaveLength(1);
    expect(log.filter((entry) => entry.startsWith("image:"))).toEqual(["image:arrow", "image:distance", "image:street-left", "image:street-right"]);

    // The same pictures again: only the text moves.
    log.length = 0;
    expect((await updatePage(bridge, scenes.walk)).ok).toBe(true);
    expect(log).toEqual(["text:body", "text:footer"]);

    // One distance block further: exactly one picture goes out.
    log.length = 0;
    const next = walkScene(nav(100));
    await updatePage(bridge, next);
    expect(log.filter((entry) => entry.startsWith("image:"))).toEqual(["image:distance"]);
  });

  it("changes the page kind by rebuilding with the other containers, and never creates a second time", async () => {
    const { bridge, log } = recordingBridge();
    const scenes = sampleScenes();
    const menu = menuFor("guide", "de");
    await createPage(bridge, scenes.walk, menu);
    log.length = 0;
    expect((await rebuildPage(bridge, scenes.wait, menu)).ok).toBe(true);
    expect(log).toEqual(["rebuild:countdown+bus", "image:countdown", "image:bus"]);
    log.length = 0;
    await rebuildPage(bridge, scenes.ride, menu);
    expect(log).toEqual(["rebuild:before+count+after", "image:before", "image:count", "image:after"]);
    log.length = 0;
    await rebuildPage(bridge, scenes.text, menu);
    expect(log).toEqual(["rebuild:text"]);
    expect(log).not.toContain("create");
    // Back on a picture page after a text page: pictures that look the same as before are sent again.
    log.length = 0;
    await rebuildPage(bridge, scenes.walk, menu);
    expect(log.filter((entry) => entry.startsWith("image:"))).toHaveLength(4);
  });

  it("sends a pulse as one small picture per beat and nothing else", async () => {
    const { bridge, log } = recordingBridge();
    const menu = menuFor("guide", "de");
    const stopsLeft1 = (beat: number): Scene => {
      const slow: TransitLeg = { ...bus1, stops: bus1.stops.map((s, i) => ({ ...s, expected: new Date(departureOf(bus1).getTime() + i * 300000) })) };
      const slowSteps = buildSteps({ ...journey, legs: [journey.legs[0]!, slow, ...journey.legs.slice(2)] });
      const now = new Date(slow.stops[slow.stops.length - 2]!.expected.getTime() + 60000);
      return guideScene(guideState(slowSteps, now, null), now, null, "de", { beat });
    };
    await createPage(bridge, stopsLeft1(0), menu);
    for (const beat of [1, 2, 3]) {
      log.length = 0;
      await updatePage(bridge, stopsLeft1(beat));
      expect(log.filter((entry) => entry.startsWith("image:"))).toEqual(["image:count"]);
    }
  });

  it("reports a refused picture instead of pretending it arrived", async () => {
    const { bridge } = recordingBridge();
    const refusing = { ...(bridge as object), updateImageRawData: async () => ImageRawDataUpdateResult.imageSizeInvalid } as never;
    const result = await createPage(refusing, sampleScenes().walk, menuFor("guide", "de"));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("image:imageSizeInvalid");
  });

  it("treats departure board pages as plain text scenes, with no pictures", () => {
    const board = departureBoard({ id: "x", name: "Stop", lat: 0, lon: 0 }, [], null, "de");
    const scene = plainScene(board);
    expect(scene.images).toHaveLength(0);
    expect(buildPage(scene, null).imageObject ?? []).toHaveLength(0);
  });
});
