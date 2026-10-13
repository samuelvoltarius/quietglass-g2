import type { Locale } from "../i18n";
import { t } from "../messages";
import { createGrayCanvas, encodePng, type GrayCanvas } from "./png";
import { CARD_HEIGHT, CARD_WIDTH } from "./layout";

/**
 * Everything the guide draws in big pixel digits: the distance to the next
 * turn with its approach bar, the countdown at a stop, the number of halts
 * left on a ride.
 *
 * The glasses' text has one fixed size, so "big" has to be an image: 5 x 7
 * pixel glyphs scaled up by whole pixels, no canvas needed, so the same bytes
 * come out in the app and in the tests. Images are sent only when what they
 * show changes - the rounded distance, one of eight bar steps, the minute -
 * never for every GPS fix.
 */

export { CARD_HEIGHT, CARD_WIDTH };
/** The bar is split into this many blocks; the image changes only when one fills. */
export const BAR_STEPS = 8;
/** Within this distance of the turn the bar is full. */
export const BAR_FULL_M = 50;
/** The bar starts filling this far before the turn (about two minutes of walking). */
export const APPROACH_WINDOW_M = 150;

export interface TurnCard {
  /** The distance as shown, e.g. "250 m", "1,2 km", "jetzt". */
  readonly label: string;
  /** Filled bar blocks, 0…BAR_STEPS. */
  readonly steps: number;
}

/**
 * Filled blocks for `distance` metres to the turn: empty at the start of the
 * window, full from 50 m on. A short stretch (`legLength`) spans the bar by
 * itself, so after a quick turn-then-turn it starts empty instead of half full.
 */
export function approachSteps(distance: number, legLength = 0, steps = BAR_STEPS): number {
  if (!Number.isFinite(distance)) return 0;
  if (distance <= BAR_FULL_M) return steps;
  // The bar spans the stretch from the previous turn to this one; without it, the default window.
  const span = legLength > 0 && Number.isFinite(legLength) ? legLength : APPROACH_WINDOW_M;
  if (span <= BAR_FULL_M) return 0;
  const fill = 1 - (distance - BAR_FULL_M) / (span - BAR_FULL_M);
  return Math.max(0, Math.min(steps, Math.floor(fill * steps + 1e-9)));
}

export function cardKey(card: TurnCard | null): string {
  return card ? card.label + "|" + card.steps : "blank";
}

/**
 * A distance for the big digits, calm enough to read while walking: 50 m
 * steps from 200 m, 10 m below, tenths of a kilometre from 1 km, "jetzt" in
 * the last few metres.
 */
export function bigDistance(metres: number, locale: Locale): string {
  if (!Number.isFinite(metres) || metres < 0) return "--";
  if (metres < 15) return t(locale, "g.now");
  if (metres < 200) return `${Math.round(metres / 10) * 10} m`;
  if (metres < 975) return `${Math.round(metres / 50) * 50} m`;
  if (metres >= 9950) return `${Math.min(99, Math.round(metres / 1000))} km`;
  const km = (metres / 1000).toFixed(1);
  return `${locale === "de" ? km.replace(".", ",") : km} km`;
}

/** 5 × 7 pixel glyphs for what the big labels can contain (a few are narrower than 5 columns). */
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
  "9": [".###.", "#...#", "#...#", ".####", "....#", "#...#", ".###."],
  ".": ["..", "..", "..", "..", "..", "##", "##"],
  ",": ["..", "..", "..", "..", "##", ".#", "#."],
  "-": [".....", ".....", ".....", "####.", ".....", ".....", "....."],
  "!": ["###", "###", "###", "###", "###", "...", "###"],
  "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  "m": [".....", ".....", "##.#.", "#.#.#", "#.#.#", "#.#.#", "#.#.#"],
  "k": ["#....", "#....", "#..#.", "#.#..", "##...", "#.#..", "#..#."],
  "n": [".....", ".....", "####.", "#...#", "#...#", "#...#", "#...#"],
  "o": [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
  "w": [".....", ".....", "#...#", "#...#", "#.#.#", "#.#.#", ".#.#."],
  "i": ["#", ".", "#", "#", "#", "#", "#"],
  "h": ["#....", "#....", "#.##.", "##..#", "#...#", "#...#", "#...#"],
  "j": ["...#.", ".....", "..##.", "...#.", "...#.", "#..#.", ".##.."],
  "e": [".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
  "t": [".#...", ".#...", "####.", ".#...", ".#...", ".#..#", "..##."],
  "z": [".....", ".....", "#####", "...#.", "..#..", ".#...", "#####"],
};
export const GLYPH_ROWS = 7;

/** Pixel scale of the distance digits: 5 × 7 glyphs become 50 × 70, and "250 m" still fits 288 px. */
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

/** The largest scale (at most `max`) at which `label` fits `width` and `height`. */
export function fitScale(label: string, width: number, height: number, max: number): number {
  let scale = max;
  while (scale > 1 && (labelWidth(label, scale) > width || GLYPH_ROWS * scale > height)) scale--;
  return scale;
}

/** Draws `label` with its top-left at (x, y); returns the width drawn. */
export function drawLabel(ctx: CardContext, label: string, x: number, y: number, scale: number, color = "#fff"): number {
  ctx.fillStyle = color;
  let at = x;
  for (const char of label) {
    const glyph = GLYPHS[char];
    if (!glyph) { at += SPACE_ADVANCE * scale; continue; }
    glyph.forEach((row, gy) => {
      for (let gx = 0; gx < row.length; gx++) if (row[gx] === "#") ctx.fillRect(at + gx * scale, y + gy * scale, scale, scale);
    });
    at += advanceOf(glyph) * scale;
  }
  return Math.max(0, at - x - scale);
}

/**
 * Black card; white digits centred at the top; the bar below as thick blocks -
 * filled white, empty dim grey so its length can be read before it fills.
 * A null card (no turn to show) stays black.
 */
export function drawTurnCard(ctx: CardContext, card: TurnCard | null, width = CARD_WIDTH, height = CARD_HEIGHT): void {
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
  if (!card) return;

  // Shrink only if a label would not fit ("jetzt" is the widest at full size, by a hair).
  const scale = fitScale(card.label, width, GLYPH_ROWS * DIGIT_SCALE, DIGIT_SCALE);
  const x = Math.max(0, Math.floor((width - labelWidth(card.label, scale)) / 2));
  drawLabel(ctx, card.label, x, DIGIT_TOP + (DIGIT_SCALE - scale) * GLYPH_ROWS / 2, scale);

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

// ---- a big number with a small unit --------------------------------------------

export interface BigNumber {
  /** The digits (or a word such as "jetzt"), drawn as large as the image allows. */
  readonly value: string;
  /** A unit drawn half as large beside it, e.g. "min"; may be empty. */
  readonly unit: string;
  /** White on black, or the other way round (the pulse of a warning). */
  readonly inverted?: boolean;
}

export function numberKey(card: BigNumber | null): string {
  return card ? `${card.value}|${card.unit}|${card.inverted ? "i" : "n"}` : "blank";
}

/** Largest scale at which value and unit side by side fit; the unit is half the size. */
export function fitNumber(card: BigNumber, width: number, height: number, max = 16): number {
  const gap = 2;
  let scale = max;
  while (scale > 1) {
    const unitScale = Math.max(1, Math.floor(scale / 2));
    const total = labelWidth(card.value, scale) + (card.unit ? gap * scale + labelWidth(card.unit, unitScale) : 0);
    if (total <= width && GLYPH_ROWS * scale <= height) break;
    scale--;
  }
  return scale;
}

/**
 * The number centred in the image, the unit on the same baseline. Inverted:
 * a white field with black glyphs, which is what makes a pulse visible.
 */
export function drawBigNumber(ctx: CardContext, card: BigNumber | null, width: number, height: number): void {
  const background = card?.inverted ? "#fff" : "#000";
  ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
  if (!card || !card.value) return;
  const color = card.inverted ? "#000" : "#fff";
  const scale = fitNumber(card, width - 8, height - 8);
  const unitScale = Math.max(1, Math.floor(scale / 2));
  const valueWidth = labelWidth(card.value, scale);
  const gap = card.unit ? 2 * scale : 0;
  const unitWidth = card.unit ? labelWidth(card.unit, unitScale) : 0;
  const left = Math.max(0, Math.floor((width - (valueWidth + gap + unitWidth)) / 2));
  const top = Math.max(0, Math.floor((height - GLYPH_ROWS * scale) / 2));
  drawLabel(ctx, card.value, left, top, scale, color);
  if (card.unit) {
    const baseline = top + GLYPH_ROWS * scale;
    drawLabel(ctx, card.unit, left + valueWidth + gap, baseline - GLYPH_ROWS * unitScale, unitScale, color);
  }
}

export async function renderNumberPng(card: BigNumber | null, width: number, height: number): Promise<Uint8Array> {
  const canvas = createGrayCanvas(width, height);
  drawBigNumber(canvas, card, width, height);
  return encodePng(width, height, canvas.pixels);
}
