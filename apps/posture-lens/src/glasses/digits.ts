import { createBitmap, drawPattern, MAX_LEVEL, type Bitmap } from "./bitmap";

/**
 * The head's forward lean as big pixel digits ("18°"), drawn into an image
 * container. The glasses' text has one small fixed size; a number you want to
 * read at a glance has to be a picture.
 *
 * 5 x 7 glyphs at scale 8 are 56 px tall (the image is 60). Pure drawing, no
 * canvas, so it is testable in node.
 */

export const ANGLE_IMAGE = { id: 6, name: "angle-digits", x: 152, y: 128, width: 288, height: 60 } as const;

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
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  "°": ["###", "#.#", "###", "...", "...", "...", "..."],
};

const SPACE = 3;
const MAX_SCALE = 8;

/** Glyph columns a character advances, including the blank column after it. */
function advance(char: string): number {
  const glyph = GLYPHS[char];
  return glyph ? (glyph[0]?.length ?? 5) + 1 : SPACE;
}

export function textColumns(text: string): number {
  let columns = 0;
  for (const char of text) columns += advance(char);
  return Math.max(0, columns - 1);
}

/** The biggest whole scale at which `text` fits `width`. */
export function fitScale(text: string, width: number): number {
  let scale = MAX_SCALE;
  while (scale > 1 && textColumns(text) * scale > width) scale -= 1;
  return scale;
}

/** The label for an angle: "18°", or "--°" without a reading. */
export function angleLabel(deg: number | null): string {
  if (deg === null || !Number.isFinite(deg)) return "--°";
  return `${Math.max(0, Math.min(99, Math.round(deg)))}°`;
}

export interface AngleState {
  /** False draws nothing: good posture costs no attention. */
  readonly show: boolean;
  /** Lean in whole degrees, or null before the first sample. */
  readonly deg: number | null;
  /** Leaning or warned: full brightness; shown-while-upright is dim. */
  readonly alert: boolean;
}

export function angleKey(state: AngleState): string {
  return state.show ? `an:${state.deg ?? "-"}:${state.alert ? 1 : 0}` : "an:off";
}

/** Draws the angle centred on a black image; black stays black when hidden. */
export function drawAngle(state: AngleState): Bitmap {
  const bitmap = createBitmap(ANGLE_IMAGE.width, ANGLE_IMAGE.height);
  if (!state.show) return bitmap;
  const label = angleLabel(state.deg);
  const scale = fitScale(label, bitmap.width - 8);
  const brightness = state.alert ? MAX_LEVEL : 8;
  let x = Math.floor((bitmap.width - textColumns(label) * scale) / 2);
  const y = Math.floor((bitmap.height - 7 * scale) / 2);
  for (const char of label) {
    const glyph = GLYPHS[char];
    if (glyph) drawPattern(bitmap, glyph, x, y, scale, brightness);
    x += advance(char) * scale;
  }
  return bitmap;
}
