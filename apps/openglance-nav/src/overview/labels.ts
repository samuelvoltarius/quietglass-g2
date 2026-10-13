import type { PixelPoint } from "./project";
import type { Street } from "./streets";
import { MARKER_AT, PLATE } from "./camera";

/**
 * Street names on the map.
 *
 * The glasses' own text is too small and cannot sit on a picture, so the names
 * are drawn into the map image with a pixel font of our own: bold capitals 14 px
 * tall in a black box with a 1 px border. Which names are shown, in this order:
 * the street of the next turn, the street the car is on, then up to three more
 * big streets in view. Labels are always horizontal (the map turns, the writing
 * does not), never overlap each other, and keep clear of the car, the ring on
 * the turn, the destination, the compass and the text plate.
 */

export const LABEL_MAX_CHARS = 16;
export const MAX_EXTRA_LABELS = 3;

/** One glyph is 5 x 7 cells; a cell is drawn 2 px, bold adds 1 px to the right. */
const CELL = 2;
const GLYPH_W = 5, GLYPH_H = 7;
export const CHAR_ADVANCE = 13;
export const TEXT_HEIGHT = GLYPH_H * CELL; // 14 px
const BOX_PAD_X = 6;
export const LABEL_HEIGHT = 26;
/** Text starts this far below the box top; the umlaut dots sit above it. */
const TEXT_TOP = 8;

type Glyph = readonly string[];
const g = (...rows: string[]): Glyph => rows;

const GLYPHS: Readonly<Record<string, Glyph>> = {
  A: g(".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
  B: g("####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."),
  C: g(".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."),
  D: g("####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."),
  E: g("#####", "#....", "#....", "####.", "#....", "#....", "#####"),
  F: g("#####", "#....", "#....", "####.", "#....", "#....", "#...."),
  G: g(".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."),
  H: g("#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
  I: g("#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"),
  J: g("..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."),
  K: g("#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"),
  L: g("#....", "#....", "#....", "#....", "#....", "#....", "#####"),
  M: g("#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"),
  N: g("#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"),
  O: g(".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."),
  P: g("####.", "#...#", "#...#", "####.", "#....", "#....", "#...."),
  Q: g(".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"),
  R: g("####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"),
  S: g(".####", "#....", "#....", ".###.", "....#", "....#", "####."),
  T: g("#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."),
  U: g("#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."),
  V: g("#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."),
  W: g("#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"),
  X: g("#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"),
  Y: g("#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."),
  Z: g("#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"),
  "0": g(".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."),
  "1": g("..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."),
  "2": g(".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"),
  "3": g("####.", "....#", "....#", ".###.", "....#", "....#", "####."),
  "4": g("...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."),
  "5": g("#####", "#....", "####.", "....#", "....#", "#...#", ".###."),
  "6": g(".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."),
  "7": g("#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."),
  "8": g(".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."),
  "9": g(".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."),
  ".": g(".....", ".....", ".....", ".....", ".....", ".##..", ".##.."),
  "-": g(".....", ".....", ".....", "#####", ".....", ".....", "....."),
  ",": g(".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."),
  "/": g("....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."),
  "'": g("..#..", "..#..", ".#...", ".....", ".....", ".....", "....."),
  "&": g(".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"),
  "?": g(".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."),
  " ": g(".....", ".....", ".....", ".....", ".....", ".....", "....."),
};
const ACCENTED = new Set(["Ä", "Ö", "Ü"]);

/** The glyph for an upper-case character and whether it carries umlaut dots; null when the font has none. */
function glyphOf(ch: string): { glyph: Glyph; dots: boolean; known: boolean } {
  if (ACCENTED.has(ch)) return { glyph: GLYPHS[ch === "Ä" ? "A" : ch === "Ö" ? "O" : "U"]!, dots: true, known: true };
  const direct = GLYPHS[ch];
  if (direct) return { glyph: direct, dots: false, known: true };
  // É, Ç, Ñ … : the base letter without its accent is better than a question mark.
  const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const baseGlyph = base.length === 1 ? GLYPHS[base] : undefined;
  if (baseGlyph) return { glyph: baseGlyph, dots: false, known: true };
  return { glyph: GLYPHS["?"]!, dots: false, known: false };
}

/** What is written: upper case, with ß becoming SS. */
export function labelText(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Width in px of the text part of a label. */
export function textWidth(text: string): number {
  return text.length === 0 ? 0 : text.length * CHAR_ADVANCE - (CHAR_ADVANCE - (GLYPH_W * CELL + 1));
}

const REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/([Ss])tra(?:ß|ss)e\b/g, "$1tr."],
  [/\bSankt /g, "St. "],
  [/\bDoktor[- ]/g, "Dr. "],
  [/([Pp])latz\b/g, "$1l."],
  [/\bBundes/g, "B."],
  [/\bLandes/g, "L."],
];

/**
 * A street name made to fit `max` characters: "Straße" becomes "Str.", then
 * a few more common abbreviations in turn, only as far as needed; what is
 * still too long is cut and marked with a dot. Names are returned in their
 * original case.
 */
export function shortenName(name: string, max = LABEL_MAX_CHARS): string {
  const fits = (value: string): boolean => labelText(value).length <= max;
  let out = name.trim().replace(/\s+/g, " ");
  // Straße -> Str. is always done: it is the shortening everybody reads.
  out = out.replace(REPLACEMENTS[0]![0], REPLACEMENTS[0]![1]);
  for (const [pattern, to] of REPLACEMENTS.slice(1)) {
    if (fits(out)) return out;
    out = out.replace(pattern, to);
  }
  if (fits(out)) return out;
  // Cut by upper-case length, since ß becomes SS.
  let cut = out;
  while (cut.length > 1 && labelText(cut.trimEnd() + ".").length > max) cut = cut.slice(0, -1);
  return cut.trimEnd() + ".";
}

export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number; }

export interface PlacedLabel {
  /** Upper-case text as drawn. */
  readonly text: string;
  readonly rect: Rect;
  readonly rank: "next" | "current" | "other";
}

const overlaps = (a: Rect, b: Rect, pad = 0): boolean =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

/** Box of a label whose centre is `at`, or null when the text has nothing the font can draw. */
function boxFor(text: string, at: PixelPoint): Rect {
  const w = textWidth(text) + 2 * BOX_PAD_X;
  return { x: Math.round(at.x - w / 2), y: Math.round(at.y - LABEL_HEIGHT / 2), w, h: LABEL_HEIGHT };
}

export interface LabelInput {
  readonly width: number;
  readonly height: number;
  readonly toPixel: (point: { lat: number; lon: number }) => PixelPoint;
  /** The whole route and where along it the next turn is. */
  readonly route: ReadonlyArray<{ lat: number; lon: number }>;
  readonly nextIndex: number | null;
  readonly nextStreet?: string | undefined;
  readonly currentStreet?: string | undefined;
  readonly streets: readonly Street[];
}

const MARGIN = 3;

/** Parts of the picture no label may cover. */
export function reservedRects(width: number, turn: PixelPoint | null, end: PixelPoint | null): Rect[] {
  const rects: Rect[] = [
    { x: MARKER_AT.x - 40, y: MARKER_AT.y - 46, w: 80, h: 76 }, // car chevron
    { x: 0, y: 0, w: PLATE.width + 4, h: PLATE.height + 4 },
    { x: width - 92, y: 10, w: 92, h: 88 }, // compass and its N
  ];
  if (turn) rects.push({ x: turn.x - 32, y: turn.y - 32, w: 64, h: 64 });
  if (end) rects.push({ x: end.x - 19, y: end.y - 19, w: 38, h: 38 });
  return rects;
}

/** Samples a pixel polyline every ~`step` px. */
function sample(points: readonly PixelPoint[], step: number): PixelPoint[] {
  const out: PixelPoint[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!Number.isFinite(len) || len > 5000) continue;
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  const last = points[points.length - 1];
  if (last) out.push(last);
  return out;
}

const inside = (rect: Rect, width: number, height: number): boolean =>
  rect.x >= MARGIN && rect.y >= MARGIN && rect.x + rect.w <= width - MARGIN && rect.y + rect.h <= height - MARGIN;

/** Walks `distance` px along the pixel polyline from index `from`, forwards or backwards; null when it ends first. */
function walk(points: readonly PixelPoint[], from: number, distance: number, dir: 1 | -1, until = dir > 0 ? points.length - 1 : 0): PixelPoint | null {
  let travelled = 0;
  for (let i = from; i !== until; i += dir) {
    const a = points[i]!, b = points[i + dir]!;
    const step = Math.hypot(b.x - a.x, b.y - a.y);
    if (travelled + step >= distance) {
      const t = step > 0 ? (distance - travelled) / step : 1;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    travelled += step;
  }
  return null;
}

/**
 * Chooses the labels. Pure: the same scene always gives the same labels, so a
 * map that did not change is not sent again.
 */
export function placeLabels(input: LabelInput): PlacedLabel[] {
  const { width, height, toPixel } = input;
  if (!input.route.length) return [];
  const route = input.route.map(toPixel);
  const routeSamples = sample(route.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < 3000 && Math.abs(p.y) < 3000), 6);
  const turnIdx = input.nextIndex !== null && input.nextIndex >= 0 && input.nextIndex < route.length ? input.nextIndex : null;
  const turn = turnIdx !== null ? route[turnIdx]! : null;
  const end = route[route.length - 1] ?? null;
  const reserved = reservedRects(width, turn, end);
  const placed: PlacedLabel[] = [];
  const names = new Set<string>();

  const hitsRoute = (rect: Rect, pad: number): boolean =>
    routeSamples.some((p) => p.x >= rect.x - pad && p.x <= rect.x + rect.w + pad && p.y >= rect.y - pad && p.y <= rect.y + rect.h + pad);
  const free = (rect: Rect): boolean =>
    inside(rect, width, height) && !reserved.some((r) => overlaps(rect, r)) && !placed.some((l) => overlaps(rect, l.rect, 4));

  /** Tries the label beside an anchor: nearest places first, those clear of the route before any free one. */
  const tryAround = (text: string, anchor: PixelPoint, rank: PlacedLabel["rank"]): boolean => {
    const w = textWidth(text) + 2 * BOX_PAD_X;
    const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]];
    for (const strict of [true, false]) {
      for (const margin of [20, 36, 56, 84]) {
        for (const [ux, uy] of dirs) {
          const rect = boxFor(text, { x: anchor.x + ux * (w / 2 + margin), y: anchor.y + uy * (LABEL_HEIGHT / 2 + margin - 6) });
          if (!free(rect)) continue;
          if (strict && hitsRoute(rect, 6)) continue;
          placed.push({ text, rect, rank });
          return true;
        }
      }
    }
    return false;
  };

  const textOf = (name: string | undefined): string | null => {
    if (!name) return null;
    const text = labelText(shortenName(name));
    if (!text) return null;
    const known = [...text].filter((ch) => glyphOf(ch).known).length;
    return known * 2 >= text.length ? text : null;
  };

  // (1) The street of the next turn, beside the road after the turn - or the ring itself.
  const nextText = textOf(input.nextStreet);
  if (nextText && turn && turnIdx !== null) {
    names.add(nextText);
    const anchors = [walk(route, turnIdx, 80, 1), walk(route, turnIdx, 150, 1), turn].filter((p): p is PixelPoint => p !== null);
    for (const anchor of anchors) if (tryAround(nextText, anchor, "next")) break;
  }

  // (2) The street the car is on, ahead of the car on the way to the turn (or behind when the turn is close).
  const currentText = textOf(input.currentStreet);
  if (currentText && !names.has(currentText) && route.length >= 2) {
    let nearest = 0, best = Infinity;
    for (let i = 0; i < route.length; i++) {
      const p = route[i]!;
      const d = Math.hypot(p.x - MARKER_AT.x, p.y - MARKER_AT.y);
      if (d < best) { best = d; nearest = i; }
    }
    const limit = turnIdx !== null && turnIdx > nearest ? turnIdx : route.length - 1;
    const ahead = walk(route, nearest, 96, 1, limit) ?? walk(route, nearest, 60, 1, limit);
    const behind = walk(route, nearest, 70, -1);
    const anchors = [ahead, behind].filter((p): p is PixelPoint => p !== null);
    for (const anchor of anchors) {
      if (tryAround(currentText, anchor, "current")) { names.add(currentText); break; }
    }
  }

  // (3) A few more big streets that run through the picture.
  const byName = new Map<string, { cls: number; pixels: PixelPoint[][]; length: number; text: string }>();
  for (const street of input.streets) {
    if (!street.name || street.cls === "path") continue;
    const text = textOf(street.name);
    if (!text || names.has(text)) continue;
    const pixels = street.points.map(toPixel);
    if (pixels.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) continue;
    let length = 0;
    for (let i = 1; i < pixels.length; i++) {
      const a = pixels[i - 1]!, b = pixels[i]!;
      const ax = Math.max(MARGIN, Math.min(width - MARGIN, a.x)), bx = Math.max(MARGIN, Math.min(width - MARGIN, b.x));
      const ay = Math.max(MARGIN, Math.min(height - MARGIN, a.y)), by = Math.max(MARGIN, Math.min(height - MARGIN, b.y));
      // Only the part inside the picture counts, so a street that merely grazes the edge does not win.
      if ((a.x < 0 && b.x < 0) || (a.x > width && b.x > width) || (a.y < 0 && b.y < 0) || (a.y > height && b.y > height)) continue;
      length += Math.hypot(bx - ax, by - ay);
    }
    const entry = byName.get(text) ?? { cls: street.cls === "major" ? 0 : 1, pixels: [], length: 0, text };
    entry.cls = Math.min(entry.cls, street.cls === "major" ? 0 : 1);
    entry.pixels.push(pixels);
    entry.length += length;
    byName.set(text, entry);
  }
  const candidates = [...byName.values()].filter((e) => e.length >= 60)
    .sort((a, b) => a.cls - b.cls || b.length - a.length || (a.text < b.text ? -1 : 1));
  // Prefer the open area ahead of the car, where the eye goes.
  const focus = { x: width / 2, y: 100 };
  let extras = 0;
  for (const entry of candidates) {
    if (extras >= MAX_EXTRA_LABELS) break;
    const spots = entry.pixels.flatMap((line) => sample(line, 14))
      .filter((p) => p.x > MARGIN && p.y > MARGIN && p.x < width - MARGIN && p.y < height - MARGIN)
      .sort((a, b) => Math.hypot(a.x - focus.x, a.y - focus.y) - Math.hypot(b.x - focus.x, b.y - focus.y));
    for (const spot of spots) {
      const rect = boxFor(entry.text, spot);
      if (!free(rect) || hitsRoute(rect, 14)) continue;
      placed.push({ text: entry.text, rect, rank: "other" });
      extras++;
      break;
    }
  }
  return placed;
}

/** The slice of the canvas API the label drawing needs. */
export interface LabelContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
}

const STYLE: Record<PlacedLabel["rank"], { text: string; border: string }> = {
  next: { text: "#ffffff", border: "#ffffff" },
  current: { text: "#ffffff", border: "#b0b0b0" },
  other: { text: "#d0d0d0", border: "#808080" },
};

/** Draws one text with the pixel font, left edge `x`, top of the capitals `y`. */
export function drawPixelText(ctx: LabelContext, text: string, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  let pen = x;
  for (const ch of text) {
    const { glyph, dots } = glyphOf(ch);
    glyph.forEach((row, gy) => {
      let gx = 0;
      while (gx < GLYPH_W) {
        if (row[gx] !== "#") { gx++; continue; }
        let end = gx;
        while (end < GLYPH_W && row[end] === "#") end++;
        // Bold: one extra pixel to the right of every run.
        ctx.fillRect(pen + gx * CELL, y + gy * CELL, (end - gx) * CELL + 1, CELL);
        gx = end;
      }
    });
    if (dots) {
      ctx.fillRect(pen + 1 * CELL, y - 2 * CELL, CELL + 1, CELL);
      ctx.fillRect(pen + 3 * CELL, y - 2 * CELL, CELL + 1, CELL);
    }
    pen += CHAR_ADVANCE;
  }
}

export function drawLabels(ctx: LabelContext, labels: readonly PlacedLabel[]): void {
  for (const label of [...labels].reverse()) {
    const { x, y, w, h } = label.rect;
    const style = STYLE[label.rank];
    ctx.fillStyle = style.border; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#000"; ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    drawPixelText(ctx, label.text, x + BOX_PAD_X, y + TEXT_TOP, style.text);
  }
}
