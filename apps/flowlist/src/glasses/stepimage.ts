import type { Bitmap } from "./progressbar";

/**
 * The current step as a picture.
 *
 * The glasses' text has one small fixed size. The step is what you act on, so
 * it is drawn big and bold into two image containers of 288 x 96 side by side
 * (together 576 x 96, the full width): the largest type at which the words fit
 * in as many lines as the height allows, wrapped word by word.
 *
 * Layout is a pure function of (text, measure), so it is testable without a
 * canvas. Drawing needs a browser canvas for the type; everything is
 * thresholded to hard white-on-black so it reads like bold pixel type.
 */

export const STEP_WIDTH = 576;
export const STEP_HEIGHT = 96;
export const STEP_HALF = STEP_WIDTH / 2;
export const STEP_Y = 34;
export const STEP_LEFT = { id: 5, name: "step-left", x: 0, y: STEP_Y, width: STEP_HALF, height: STEP_HEIGHT } as const;
export const STEP_RIGHT = { id: 6, name: "step-right", x: STEP_HALF, y: STEP_Y, width: STEP_HALF, height: STEP_HEIGHT } as const;

export const MAX_SIZE = 46;
export const MIN_SIZE = 22;
/** Space kept free at the left and right edge. */
export const MARGIN = 12;
/** Line height as a share of the type size. */
const LEADING = 1.1;

export type Measure = (text: string, size: number) => number;

export interface StepLayout {
  readonly text: string;
  readonly size: number;
  readonly lines: readonly string[];
  /** The words did not fit even at the smallest size; the last line ends in an ellipsis. */
  readonly truncated: boolean;
}

/**
 * Width of bold sans-serif type without a canvas, by character class. Used by
 * the tests and as a fallback; the app measures with the real font.
 */
export function estimateWidth(text: string, size: number): number {
  let em = 0;
  for (const char of text) {
    if (" .,:;!|ilIjt'`".includes(char)) em += 0.32;
    else if ("mwMW@%".includes(char)) em += 0.88;
    else if (/[A-ZÄÖÜ]/.test(char)) em += 0.72;
    else em += 0.6;
  }
  return em * size;
}

export function lineHeight(size: number): number {
  return Math.round(size * LEADING);
}

/** Greedy word wrap by pixel width; a word wider than the line is split by letters. */
export function wrapByWidth(measure: Measure, text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (measure(candidate, size) <= maxWidth) { current = candidate; continue; }
    if (current !== "") lines.push(current);
    current = word;
    while (measure(current, size) > maxWidth && current.length > 1) {
      let cut = current.length - 1;
      while (cut > 1 && measure(current.slice(0, cut), size) > maxWidth) cut -= 1;
      lines.push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** `line` shortened with an ellipsis until it fits. */
function ellipsize(measure: Measure, line: string, size: number, maxWidth: number): string {
  let cut = line;
  while (cut.length > 0 && measure(`${cut.trimEnd()}…`, size) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** The biggest size at which the text fits the box; at the smallest size it is cut with an ellipsis. */
export function layoutStep(
  measure: Measure,
  text: string,
  maxWidth = STEP_WIDTH - 2 * MARGIN,
  height = STEP_HEIGHT,
): StepLayout {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean === "") return { text: "", size: MAX_SIZE, lines: [], truncated: false };
  for (let size = MAX_SIZE; size >= MIN_SIZE; size -= 2) {
    const lines = wrapByWidth(measure, clean, size, maxWidth);
    if (lines.length * lineHeight(size) <= height) return { text: clean, size, lines, truncated: false };
  }
  const rows = Math.max(1, Math.floor(height / lineHeight(MIN_SIZE)));
  const lines = wrapByWidth(measure, clean, MIN_SIZE, maxWidth);
  const kept = lines.slice(0, rows);
  kept[kept.length - 1] = ellipsize(measure, `${kept[kept.length - 1] ?? ""} ${lines[rows] ?? ""}`, MIN_SIZE, maxWidth);
  return { text: clean, size: MIN_SIZE, lines: kept, truncated: true };
}

/** What the glasses must be told: equal keys draw equal pictures. */
export function layoutKey(layout: StepLayout | null): string {
  return layout && layout.lines.length > 0 ? `${layout.size}|${layout.lines.join("\n")}` : "blank";
}

export function sameLayout(a: StepLayout | null, b: StepLayout | null): boolean {
  return layoutKey(a) === layoutKey(b);
}

/** Top-left positions of each line, lines centred as a block vertically, left-aligned at MARGIN. */
export function linePositions(layout: StepLayout, height = STEP_HEIGHT): Array<{ text: string; x: number; y: number }> {
  const lh = lineHeight(layout.size);
  const top = Math.max(0, Math.floor((height - layout.lines.length * lh) / 2));
  return layout.lines.map((text, index) => ({ text, x: MARGIN, y: top + index * lh }));
}

export const STEP_FONT = (size: number): string => `bold ${size}px Arial, Helvetica, sans-serif`;

/** A canvas-based measure for the real type, or the estimate when there is no canvas. */
export function browserMeasure(): Measure {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx || typeof ctx.measureText !== "function") return estimateWidth;
    return (text, size) => { ctx.font = STEP_FONT(size); return ctx.measureText(text).width; };
  } catch {
    return estimateWidth;
  }
}

/**
 * Draws the layout as hard white on black and returns the two halves as
 * grayscale bitmaps (0 / 255) for the left and right container.
 */
export function drawStepHalves(layout: StepLayout | null): [Bitmap, Bitmap] {
  const canvas = document.createElement("canvas"); canvas.width = STEP_WIDTH; canvas.height = STEP_HEIGHT;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("2d canvas unavailable");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, STEP_WIDTH, STEP_HEIGHT);
  if (layout && layout.lines.length > 0) {
    ctx.fillStyle = "#fff"; ctx.textBaseline = "top"; ctx.font = STEP_FONT(layout.size);
    for (const { text, x, y } of linePositions(layout)) ctx.fillText(text, x, y);
  }
  const rgba = ctx.getImageData(0, 0, STEP_WIDTH, STEP_HEIGHT).data;
  const halves: [Uint8Array, Uint8Array] = [new Uint8Array(STEP_HALF * STEP_HEIGHT), new Uint8Array(STEP_HALF * STEP_HEIGHT)];
  for (let y = 0; y < STEP_HEIGHT; y++) {
    for (let x = 0; x < STEP_WIDTH; x++) {
      const at = (y * STEP_WIDTH + x) * 4;
      const lit = ((rgba[at] ?? 0) + (rgba[at + 1] ?? 0) + (rgba[at + 2] ?? 0)) / 3 > 110;
      halves[x < STEP_HALF ? 0 : 1][y * STEP_HALF + (x % STEP_HALF)] = lit ? 255 : 0;
    }
  }
  return [
    { width: STEP_HALF, height: STEP_HEIGHT, pixels: halves[0] },
    { width: STEP_HALF, height: STEP_HEIGHT, pixels: halves[1] },
  ];
}
