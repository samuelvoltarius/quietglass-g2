import { createGrayCanvas, encodePng } from "./png";

/**
 * Words as pictures.
 *
 * The glasses' text has one small fixed size, too small to read at a glance
 * while walking or riding. So the few words that matter - the street name,
 * "noch ... Halte", "Aussteigen" - are drawn as bold type into an image. The
 * WebView of the Even app has a 2d canvas for that; where there is none (the
 * tests, a headless run) the image stays black instead of failing the draw.
 */

export const MIN_FONT_PX = 26;
/** Space kept free at both ends of a line. */
const MARGIN = 10;

export interface WordsOptions {
  /** How far the drawing is shifted left: one line spread over two neighbouring images. */
  readonly offsetX?: number;
  /** Width of the whole line the image is a part of (default: the image itself). */
  readonly fullWidth?: number;
  readonly margin?: number;
}

export interface WordLine {
  readonly text: string;
  /** Largest type size to try, in px; shrinks to fit the width. */
  readonly size: number;
  /** Where the line sits in the image; centred when left out. */
  readonly align?: "left" | "center" | "right";
}

export interface FittedText {
  readonly text: string;
  readonly size: number;
  readonly width: number;
}

/**
 * The biggest type size (in steps of 2 px, down to `min`) at which `text`
 * fits. Text that is still too wide at the smallest size is cut, with an
 * ellipsis, until it fits.
 */
export function fitText(measure: (text: string, size: number) => number, text: string, available: number, max: number, min = MIN_FONT_PX): FittedText {
  for (let size = max; size >= min; size -= 2) {
    const width = measure(text, size);
    if (width <= available) return { text, size, width };
  }
  let cut = text;
  while (cut.length > 1) {
    cut = cut.slice(0, -1);
    const shown = cut.trimEnd() + "…";
    const width = measure(shown, min);
    if (width <= available) return { text: shown, size: min, width };
  }
  return { text: "…", size: min, width: measure("…", min) };
}

const FONT = (size: number): string => `bold ${size}px "Arial Narrow", Arial, Helvetica, sans-serif`;

interface Canvas2D {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
}

function makeCanvas(width: number, height: number): Canvas2D | null {
  const doc = (globalThis as { document?: { createElement?: (tag: string) => unknown } }).document;
  if (!doc || typeof doc.createElement !== "function") return null;
  try {
    const canvas = doc.createElement("canvas") as HTMLCanvasElement;
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    return ctx && typeof canvas.toBlob === "function" ? { canvas, ctx } : null;
  } catch {
    return null;
  }
}

function blackPng(width: number, height: number): Promise<Uint8Array> {
  return encodePng(width, height, createGrayCanvas(width, height).pixels);
}

async function toPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encode failed")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Bold white lines on black, stacked and centred in the image. An empty set
 * of lines gives a black image. `offsetX` shifts the drawing left, which is how
 * one line of text is spread over two neighbouring images (see the street halves).
 */
export async function renderWordsPng(lines: readonly WordLine[], width: number, height: number, options: WordsOptions = {}): Promise<Uint8Array> {
  const { offsetX = 0, fullWidth = width, margin = MARGIN } = options;
  const visible = lines.filter((line) => line.text.trim() !== "");
  const made = visible.length > 0 ? makeCanvas(width, height) : null;
  if (!made) return blackPng(width, height);
  const { canvas, ctx } = made;
  const measure = (text: string, size: number): number => { ctx.font = FONT(size); return ctx.measureText(text).width; };
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.textAlign = "left";

  const fitted = visible.map((line) => fitText(measure, line.text.trim(), fullWidth - 2 * margin, line.size));
  const total = fitted.reduce((sum, line) => sum + line.size * 1.08, 0);
  let y = (height - total) / 2;
  fitted.forEach((line, index) => {
    const step = line.size * 1.08;
    const align = visible[index]?.align;
    const x = align === "left" ? margin : align === "right" ? fullWidth - margin - line.width : (fullWidth - line.width) / 2;
    ctx.font = FONT(line.size);
    ctx.fillText(line.text, x - offsetX, y + step / 2 + 1);
    y += step;
  });
  return toPng(canvas);
}
