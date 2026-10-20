import type { Frame } from "./frame";
import { GLYPH_HEIGHT, GLYPH_WIDTH, GLYPHS, pixelChars } from "./pixel-font";

/**
 * Full-screen kit, part 3: text with real proportional fonts.
 *
 * Meant to be copied into other Quietglass G2 apps. The glasses' own text
 * containers have one small font; for a big headline or a grid of values the
 * text is drawn into the frame instead. In the Even app's WebView that is the
 * system's bold sans via a 2d canvas (`fillText`, then the alpha channel is
 * read back and turned into grey levels). The backend is injected, so vitest
 * (node, no canvas) uses the 5 x 7 pixel font and every layout decision -
 * which size fits, where the ellipsis goes, alignment - stays testable.
 *
 * Coordinates: `y` is the top of a line box `font.size` pixels high; the
 * baseline sits at `BASELINE` of it, the same for every backend, so mixed
 * sizes line up and the fallback lands where the real font would.
 */

export interface Font {
  /** Line box height in pixels (roughly the CSS font size). */
  readonly size: number;
  /** CSS weight; 700 = bold. */
  readonly weight?: number;
  readonly family?: string;
}

/** One rendered run of text: coverage 0…255 per pixel. */
export interface Glyphs {
  readonly width: number;
  readonly height: number;
  /** Row of the baseline inside the box. */
  readonly baseline: number;
  /** Columns of empty padding left of the text's origin. */
  readonly left: number;
  readonly alpha: Uint8Array;
}

export interface TextBackend {
  readonly name: string;
  /** Advance width of `text` in pixels. */
  measure(text: string, font: Font): number;
  render(text: string, font: Font): Glyphs;
}

export type Align = "left" | "center" | "right";

export interface TextOptions {
  /** Where `x` is: the left edge (default), the centre or the right edge of the text. */
  readonly align?: Align;
  /** Longer text is cut with "…" to fit. */
  readonly maxWidth?: number;
  /** Grey level of fully covered pixels (default 15). */
  readonly level?: number;
  /** A black border one pixel round the ink, for text over a map or radar. */
  readonly halo?: boolean;
}

export const BASELINE = 0.82;
export const ELLIPSIS = "…";
export const DEFAULT_FAMILY = "-apple-system, \"SF Pro Display\", \"Helvetica Neue\", Roboto, Arial, sans-serif";

/** `text` as long as it fits into `maxWidth`, cut with an ellipsis otherwise ("" when not even that fits). */
export function fitText(backend: TextBackend, text: string, font: Font, maxWidth: number): string {
  if (backend.measure(text, font) <= maxWidth) return text;
  const chars = Array.from(text);
  // Binary search for the longest prefix that fits together with the ellipsis.
  let low = 0; let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (backend.measure(chars.slice(0, mid).join("").trimEnd() + ELLIPSIS, font) <= maxWidth) low = mid; else high = mid - 1;
  }
  if (low === 0) return backend.measure(ELLIPSIS, font) <= maxWidth ? ELLIPSIS : "";
  return chars.slice(0, low).join("").trimEnd() + ELLIPSIS;
}

/** The biggest of `sizes` (in the given order, biggest first) at which `text` fits `maxWidth`; else the last one. */
export function fitFont(backend: TextBackend, text: string, font: Font, sizes: readonly number[], maxWidth: number): Font {
  for (const size of sizes) if (backend.measure(text, { ...font, size }) <= maxWidth) return { ...font, size };
  return { ...font, size: sizes[sizes.length - 1] ?? font.size };
}

export interface DrawnText { readonly text: string; readonly x: number; readonly width: number; }

/** Draws one line of text; returns what was drawn (after fitting) and where. */
export function drawText(frame: Frame, backend: TextBackend, text: string, x: number, y: number, font: Font, options: TextOptions = {}): DrawnText {
  const shown = options.maxWidth === undefined ? text : fitText(backend, text, font, options.maxWidth);
  if (!shown) return { text: "", x, width: 0 };
  const width = backend.measure(shown, font);
  const align = options.align ?? "left";
  const left = Math.round(align === "left" ? x : align === "right" ? x - width : x - width / 2);
  const glyphs = backend.render(shown, font);
  const top = Math.round(y + font.size * BASELINE) - glyphs.baseline;
  const originX = left - glyphs.left;
  const level = options.level ?? 15;
  const ink = (column: number, row: number): number => glyphs.alpha[row * glyphs.width + column] ?? 0;
  if (options.halo) {
    for (let row = -1; row <= glyphs.height; row += 1) for (let column = -1; column <= glyphs.width; column += 1) {
      if (ink(column, row) > 0 && column >= 0 && row >= 0 && column < glyphs.width && row < glyphs.height) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const cx = column + dx; const cy = row + dy;
        if (cx >= 0 && cy >= 0 && cx < glyphs.width && cy < glyphs.height && ink(cx, cy) > 64) { near = true; break; }
      }
      if (near) setPixel(frame, originX + column, top + row, 0);
    }
  }
  for (let row = 0; row < glyphs.height; row += 1) for (let column = 0; column < glyphs.width; column += 1) {
    const alpha = ink(column, row);
    if (alpha === 0) continue;
    const value = Math.round((level * alpha) / 255);
    const px = originX + column; const py = top + row;
    if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue;
    const at = py * frame.width + px;
    // Ink never darkens: anti-aliased edges blend into what is below by taking the brighter.
    if (value > frame.pixels[at]!) frame.pixels[at] = value;
  }
  return { text: shown, x: left, width };
}

function setPixel(frame: Frame, x: number, y: number, level: number): void {
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return;
  frame.pixels[y * frame.width + x] = level;
}

// ---- pixel backend (fallback) ----------------------------------------------

/** Scale of the 5 x 7 font for a line box: capitals about 72 % of the size, like a real sans. */
export const pixelScale = (font: Font): number => Math.max(1, Math.round((font.size * 0.72) / GLYPH_HEIGHT));

/** The 5 x 7 pixel font scaled to the line box: deterministic, needs nothing but this file. */
export function pixelBackend(): TextBackend {
  return {
    name: "pixel",
    measure(text, font) {
      const count = pixelChars(text).length; const scale = pixelScale(font);
      return count === 0 ? 0 : count * (GLYPH_WIDTH + 1) * scale - scale;
    },
    render(text, font) {
      const chars = pixelChars(text); const scale = pixelScale(font);
      const width = Math.max(1, chars.length * (GLYPH_WIDTH + 1) * scale - scale); const height = GLYPH_HEIGHT * scale;
      const alpha = new Uint8Array(width * height);
      chars.forEach((char, index) => {
        const glyph = GLYPHS[char]; if (!glyph) return;
        glyph.forEach((row, gy) => { for (let gx = 0; gx < GLYPH_WIDTH; gx += 1) if (row[gx] === "#") {
          for (let sy = 0; sy < scale; sy += 1) alpha.fill(255, (gy * scale + sy) * width + index * (GLYPH_WIDTH + 1) * scale + gx * scale, (gy * scale + sy) * width + index * (GLYPH_WIDTH + 1) * scale + (gx + 1) * scale);
        } });
      });
      return { width, height, baseline: height, left: 0, alpha };
    },
  };
}

// ---- canvas backend (the real fonts) ----------------------------------------

interface Context2D {
  font: string; fillStyle: string; textBaseline: string;
  measureText(text: string): { width: number };
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}
interface CanvasLike { width: number; height: number; getContext(kind: "2d", options?: { willReadFrequently?: boolean }): unknown; }

export const cssFont = (font: Font): string => `${font.weight ?? 700} ${font.size}px ${font.family ?? DEFAULT_FAMILY}`;

function makeCanvas(): CanvasLike | null {
  try {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(8, 8) as unknown as CanvasLike;
    if (typeof document !== "undefined" && typeof document.createElement === "function") return document.createElement("canvas") as unknown as CanvasLike;
  } catch { /* no canvas */ }
  return null;
}

/**
 * Text through a 2d canvas. Returns null when there is no usable canvas, so
 * the caller can fall back. Rendered runs are cached (the cockpit redraws the
 * same labels every loop step).
 */
export function canvasBackend(canvas: CanvasLike | null = makeCanvas(), cacheSize = 256): TextBackend | null {
  if (!canvas) return null;
  let ctx: Context2D | null = null;
  try { ctx = canvas.getContext("2d", { willReadFrequently: true }) as Context2D | null; } catch { ctx = null; }
  if (!ctx || typeof ctx.measureText !== "function" || typeof ctx.fillText !== "function" || typeof ctx.getImageData !== "function") return null;
  const c = ctx;
  try { c.font = cssFont({ size: 20 }); if (!(c.measureText("M").width > 0)) return null; } catch { return null; }
  const cache = new Map<string, Glyphs>();
  const measure = (text: string, font: Font): number => { c.font = cssFont(font); return Math.ceil(c.measureText(text).width); };
  return {
    name: "canvas",
    measure,
    render(text, font) {
      const key = `${cssFont(font)}|${text}`;
      const hit = cache.get(key);
      if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
      const pad = 2;
      const width = Math.max(1, measure(text, font) + pad * 2); const height = Math.ceil(font.size * 1.3); const baseline = Math.ceil(font.size * 1.0);
      if (canvas.width < width) canvas.width = width;
      if (canvas.height < height) canvas.height = height;
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.font = cssFont(font); c.fillStyle = "#fff"; c.textBaseline = "alphabetic";
      c.fillText(text, pad, baseline);
      const data = c.getImageData(0, 0, width, height).data;
      const alpha = new Uint8Array(width * height);
      // A slight gamma lift: thin anti-aliased strokes stay visible on the 16-level display.
      for (let at = 0; at < alpha.length; at += 1) { const a = data[at * 4 + 3]!; alpha[at] = a === 0 ? 0 : Math.min(255, Math.round(255 * (a / 255) ** 0.75)); }
      const glyphs: Glyphs = { width, height, baseline, left: pad, alpha };
      cache.set(key, glyphs);
      if (cache.size > cacheSize) cache.delete(cache.keys().next().value as string);
      return glyphs;
    },
  };
}

/** The canvas backend when it works here, otherwise the pixel font. */
export function autoBackend(): TextBackend {
  return canvasBackend() ?? pixelBackend();
}
