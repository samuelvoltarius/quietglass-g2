import type { TravelMode } from "../routing/provider";
import { createGrayCanvas, encodePng, type GrayCanvas } from "./png";

/**
 * The turn card: the distance to the next turn in large pixel digits, and
 * below it a bar that fills as the turn comes closer.
 *
 * The glasses' text has one fixed size, so "big" has to be an image. It is
 * sent only when what it shows changes — the rounded distance or one of the
 * eight bar steps — never for every GPS fix.
 */

export const CARD_WIDTH = 288;
export const CARD_HEIGHT = 64;
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

/** 5 × 7 pixel glyphs for what a distance label can contain. */
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
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."],
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

/** Pixel scale of the digits: 5 × 7 glyphs become 25 × 35. */
export const DIGIT_SCALE = 5;
const ADVANCE = 6; // glyph columns plus one blank column
const SPACE_ADVANCE = 3;

/** Width in pixels of `label` at `scale`; characters without a glyph count as narrow spaces. */
export function labelWidth(label: string, scale = DIGIT_SCALE): number {
  let width = 0;
  for (const char of label) width += (GLYPHS[char] ? ADVANCE : SPACE_ADVANCE) * scale;
  return Math.max(0, width - scale);
}

export type CardContext = Pick<GrayCanvas, "fillStyle" | "fillRect">;

/**
 * Black card; white digits top left; the bar along the bottom as blocks —
 * filled white, empty dim grey so its length can be read before it fills.
 * A null card (no turn to show) stays black.
 */
export function drawTurnCard(ctx: CardContext, card: TurnCard | null, width = CARD_WIDTH, height = CARD_HEIGHT): void {
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
  if (!card) return;

  // Shrink only if a label would not fit (it never should: "10,0 km" is 7 glyphs).
  let scale = DIGIT_SCALE;
  while (scale > 1 && labelWidth(card.label, scale) > width) scale--;
  ctx.fillStyle = "#fff";
  let x = 0;
  for (const char of card.label) {
    const glyph = GLYPHS[char];
    if (!glyph) { x += SPACE_ADVANCE * scale; continue; }
    glyph.forEach((row, gy) => {
      for (let gx = 0; gx < row.length; gx++) if (row[gx] === "#") ctx.fillRect(x + gx * scale, 2 + gy * scale, scale, scale);
    });
    x += ADVANCE * scale;
  }

  const gap = 4, barTop = height - 16, barHeight = 14;
  const block = (width - gap * (BAR_STEPS - 1)) / BAR_STEPS;
  for (let i = 0; i < BAR_STEPS; i++) {
    ctx.fillStyle = i < card.steps ? "#fff" : "#333";
    ctx.fillRect(Math.round(i * (block + gap)), barTop, Math.round(block), barHeight);
  }
}

export async function renderTurnCardPng(card: TurnCard | null, width = CARD_WIDTH, height = CARD_HEIGHT): Promise<Uint8Array> {
  const canvas = createGrayCanvas(width, height);
  drawTurnCard(canvas, card, width, height);
  return encodePng(width, height, canvas.pixels);
}
