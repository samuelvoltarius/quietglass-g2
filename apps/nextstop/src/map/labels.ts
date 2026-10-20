import type { LatLon } from "../route/walk";
import type { PixelPoint, Street } from "./streets";

/**
 * Street names on the walking map.
 *
 * Ported from OpenGlance Nav (apps/openglance-nav/src/overview/labels.ts),
 * adapted to the walk: the text is drawn with the app's own text backend, and
 * the placement is pure and takes the text width as a function, so it can be
 * tested with any font. Labels are plain horizontal plates: the map turns with
 * the walker, the writing never does, so every name stays upright whatever the
 * heading.
 *
 * Which names are shown, in this order, at most {@link MAX_LABELS}: the street
 * of the next turn, the street the walker is on, then the biggest other named
 * streets in view. They never overlap each other, the walker, the target, the
 * scale bar or the north needle, and the ones for the route keep off the route
 * line where there is room.
 */

export const LABEL_CHARS = 16;
export const MAX_LABELS = 6;
export const LABEL_HEIGHT = 16;
export const LABEL_PAD_X = 4;
const MARGIN = 3;

export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export interface PlacedLabel {
  /** Upper-case text as drawn. */
  readonly text: string;
  readonly rect: Rect;
  /** next = the street of the next turn, current = the one walked on, other = further streets in view. */
  readonly rank: "next" | "current" | "other";
}

/** What is written: upper case (ß becomes SS), single spaces. */
export function labelText(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
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
 * A street name made to fit `max` characters: "Straße" becomes "Str." (always),
 * then a few more common abbreviations in turn, only as far as needed; what is
 * still too long is cut and marked with a dot.
 */
export function shortenName(name: string, max = LABEL_CHARS): string {
  const fits = (value: string): boolean => labelText(value).length <= max;
  let out = name.trim().replace(/\s+/g, " ");
  out = out.replace(REPLACEMENTS[0]![0], REPLACEMENTS[0]![1]);
  for (const [pattern, to] of REPLACEMENTS.slice(1)) {
    if (fits(out)) return out;
    out = out.replace(pattern, to);
  }
  if (fits(out)) return out;
  let cut = out;
  while (cut.length > 1 && labelText(cut.trimEnd() + ".").length > max) cut = cut.slice(0, -1);
  return cut.trimEnd() + ".";
}

export const overlaps = (a: Rect, b: Rect, pad = 0): boolean =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

export interface LabelInput {
  readonly width: number;
  readonly height: number;
  readonly toPixel: (point: LatLon) => PixelPoint;
  /** The rest of the walk, from the walker to the end. */
  readonly rest: readonly LatLon[];
  /** Where the next turn is. */
  readonly turn: LatLon | null;
  readonly nextStreet?: string | undefined;
  readonly currentStreet?: string | undefined;
  readonly streets: readonly Street[];
  /** Parts of the picture no label may cover (walker, target, scale bar, north needle). */
  readonly reserved: readonly Rect[];
  /** Width in pixels of a text as it will be drawn. */
  readonly measure: (text: string) => number;
}

/** Samples a pixel polyline every ~`step` px. */
function sample(points: readonly PixelPoint[], step: number): PixelPoint[] {
  const out: PixelPoint[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!; const b = points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!Number.isFinite(length) || length > 5000) continue;
    const n = Math.max(1, Math.ceil(length / step));
    for (let k = 0; k < n; k += 1) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  const last = points[points.length - 1];
  if (last) out.push(last);
  return out;
}

/** The point `distance` px along the pixel polyline from its start; null when it ends first. */
function along(points: readonly PixelPoint[], distance: number): PixelPoint | null {
  let travelled = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!; const b = points[i]!;
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
  const finite = (p: PixelPoint): boolean => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < 3000 && Math.abs(p.y) < 3000;
  const rest = input.rest.map(toPixel).filter(finite);
  const routeSamples = sample(rest, 6);
  const placed: PlacedLabel[] = [];
  const used = new Set<string>();

  const boxFor = (text: string, at: PixelPoint): Rect => {
    const w = Math.round(input.measure(text)) + 2 * LABEL_PAD_X;
    return { x: Math.round(at.x - w / 2), y: Math.round(at.y - LABEL_HEIGHT / 2), w, h: LABEL_HEIGHT };
  };
  const inside = (r: Rect): boolean => r.x >= MARGIN && r.y >= MARGIN && r.x + r.w <= width - MARGIN && r.y + r.h <= height - MARGIN;
  const hitsRoute = (r: Rect, pad: number): boolean =>
    routeSamples.some((p) => p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad);
  const free = (r: Rect): boolean => inside(r) && !input.reserved.some((k) => overlaps(r, k)) && !placed.some((l) => overlaps(r, l.rect, 3));

  /** Beside an anchor: nearest places first, those clear of the route before any free one. */
  const tryAround = (text: string, anchor: PixelPoint, rank: PlacedLabel["rank"]): boolean => {
    const w = input.measure(text) + 2 * LABEL_PAD_X;
    const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]];
    for (const strict of [true, false]) {
      for (const margin of [12, 24, 40, 60]) {
        for (const [ux, uy] of dirs) {
          const rect = boxFor(text, { x: anchor.x + ux * (w / 2 + margin), y: anchor.y + uy * (LABEL_HEIGHT / 2 + margin - 4) });
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
    return text === "" ? null : text;
  };

  // (1) The street of the next turn, beside the road after the turn - or by the turn itself.
  const nextText = textOf(input.nextStreet);
  if (nextText && input.turn && placed.length < MAX_LABELS) {
    const turn = toPixel(input.turn);
    if (finite(turn)) {
      used.add(nextText);
      const anchors = [turn, ...[40, 90].map((d) => {
        // Further along the route than the turn.
        const index = rest.findIndex((p) => Math.hypot(p.x - turn.x, p.y - turn.y) < 3);
        return index >= 0 ? along(rest.slice(index), d) : null;
      })].filter((p): p is PixelPoint => p !== null);
      // The turn's own place first would sit on the target ring at the end; the stretch after it is nicer.
      for (const anchor of [...anchors.slice(1), anchors[0]!]) if (tryAround(nextText, anchor, "next")) break;
    }
  }

  // (2) The street walked on, ahead of the walker along the route.
  const currentText = textOf(input.currentStreet);
  if (currentText && !used.has(currentText) && rest.length >= 2 && placed.length < MAX_LABELS) {
    const anchors = [along(rest, 70), along(rest, 40), rest[0]].filter((p): p is PixelPoint => p !== undefined && p !== null);
    for (const anchor of anchors) {
      if (tryAround(currentText, anchor, "current")) { used.add(currentText); break; }
    }
  }

  // (3) The biggest other named streets in the picture, in the open area ahead.
  const byName = new Map<string, { cls: number; pixels: PixelPoint[][]; length: number; text: string }>();
  for (const street of input.streets) {
    if (!street.name || street.cls === "path") continue;
    const text = textOf(street.name);
    if (!text || used.has(text)) continue;
    const pixels = street.points.map(toPixel);
    if (!pixels.every(finite)) continue;
    let length = 0;
    for (let i = 1; i < pixels.length; i += 1) {
      const a = pixels[i - 1]!; const b = pixels[i]!;
      if ((a.x < 0 && b.x < 0) || (a.x > width && b.x > width) || (a.y < 0 && b.y < 0) || (a.y > height && b.y > height)) continue;
      const cx = (v: number): number => Math.max(MARGIN, Math.min(width - MARGIN, v));
      const cy = (v: number): number => Math.max(MARGIN, Math.min(height - MARGIN, v));
      length += Math.hypot(cx(b.x) - cx(a.x), cy(b.y) - cy(a.y));
    }
    const rank = street.cls === "major" ? 0 : 1;
    const entry = byName.get(text) ?? { cls: rank, pixels: [], length: 0, text };
    entry.cls = Math.min(entry.cls, rank);
    entry.pixels.push(pixels);
    entry.length += length;
    byName.set(text, entry);
  }
  const candidates = [...byName.values()].filter((e) => e.length >= 50)
    .sort((a, b) => a.cls - b.cls || b.length - a.length || (a.text < b.text ? -1 : 1));
  const focus = { x: width / 2, y: height * 0.4 };
  for (const entry of candidates) {
    if (placed.length >= MAX_LABELS) break;
    const spots = entry.pixels.flatMap((line) => sample(line, 12))
      .filter((p) => p.x > MARGIN && p.y > MARGIN && p.x < width - MARGIN && p.y < height - MARGIN)
      .sort((a, b) => Math.hypot(a.x - focus.x, a.y - focus.y) - Math.hypot(b.x - focus.x, b.y - focus.y));
    for (const spot of spots) {
      const rect = boxFor(entry.text, spot);
      if (!free(rect) || hitsRoute(rect, 10)) continue;
      placed.push({ text: entry.text, rect, rank: "other" });
      used.add(entry.text);
      break;
    }
  }
  return placed;
}
