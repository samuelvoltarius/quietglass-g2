import type { Bitmap } from "../glasses/bitmap";

/**
 * A 5 x 7 pixel font for place names on the radar map: capitals, German
 * umlauts, digits and a few signs. Glyphs are proportional (empty columns are
 * trimmed), one pixel apart. Names are written in capitals; other accents are
 * dropped (É → E, Ł → L), ß becomes SS.
 */
const RAW: Readonly<Record<string, readonly string[]>> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"], B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."], D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"], F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"], H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["###", ".#.", ".#.", ".#.", ".#.", ".#.", "###"], J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"], L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"], N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."], P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"], R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".###.", "#...#", "#....", ".###.", "....#", "#...#", ".###."], T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."], V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."], X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."], Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "Ä": [".#.#.", ".....", ".###.", "#...#", "#####", "#...#", "#...#"], "Ö": [".#.#.", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
  "Ü": [".#.#.", ".....", "#...#", "#...#", "#...#", "#...#", ".###."],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."], "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"], "3": [".###.", "#...#", "....#", "..##.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."], "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."], "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."], "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  "-": ["...", "...", "...", "###", "...", "...", "..."], ".": ["#"].concat(Array(6).fill("")).reverse(), "'": ["#", "#", ".", ".", ".", ".", "."],
  "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
};

export const GLYPH_HEIGHT = 7;
const SPACE_WIDTH = 3;

interface Glyph { readonly width: number; readonly rows: readonly string[] }
/** Glyphs with their empty columns trimmed. */
const GLYPHS: ReadonlyMap<string, Glyph> = new Map(Object.entries(RAW).map(([char, rows]) => {
  const padded = Array.from({ length: GLYPH_HEIGHT }, (_, row) => rows[row] ?? "");
  const width = Math.max(...padded.map((row) => row.length));
  let first = width; let last = -1;
  for (let column = 0; column < width; column += 1) if (padded.some((row) => row[column] === "#")) { first = Math.min(first, column); last = Math.max(last, column); }
  return [char, { width: last - first + 1, rows: padded.map((row) => row.padEnd(width, ".").slice(first, last + 1)) }];
}));

const SPECIAL: Readonly<Record<string, string>> = { "ß": "SS", "ẞ": "SS", "Ł": "L", "Ø": "O", "Æ": "AE", "Œ": "OE", "Đ": "D", "Ð": "D", "Þ": "TH", "ı": "I", "’": "'" };

/**
 * A name as the font can write it: capitals, umlauts kept, other accents
 * dropped. Null when it holds characters the font does not have.
 */
export function labelText(name: string): string | null {
  const upper = Array.from(name.trim()).map((char) => SPECIAL[char] ?? SPECIAL[char.toUpperCase()] ?? char).join("").toUpperCase();
  const kept = upper.replace(/[ÄÖÜ]/g, (char) => `\u0000${"ÄÖÜ".indexOf(char)}`).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0000(\d)/g, (_, index: string) => "ÄÖÜ"[Number(index)]!);
  if (!kept) return null;
  return Array.from(kept).every((char) => char === " " || GLYPHS.has(char)) ? kept : null;
}

/** Width in pixels of a text written by `labelText`. */
export function labelWidth(text: string): number {
  const chars = Array.from(text);
  return chars.reduce((sum, char) => sum + (char === " " ? SPACE_WIDTH : (GLYPHS.get(char)?.width ?? 0)) + 1, 0) - (chars.length ? 1 : 0);
}

/** Writes `text` (from `labelText`) with its top-left corner at (x, y) into `pixels` of a bitmap-sized buffer. */
export function drawLabel(target: Pick<Bitmap, "width" | "height"> & { pixels: Uint8Array }, text: string, x: number, y: number, level: number): void {
  let cursor = x;
  for (const char of text) {
    if (char === " ") { cursor += SPACE_WIDTH + 1; continue; }
    const glyph = GLYPHS.get(char); if (!glyph) continue;
    glyph.rows.forEach((row, rowIndex) => {
      for (let column = 0; column < glyph.width; column += 1) {
        if (row[column] !== "#") continue;
        const px = cursor + column; const py = y + rowIndex;
        if (px >= 0 && py >= 0 && px < target.width && py < target.height) target.pixels[py * target.width + px] = level;
      }
    });
    cursor += glyph.width + 1;
  }
}
