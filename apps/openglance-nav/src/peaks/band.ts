import { createGrayCanvas, encodePng, type GrayCanvas } from "../glasses/png";
import { drawPixelText, labelText, shortenName, textWidth, TEXT_HEIGHT } from "../overview/labels";
import { compassPoint, HALF_FOV, relativeBearing, type BandPicks, type PeakSight } from "./peaks";

/**
 * The compass band of the peaks page: the upper half of the display
 * (576 x 144, sent as two 288 x 144 images), facing direction in the middle.
 *
 *  - top: a compass scale (ticks every 10°, the eight compass points written);
 *  - middle: up to three rows of labels, "NAME" over "2522M 12KM", each
 *    joined to its peak by a thin line;
 *  - bottom: a triangle for every peak at its bearing, and at the edges an
 *    arrow with the number of peaks outside the band.
 *
 * Labels never overlap and never leave the picture; a peak whose label finds
 * no room keeps its triangle. Drawn with filled rectangles only (the pixel
 * font of the map labels), so it is byte-for-byte testable in node.
 */

export const BAND_WIDTH = 576;
export const BAND_HEIGHT = 144;
export const BAND_HALF = BAND_WIDTH / 2;
/** Pixels per degree: the band shows ±HALF_FOV across its width. */
export const PX_PER_DEG = BAND_WIDTH / (2 * HALF_FOV);
/** Characters of a name on the band. */
export const BAND_NAME_CHARS = 10;
/** A label: the name (umlaut dots need the 4 px above it) over the details, on a black plate, no border. */
export const LABEL_H = 34;
/** Top of each label row, the row nearest the triangles first; 1 px apart. */
export const ROW_TOPS: readonly number[] = [96, 61, 26];
const LABEL_PAD = 4;
const LABEL_GAP = 6;
const NAME_TOP = 4;
const DETAIL_TOP = NAME_TOP + TEXT_HEIGHT + 2;
/** Triangles: apex and base. */
export const MARKER_TOP = 132;
export const MARKER_BASE = BAND_HEIGHT - 1;
const MARKER_HALF = 7;
/** Labels must stay above this, and the scale's ticks end here. */
export const LABEL_BOTTOM = MARKER_TOP - 2;
export const SCALE_BOTTOM = 24;
/** Top of the "how many outside" numbers at the edges (14 px tall, ends on the last row). */
export const COUNT_TOP = BAND_HEIGHT - TEXT_HEIGHT;

export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number; }

export interface BandLabel {
  readonly rect: Rect;
  readonly name: string;
  readonly detail: string;
  /** x of the peak's triangle the label belongs to. */
  readonly markerX: number;
}

export interface BandLayout {
  readonly markers: readonly number[];
  readonly labels: readonly BandLabel[];
  readonly left: number;
  readonly right: number;
}

/** "12KM", "4,5KM" (de) / "4.5KM", "800M" - short, for the pixel font. */
export function bandDistance(meters: number, locale: "de" | "en"): string {
  if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)}M`;
  if (meters < 10_000) {
    const km = (meters / 1000).toFixed(1);
    return (locale === "de" ? km.replace(".", ",") : km) + "KM";
  }
  return `${Math.round(meters / 1000)}KM`;
}

/** x on the band of a bearing, for the facing direction. */
export function bandX(facing: number, bearing: number): number {
  return BAND_HALF + relativeBearing(facing, bearing) * PX_PER_DEG;
}

function overlaps(a: Rect, b: Rect, gap = LABEL_GAP): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Where everything goes; pure, so the "fits" rules are testable. */
export function layoutBand(picks: BandPicks, facing: number, locale: "de" | "en"): BandLayout {
  const markers: number[] = [];
  const labels: BandLabel[] = [];
  for (const sight of picks.shown) {
    const x = Math.round(Math.max(MARKER_HALF, Math.min(BAND_WIDTH - 1 - MARKER_HALF, bandX(facing, sight.bearing))));
    markers.push(x);
    const label = labelFor(sight, x, locale, labels);
    if (label) labels.push(label);
  }
  return { markers, labels, left: picks.left, right: picks.right };
}

function labelFor(sight: PeakSight, x: number, locale: "de" | "en", placed: readonly BandLabel[]): BandLabel | null {
  const name = labelText(shortenName(sight.peak.name, BAND_NAME_CHARS));
  const detail = `${sight.peak.ele}M ${bandDistance(sight.distance, locale)}`;
  const w = Math.max(textWidth(name), textWidth(detail)) + 2 * LABEL_PAD;
  const left = Math.max(0, Math.min(BAND_WIDTH - w, Math.round(x - w / 2)));
  for (const top of ROW_TOPS) {
    const rect = { x: left, y: top, w, h: LABEL_H };
    if (!placed.some((other) => overlaps(other.rect, rect))) return { rect, name, detail, markerX: x };
  }
  return null;
}

type Ctx = Pick<GrayCanvas, "fillStyle" | "fillRect">;

/** A filled triangle, pointing up (apex at `top`) or sideways. */
function triangleUp(ctx: Ctx, cx: number, top: number, bottom: number, half: number): void {
  const h = bottom - top;
  for (let row = 0; row <= h; row++) {
    const w = Math.round((row / h) * half);
    ctx.fillRect(cx - w, top + row, 2 * w + 1, 1);
  }
}
function triangleSide(ctx: Ctx, tipX: number, cy: number, half: number, length: number, pointsLeft: boolean): void {
  for (let col = 0; col <= length; col++) {
    const h = Math.round((col / length) * half);
    ctx.fillRect(pointsLeft ? tipX + col : tipX - col, cy - h, 1, 2 * h + 1);
  }
}

/** Draws the band for one facing direction. */
export function drawBand(ctx: Ctx, layout: BandLayout, facing: number, locale: "de" | "en"): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, BAND_WIDTH, BAND_HEIGHT);

  // Scale: ticks every 10°, longer every 30°, the compass points written above.
  const first = Math.ceil((facing - HALF_FOV) / 10) * 10;
  for (let deg = first; deg <= facing + HALF_FOV; deg += 10) {
    const x = Math.round(bandX(facing, deg));
    const long = ((deg % 30) + 30) % 30 === 0;
    ctx.fillStyle = long ? "#a0a0a0" : "#606060";
    ctx.fillRect(x, long ? 17 : 20, 1, long ? SCALE_BOTTOM - 17 : SCALE_BOTTOM - 20);
  }
  for (let b = 0; b < 360; b += 45) {
    const rel = relativeBearing(facing, b);
    if (Math.abs(rel) > HALF_FOV) continue;
    const text = compassPoint(b, locale);
    const x = Math.round(bandX(facing, b) - textWidth(text) / 2);
    if (x < 0 || x + textWidth(text) > BAND_WIDTH) continue;
    drawPixelText(ctx, text, x, 2, b === 0 ? "#ffffff" : "#c0c0c0");
  }
  // Facing direction: a bright notch in the middle of the scale.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(BAND_HALF - 1, SCALE_BOTTOM - 2, 3, 4);

  // Leaders from each label down to its triangle, then labels on top.
  ctx.fillStyle = "#505050";
  for (const label of layout.labels) {
    const top = label.rect.y + label.rect.h;
    ctx.fillRect(label.markerX, top, 1, Math.max(0, MARKER_TOP - top));
  }
  for (const label of layout.labels) {
    const { x, y, w, h } = label.rect;
    ctx.fillStyle = "#000"; ctx.fillRect(x, y, w, h);
    drawPixelText(ctx, label.name, x + LABEL_PAD, y + NAME_TOP, "#ffffff");
    drawPixelText(ctx, label.detail, x + LABEL_PAD, y + DETAIL_TOP, "#a8a8a8");
  }
  ctx.fillStyle = "#ffffff";
  for (const x of layout.markers) triangleUp(ctx, x, MARKER_TOP, MARKER_BASE, MARKER_HALF);

  // Peaks outside the band: an arrow and how many.
  // On a black plate, over any triangle at the very edge, so the number stays readable.
  if (layout.left > 0) {
    const text = String(Math.min(999, layout.left));
    ctx.fillStyle = "#000"; ctx.fillRect(0, COUNT_TOP - 1, 16 + textWidth(text), BAND_HEIGHT - COUNT_TOP + 1);
    ctx.fillStyle = "#ffffff";
    triangleSide(ctx, 1, COUNT_TOP + 7, 6, 8, true);
    drawPixelText(ctx, text, 13, COUNT_TOP, "#ffffff");
  }
  if (layout.right > 0) {
    const text = String(Math.min(999, layout.right));
    ctx.fillStyle = "#000"; ctx.fillRect(BAND_WIDTH - 16 - textWidth(text), COUNT_TOP - 1, 16 + textWidth(text), BAND_HEIGHT - COUNT_TOP + 1);
    ctx.fillStyle = "#ffffff";
    triangleSide(ctx, BAND_WIDTH - 2, COUNT_TOP + 7, 6, 8, false);
    drawPixelText(ctx, text, BAND_WIDTH - 14 - textWidth(text), COUNT_TOP, "#ffffff");
  }
}

/** What the band shows, as a key: the images are sent again only when it changes. */
export function bandKey(layout: BandLayout, facing: number): string {
  return JSON.stringify([Math.round(facing), layout.markers, layout.labels.map((l) => [l.rect.x, l.rect.y, l.name, l.detail]), layout.left, layout.right]);
}

/** The band as two PNG halves (left, right), each 288 x 144. */
export async function renderBandPngs(layout: BandLayout, facing: number, locale: "de" | "en"): Promise<[Uint8Array, Uint8Array]> {
  const canvas = createGrayCanvas(BAND_WIDTH, BAND_HEIGHT);
  drawBand(canvas, layout, facing, locale);
  const half = (offset: number): Uint8Array => {
    const out = new Uint8Array(BAND_HALF * BAND_HEIGHT);
    for (let row = 0; row < BAND_HEIGHT; row++) {
      out.set(canvas.pixels.subarray(row * BAND_WIDTH + offset, row * BAND_WIDTH + offset + BAND_HALF), row * BAND_HALF);
    }
    return out;
  };
  return [await encodePng(BAND_HALF, BAND_HEIGHT, half(0)), await encodePng(BAND_HALF, BAND_HEIGHT, half(BAND_HALF))];
}
