import type { TravelMode } from "../routing/provider";
import { createGrayCanvas, encodePng, type GrayCanvas } from "./png";

/**
 * The turn card: the distance to the next turn in very large pixel digits,
 * and below it a thick bar that fills as the turn comes closer.
 *
 * The glasses' text has one fixed size, so "big" has to be an image: the
 * largest image container the G2 accepts, 288 × 144. It is sent only when
 * what it shows changes — the rounded distance or one of the eight bar steps
 * — never for every GPS fix.
 */

export const CARD_WIDTH = 288;
export const CARD_HEIGHT = 144;
/** The bar is split into this many blocks; the image changes only when one fills. */
export const BAR_STEPS = 8;

/**
 * How far before a turn the bar starts filling, per way of travel: about half
 * a minute to two minutes of travel, so it moves visibly but is not full long
 * before anything happens.
 */
export const APPROACH_WINDOW_M: Readonly<Record<TravelMode, number>> = {
  walking: 150,
  cycling: 300,
  driving: 600,
};

export interface TurnCard {
  /** The distance as shown, e.g. "250 m", "1,2 km", "now". */
  readonly label: string;
  /** Filled bar blocks, 0…BAR_STEPS. */
  readonly steps: number;
}

/**
 * Filled blocks for `distance` metres to the turn. The bar spans the
 * approach window, or the whole stretch if it is shorter, so after a quick
 * turn-then-turn the bar starts empty instead of half full.
 */
export function approachSteps(distance: number, legLength: number, mode: TravelMode, steps = BAR_STEPS): number {
  if (!Number.isFinite(distance)) return 0;
  const window = APPROACH_WINDOW_M[mode];
  const span = legLength > 0 && Number.isFinite(legLength) ? Math.min(legLength, window) : window;
  const fill = 1 - Math.max(0, distance) / span;
  return Math.max(0, Math.min(steps, Math.floor(fill * steps + 1e-9)));
}

export function cardKey(card: TurnCard | null): string {
  return card ? card.label + "|" + card.steps : "blank";
}

/** 5 × 7 pixel glyphs for what a distance label can contain (a few are narrower than 5 columns). */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  ".": ["..", "..", "..", "..", "..", "##", "##"],
  ",": ["..", "..", "..", "..", "##", ".#", "#."],
  "-": [".....", ".....", ".....", "####.", ".....", ".....", "....."],
  "m": [".....", ".....", "##.#.", "#.#.#", "#.#.#", "#.#.#", "#.#.#"],
  "k": ["#....", "#....", "#..#.", "#.#..", "##...", "#.#..", "#..#."],
  "n": [".....", ".....", "####.", "#...#", "#...#", "#...#", "#...#"],
  "o": [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
  "w": [".....", ".....", "#...#", "#...#", "#.#.#", "#.#.#", ".#.#."],
  "j": ["...#.", ".....", "..##.", "...#.", "...#.", "#..#.", ".##.."],
  "e": [".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
  "t": [".#...", ".#...", "####.", ".#...", ".#...", ".#..#", "..##."],
  "z": [".....", ".....", "#####", "...#.", "..#..", ".#...", "#####"],
};

/**
 * Pixel scale of the digits: 5 × 7 glyphs become 50 × 70, twice the height of
 * the first turn card, and "250 m" and "1,2 km" still fit the 288 px image.
 */
export const DIGIT_SCALE = 10;
const SPACE_ADVANCE = 2;
/** Where the digits start from the top, and the bar's place below them. */
const DIGIT_TOP = 6;
const BAR_TOP = 100;
const BAR_HEIGHT = 36;

/** Columns a glyph advances: its own width plus one blank column. */
function advanceOf(glyph: readonly string[]): number {
  return (glyph[0]?.length ?? 0) + 1;
}

/** Width in pixels of `label` at `scale`; characters without a glyph count as narrow spaces. */
export function labelWidth(label: string, scale = DIGIT_SCALE): number {
  let width = 0;
  for (const char of label) {
    const glyph = GLYPHS[char];
    width += (glyph ? advanceOf(glyph) : SPACE_ADVANCE) * scale;
  }
  return Math.max(0, width - scale);
}

export type CardContext = Pick<GrayCanvas, "fillStyle" | "fillRect">;

/**
 * Black card; white digits centred at the top; the bar below as thick blocks —
 * filled white, empty dim grey so its length can be read before it fills.
 * A null card (no turn to show) stays black.
 */
export function drawTurnCard(ctx: CardContext, card: TurnCard | null, width = CARD_WIDTH, height = CARD_HEIGHT): void {
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
  if (!card) return;

  // Shrink only if a label would not fit ("jetzt" is the widest at full size, by a hair).
  let scale = DIGIT_SCALE;
  while (scale > 1 && labelWidth(card.label, scale) > width) scale--;
  ctx.fillStyle = "#fff";
  let x = Math.max(0, Math.floor((width - labelWidth(card.label, scale)) / 2));
  for (const char of card.label) {
    const glyph = GLYPHS[char];
    if (!glyph) { x += SPACE_ADVANCE * scale; continue; }
    glyph.forEach((row, gy) => {
      for (let gx = 0; gx < row.length; gx++) if (row[gx] === "#") ctx.fillRect(x + gx * scale, DIGIT_TOP + gy * scale, scale, scale);
    });
    x += advanceOf(glyph) * scale;
  }

  const gap = 6, barTop = Math.min(BAR_TOP, height - BAR_HEIGHT - 2);
  const block = (width - gap * (BAR_STEPS - 1)) / BAR_STEPS;
  for (let i = 0; i < BAR_STEPS; i++) {
    ctx.fillStyle = i < card.steps ? "#fff" : "#333";
    ctx.fillRect(Math.round(i * (block + gap)), barTop, Math.round(block), BAR_HEIGHT);
  }
}

export async function renderTurnCardPng(card: TurnCard | null, width = CARD_WIDTH, height = CARD_HEIGHT): Promise<Uint8Array> {
  const canvas = createGrayCanvas(width, height);
  drawTurnCard(canvas, card, width, height);
  return encodePng(width, height, canvas.pixels);
}
