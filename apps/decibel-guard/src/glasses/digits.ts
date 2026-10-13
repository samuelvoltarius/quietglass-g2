import { createBitmap, drawPattern, MAX_LEVEL, type Bitmap } from "./bitmap";

/**
 * The sound level as big pixel digits ("72 dB"), drawn into an image
 * container. The glasses' text has one small fixed size; a number you want to
 * read at arm's length has to be a picture.
 *
 * 5 x 7 glyphs at scale 8 are 56 px tall (the image is 60). Pure drawing, no
 * canvas, so it is testable in node.
 */

export const LEVEL_IMAGE = { id: 6, name: "level-digits", x: 104, y: 34, width: 288, height: 60 } as const;

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
  "~": [".....", ".....", ".#...", "#.#.#", "...#.", ".....", "....."],
  d: ["....#", "....#", ".####", "#...#", "#...#", "#...#", ".####"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
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

/** The label for a level: "72 dB", "~72 dB" when only estimated, "-- dB" without a reading. */
export function levelLabel(db: number | null, calibrated: boolean): string {
  if (db === null || !Number.isFinite(db)) return "-- dB";
  const value = Math.max(0, Math.min(999, Math.round(db)));
  return `${calibrated ? "" : "~"}${value} dB`;
}

export interface LevelState {
  readonly listening: boolean;
  /** Level in whole dB, or null before audio arrives. */
  readonly db: number | null;
  readonly calibrated: boolean;
}

export function levelKey(state: LevelState): string {
  return state.listening ? `lv:${state.db ?? "-"}:${state.calibrated ? "c" : "e"}` : "lv:idle";
}

/** Draws the label centred on a black image; idle shows "-- dB" dimmed. */
export function drawLevel(state: LevelState): Bitmap {
  const bitmap = createBitmap(LEVEL_IMAGE.width, LEVEL_IMAGE.height);
  const label = state.listening ? levelLabel(state.db, state.calibrated) : "-- dB";
  const scale = fitScale(label, bitmap.width - 8);
  const glyphHeight = 7 * scale;
  const brightness = state.listening ? MAX_LEVEL : 5;
  let x = Math.floor((bitmap.width - textColumns(label) * scale) / 2);
  const y = Math.floor((bitmap.height - glyphHeight) / 2);
  for (const char of label) {
    const glyph = GLYPHS[char];
    if (glyph) drawPattern(bitmap, glyph, x, y, scale, brightness);
    x += advance(char) * scale;
  }
  return bitmap;
}
