/**
 * The progress bar: one segment per required step, in list order.
 *
 * Done steps are solid, the current step is a bright frame, steps still to
 * come are a dimmer frame, and a critical step carries a small mark above its
 * segment — so "how far am I" and "is something important coming" read in
 * one glance. A list too long for segments becomes one continuous bar with
 * the critical marks at their positions.
 *
 * It changes only when a step is done or undone, never on the clock tick, so
 * the image (a BLE transfer) is sent rarely.
 *
 * Pure and self-contained (no imports): it is unit-tested and also loaded
 * directly by `tools/preview.mjs` to write a PNG preview.
 */

/** A grayscale pixel buffer, one byte per pixel: 0 = off, 255 = full brightness. */
export interface Bitmap {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export type SegmentStatus = "done" | "current" | "open";

export interface ProgressSegment {
  readonly status: SegmentStatus;
  readonly critical: boolean;
}

export interface ProgressBarState {
  readonly segments: readonly ProgressSegment[];
}

/** Image containers take 20-288 x 20-144 px; the bar sits beside the header text. */
export const BAR_IMAGE_WIDTH = 280;
export const BAR_IMAGE_HEIGHT = 24;

export const OFF = 0;
export const DIM = 0x55;
export const MID = 0x99;
export const FULL = 0xff;

/** Rows above the bar that hold the critical marks. */
const MARK_ROWS = 7;
const BAR_TOP = 8;
const BAR_HEIGHT = BAR_IMAGE_HEIGHT - BAR_TOP;
const GAP = 2;
/** Narrower segments than this stop reading as separate steps. */
export const MIN_SEGMENT_WIDTH = 4;

export function sameProgressBar(a: ProgressBarState | null, b: ProgressBarState): boolean {
  return a !== null &&
    a.segments.length === b.segments.length &&
    a.segments.every((s, i) => s.status === b.segments[i]?.status && s.critical === b.segments[i]?.critical);
}

/** Width of each segment, or 0 when the list is too long and the bar is continuous. */
export function segmentWidth(count: number, width = BAR_IMAGE_WIDTH): number {
  if (count <= 0) return 0;
  const each = Math.floor((width - (count - 1) * GAP) / count);
  return each >= MIN_SEGMENT_WIDTH ? each : 0;
}

export function drawProgressBar(state: ProgressBarState): Bitmap {
  const bmp = createBitmap(BAR_IMAGE_WIDTH, BAR_IMAGE_HEIGHT);
  const count = state.segments.length;
  if (count === 0) return bmp;

  const each = segmentWidth(count);
  if (each > 0) {
    // Centred, so a short list does not hug one side.
    const used = count * each + (count - 1) * GAP;
    let x = Math.floor((BAR_IMAGE_WIDTH - used) / 2);
    for (const segment of state.segments) {
      drawSegment(bmp, x, each, segment.status);
      if (segment.critical) drawMark(bmp, x + Math.floor(each / 2));
      x += each + GAP;
    }
    return bmp;
  }

  // Continuous: frame, fill in proportion to the steps done, a tick for "now".
  const done = state.segments.filter((s) => s.status === "done").length;
  strokeRect(bmp, 0, BAR_TOP, BAR_IMAGE_WIDTH, BAR_HEIGHT, MID);
  fillRect(bmp, 1, BAR_TOP + 1, continuousFill(done, count), BAR_HEIGHT - 2, FULL);
  const current = state.segments.findIndex((s) => s.status === "current");
  if (current >= 0) fillRect(bmp, positionOf(current, count), BAR_TOP - 2, 2, BAR_HEIGHT + 2, FULL);
  state.segments.forEach((segment, index) => {
    if (segment.critical) drawMark(bmp, positionOf(index, count));
  });
  return bmp;
}

/** Fill width of the continuous bar: proportional to the steps done. */
export function continuousFill(done: number, count: number): number {
  const inner = BAR_IMAGE_WIDTH - 2;
  return count <= 0 ? 0 : Math.round((Math.max(0, Math.min(done, count)) / count) * inner);
}

/** Centre of step `index` along the continuous bar. */
function positionOf(index: number, count: number): number {
  return 1 + Math.floor(((index + 0.5) / count) * (BAR_IMAGE_WIDTH - 2));
}

function drawSegment(bmp: Bitmap, x: number, width: number, status: SegmentStatus): void {
  if (status === "done") { fillRect(bmp, x, BAR_TOP, width, BAR_HEIGHT, FULL); return; }
  if (status === "current") {
    // A double frame: unmistakably "this one", while still visibly not done.
    strokeRect(bmp, x, BAR_TOP, width, BAR_HEIGHT, FULL);
    if (width > 4) strokeRect(bmp, x + 1, BAR_TOP + 1, width - 2, BAR_HEIGHT - 2, FULL);
    return;
  }
  strokeRect(bmp, x, BAR_TOP, width, BAR_HEIGHT, MID);
}

/** A small downward triangle above the segment: "this step asks twice". */
function drawMark(bmp: Bitmap, centre: number): void {
  for (let row = 0; row < MARK_ROWS - 2; row++) {
    const half = MARK_ROWS - 3 - row;
    fillRect(bmp, centre - half, row + 1, 2 * half + 1, 1, FULL);
  }
}

/** Number of segments drawn solid; used by the tests. */
export function countSolidSegments(bmp: Bitmap, count: number): number {
  const each = segmentWidth(count);
  if (each === 0) return 0;
  const used = count * each + (count - 1) * GAP;
  let x = Math.floor((BAR_IMAGE_WIDTH - used) / 2);
  let solid = 0;
  for (let i = 0; i < count; i++) {
    // The centre of a segment is lit only when it is filled.
    if (getPixel(bmp, x + Math.floor(each / 2), BAR_TOP + Math.floor(BAR_HEIGHT / 2)) === FULL) solid++;
    x += each + GAP;
  }
  return solid;
}

/** Lit width of the continuous bar's middle row; used by the tests. */
export function measureContinuousFill(bmp: Bitmap): number {
  let width = 0;
  for (let x = 1; x < BAR_IMAGE_WIDTH - 1; x++) if (getPixel(bmp, x, BAR_TOP + Math.floor(BAR_HEIGHT / 2)) === FULL) width++;
  return width;
}

// ---- pixel primitives ----

export function createBitmap(width: number, height: number): Bitmap {
  return { width, height, pixels: new Uint8Array(width * height) };
}

export function getPixel(bmp: Bitmap, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return OFF;
  return bmp.pixels[y * bmp.width + x] ?? OFF;
}

export function fillRect(bmp: Bitmap, x: number, y: number, w: number, h: number, level: number): void {
  for (let row = Math.max(0, y); row < Math.min(bmp.height, y + h); row++) {
    for (let col = Math.max(0, x); col < Math.min(bmp.width, x + w); col++) bmp.pixels[row * bmp.width + col] = level;
  }
}

function strokeRect(bmp: Bitmap, x: number, y: number, w: number, h: number, level: number): void {
  fillRect(bmp, x, y, w, 1, level);
  fillRect(bmp, x, y + h - 1, w, 1, level);
  fillRect(bmp, x, y, 1, h, level);
  fillRect(bmp, x + w - 1, y, 1, h, level);
}
