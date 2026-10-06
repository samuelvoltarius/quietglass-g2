/**
 * The day bar: today's worked time as a gauge that fills from the bottom.
 *
 * It sits where the pixel clock icon used to be (96 x 144 beside the text).
 * Recorded time is a solid fill; the entry still running is striped on top
 * of it and marked by a pointer, so "how much of my day" and "is the clock
 * on" read in one glance without parsing a number.
 *
 * Every image update is a BLE transfer, so the gauge is quantized to
 * five-minute steps: the image changes at most every five minutes while the
 * clock runs, and not at all while it is stopped. The text timer keeps the
 * second-by-second detail through the cheap text path.
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

export const DAY_BAR_WIDTH = 96;
export const DAY_BAR_HEIGHT = 144;
/** One step of the gauge. Smaller steps would mean more image transfers. */
export const STEP_SECONDS = 300;
/** The gauge shows 0 to 10 hours unless a daily target needs more room. */
export const DEFAULT_SCALE_HOURS = 10;

export const OFF = 0;
export const DIM = 0x55;
export const MID = 0x99;
export const FULL = 0xff;

export interface DayBarState {
  /** Five-minute steps already recorded today (closed entries). */
  readonly recordedSteps: number;
  /** Steps added by the entry still running; included in the total. */
  readonly runningSteps: number;
  readonly running: boolean;
  /** Daily target in steps, or null when none is set. */
  readonly targetSteps: number | null;
  /** Hours the full height of the gauge stands for. */
  readonly scaleHours: number;
}

/**
 * Quantizes today's seconds into gauge steps. The total is floored once and
 * the recorded part separately, so the two parts always add up to the total
 * and the running part never jitters between redraws.
 */
export function dayBarState(
  recordedSeconds: number,
  runningSeconds: number,
  running: boolean,
  targetHours: number | null = null,
): DayBarState {
  const recorded = Math.max(0, recordedSeconds);
  const total = recorded + Math.max(0, runningSeconds);
  const totalSteps = Math.floor(total / STEP_SECONDS);
  const recordedSteps = Math.min(totalSteps, Math.floor(recorded / STEP_SECONDS));
  const target = targetHours !== null && Number.isFinite(targetHours) && targetHours > 0 ? targetHours : null;
  return {
    recordedSteps,
    runningSteps: totalSteps - recordedSteps,
    running,
    targetSteps: target === null ? null : Math.round((target * 3600) / STEP_SECONDS),
    // A target near the top would sit on the frame; leave an hour above it.
    scaleHours: target !== null && target > DEFAULT_SCALE_HOURS - 1 ? Math.ceil(target) + 1 : DEFAULT_SCALE_HOURS,
  };
}

/** The image is resent only when this says something visible changed. */
export function sameDayBar(a: DayBarState | null, b: DayBarState): boolean {
  return a !== null &&
    a.recordedSteps === b.recordedSteps &&
    a.runningSteps === b.runningSteps &&
    a.running === b.running &&
    a.targetSteps === b.targetSteps &&
    a.scaleHours === b.scaleHours;
}

// Geometry of the gauge inside the 96 x 144 image.
const BAR_LEFT = 36;
const BAR_WIDTH = 26;
const BAR_TOP = 14;
/** 120 px: at the default 10 h scale one pixel is exactly one five-minute step. */
export const BAR_HEIGHT = 120;
const BAR_BOTTOM = BAR_TOP + BAR_HEIGHT; // exclusive

/** Fill height in pixels for a number of steps, proportional to the scale. */
export function stepsToPixels(steps: number, scaleHours: number): number {
  const scaleSteps = (scaleHours * 3600) / STEP_SECONDS;
  return Math.max(0, Math.min(BAR_HEIGHT, Math.round((steps * BAR_HEIGHT) / scaleSteps)));
}

export function drawDayBar(state: DayBarState): Bitmap {
  const bmp = createBitmap(DAY_BAR_WIDTH, DAY_BAR_HEIGHT);
  const scaleSteps = (state.scaleHours * 3600) / STEP_SECONDS;
  const totalSteps = state.recordedSteps + state.runningSteps;
  const recordedPx = stepsToPixels(state.recordedSteps, state.scaleHours);
  const totalPx = stepsToPixels(totalSteps, state.scaleHours);

  // The same dotted divider the pixel icon had, so the text column keeps its edge.
  for (let y = 4; y < DAY_BAR_HEIGHT; y += 8) fillRect(bmp, DAY_BAR_WIDTH - 2, y, 1, 3, DIM);

  // Frame, one pixel outside the fill area.
  strokeRect(bmp, BAR_LEFT - 1, BAR_TOP - 1, BAR_WIDTH + 2, BAR_HEIGHT + 2, MID);

  // Hour ticks on the left; longer ones at 0, the middle and the top get a label.
  const half = Math.round(state.scaleHours / 2);
  for (let hour = 0; hour <= state.scaleHours; hour++) {
    const y = BAR_BOTTOM - 1 - stepsToPixels(hour * 12, state.scaleHours);
    const major = hour === 0 || hour === half || hour === state.scaleHours;
    fillRect(bmp, BAR_LEFT - (major ? 8 : 5), y, major ? 6 : 3, 1, major ? FULL : MID);
    if (major) drawNumber(bmp, String(hour), BAR_LEFT - 10, y, FULL);
  }

  // Recorded time: solid.
  fillRect(bmp, BAR_LEFT, BAR_BOTTOM - recordedPx, BAR_WIDTH, recordedPx, FULL);
  // The running entry: striped, so it reads as "still counting".
  // It starts with a dim row, so the edge between the two parts stays visible.
  const recordedTop = BAR_BOTTOM - recordedPx;
  for (let y = BAR_BOTTOM - totalPx; y < recordedTop; y++) {
    fillRect(bmp, BAR_LEFT, y, BAR_WIDTH, 1, (recordedTop - 1 - y) % 2 === 0 ? DIM : FULL);
  }

  // Daily target: stubs outside the frame, and a gap or dotted line inside it.
  if (state.targetSteps !== null && state.targetSteps <= scaleSteps) {
    const y = BAR_BOTTOM - 1 - stepsToPixels(state.targetSteps, state.scaleHours);
    fillRect(bmp, BAR_LEFT - 3, y, 2, 2, FULL);
    fillRect(bmp, BAR_LEFT + BAR_WIDTH + 1, y, 3, 2, FULL);
    const reached = totalSteps >= state.targetSteps;
    for (let x = BAR_LEFT; x < BAR_LEFT + BAR_WIDTH; x++) {
      if (reached) setPixel(bmp, x, y, OFF);
      else if (x % 2 === 0) setPixel(bmp, x, y, MID);
    }
  }

  // "Now" pointer to the right of the bar while the clock runs.
  if (state.running) {
    const tip = Math.max(BAR_TOP, BAR_BOTTOM - 1 - totalPx);
    for (let i = 0; i < 6; i++) fillRect(bmp, BAR_LEFT + BAR_WIDTH + 5 + i, tip - i, 1, 2 * i + 1, FULL);
  }

  // More than the scale holds: the bar is full and an arrow points beyond it.
  if (totalSteps > scaleSteps) {
    for (let i = 0; i < 5; i++) fillRect(bmp, BAR_LEFT + BAR_WIDTH / 2 - i, BAR_TOP - 10 + i, 2 * i + 1, 1, FULL);
  }
  return bmp;
}

/**
 * Reads the fill back out of a drawn bitmap, bottom up: the solid recorded
 * part, then the striped running part. Used by the tests and the preview.
 */
export function measureFill(bmp: Bitmap): { solid: number; striped: number } {
  const x = BAR_LEFT + 1;
  let y = BAR_BOTTOM - 1;
  let solid = 0;
  while (y >= BAR_TOP && getPixel(bmp, x, y) === FULL) { solid++; y--; }
  let striped = 0;
  while (y >= BAR_TOP && getPixel(bmp, x, y) !== OFF) { striped++; y--; }
  return { solid, striped };
}

// ---- pixel primitives ----

export function createBitmap(width: number, height: number): Bitmap {
  return { width, height, pixels: new Uint8Array(width * height) };
}

export function setPixel(bmp: Bitmap, x: number, y: number, level: number): void {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
  bmp.pixels[y * bmp.width + x] = level;
}

export function getPixel(bmp: Bitmap, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return OFF;
  return bmp.pixels[y * bmp.width + x] ?? OFF;
}

export function fillRect(bmp: Bitmap, x: number, y: number, w: number, h: number, level: number): void {
  for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) setPixel(bmp, col, row, level);
}

function strokeRect(bmp: Bitmap, x: number, y: number, w: number, h: number, level: number): void {
  fillRect(bmp, x, y, w, 1, level);
  fillRect(bmp, x, y + h - 1, w, 1, level);
  fillRect(bmp, x, y, 1, h, level);
  fillRect(bmp, x + w - 1, y, 1, h, level);
}

/** 3 x 5 digits, drawn at double size: enough for scale labels without a font. */
const DIGITS: Record<string, readonly string[]> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", ".##", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
};

/** Right-aligned at `right`, vertically centred on `centreY`. */
function drawNumber(bmp: Bitmap, text: string, right: number, centreY: number, level: number): void {
  const scale = 2;
  const advance = 4 * scale;
  let x = right - text.length * advance + scale;
  const top = Math.max(0, Math.min(bmp.height - 5 * scale, centreY - Math.floor((5 * scale) / 2)));
  for (const char of text) {
    const glyph = DIGITS[char];
    glyph?.forEach((row, gy) => {
      for (let gx = 0; gx < row.length; gx++) if (row[gx] === "#") fillRect(bmp, x + gx * scale, top + gy * scale, scale, scale, level);
    });
    x += advance;
  }
}
