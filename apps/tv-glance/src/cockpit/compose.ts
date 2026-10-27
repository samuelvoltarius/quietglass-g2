import { createFrame, type Frame } from "../screen/frame";
import { arrow, circle, dashedLine, fillCircle, fillRect, line, strokeRect, triangle } from "../screen/draw";
import { drawText, fitFont, fitText, type Font, type TextBackend } from "../screen/text";

/**
 * The cockpit view (QUS v1): the whole display as one 576 x 288 frame, sent as
 * four tiles. Same grid as Rain Lens and Status Glass.
 *
 *   left half (tiles NW + SW)           right half (tiles NE + SE)
 *   ┌──────────────────────────┐ ┌──────────────────────────────┐
 *   │ graphic: curve, ring,    │ │ APPNAME                14:05 │
 *   │ bars or gauge            │ │ HEADLINE                     │
 *   │                          │ │ LABEL   LABEL    LABEL       │
 *   │ caption                  │ │ value   value    value       │
 *   ├──────────────────────────┴─┴──────────────────────────────┤
 *   │ one hint line                                             │
 *   └───────────────────────────────────────────────────────────┘
 *
 * This file is generic: the app's own `model.ts` decides WHAT is shown (pure,
 * testable), this file only lays it out. Copied into each app.
 */

export type Tone = "ok" | "warn" | "critical" | "offline";

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  /** Drawn with a frame round it (something is wrong here). */
  readonly alert?: boolean;
}

/** One bar of the left half: a reading against 0..100. */
export interface CockpitBar {
  readonly label: string;
  /** 0..100, or null when there is no reading. */
  readonly value: number | null;
  readonly text: string;
  readonly tone: Tone;
}

export type CockpitGraphic =
  /** A ring of one segment per item; the centre says the count. */
  | { readonly kind: "ring"; readonly segments: readonly Tone[]; readonly center: string; readonly sub: string }
  /** Readings as bars. */
  | { readonly kind: "bars"; readonly bars: readonly CockpitBar[] }
  /** A curve over time. `band` is a dim target range, `arrow` a trend arrow in degrees (0 = up, 90 = right). */
  | {
    readonly kind: "spark";
    readonly points: readonly number[];
    readonly band?: { readonly low: number; readonly high: number };
    readonly arrow?: number;
    readonly top: string;
    readonly bottom: string;
    readonly tone: Tone;
    /** Optional numbers on the chart (all already formatted): the band's two values, the curve's highest and
     *  lowest point, and time marks spread evenly under the curve (they replace `bottom`). */
    readonly labels?: {
      readonly bandLow?: string;
      readonly bandHigh?: string;
      readonly max?: string;
      readonly min?: string;
      readonly ticks?: readonly string[];
    };
  }
  /** A ring filled to `value` (0..1), the centre says what it is. */
  | { readonly kind: "gauge"; readonly value: number | null; readonly center: string; readonly sub: string; readonly tone: Tone }
  /**
   * A TV (TV Glance): the screen shows play, pause, a dot (on, nothing playing), a power sign (off) or a dashed
   * outline (unknown); below it the volume as a bar with its label and value.
   */
  | {
    readonly kind: "tv";
    readonly screen: "playing" | "paused" | "idle" | "off" | "unknown";
    /** 0..100 or null; a muted TV shows an empty, crossed-out bar. */
    readonly volume: number | null;
    readonly muted: boolean;
    readonly volumeLabel: string;
    readonly volumeText: string;
  };

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  /** One or two lines, already upper case. */
  readonly headline: readonly string[];
  /** Rows of three columns, six at most. */
  readonly cells: readonly CockpitCell[];
  readonly graphic: CockpitGraphic;
  /** Left bottom: when the data is from. */
  readonly caption: string;
  /** The one footer line with the gestures. */
  readonly hint: string;
  readonly tone: Tone;
}

/** "HH:MM" of an epoch ms in the phone's time (24 h). */
export function hhmm(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** A key that changes exactly when what the cockpit would draw changes (for tests and callers). */
export function modelKey(model: CockpitModel): string {
  return JSON.stringify([model.clock, model.headline, model.cells, model.graphic, model.caption, model.hint]);
}

export const HALF = 288;
const RIGHT_X = HALF + 10;
const RIGHT_END = 576 - 8;
const RIGHT_WIDTH = RIGHT_END - RIGHT_X;
export const GRID = { top: 118, rowHeight: 56, columns: 3 } as const;
export const CELL_WIDTH = Math.floor(RIGHT_WIDTH / GRID.columns);
const LABEL_FONT: Font = { size: 13, weight: 600 };
const VALUE_SIZES = [28, 24, 20, 17, 14, 12] as const;
const HEADLINE_SIZES = [44, 40, 36, 32, 28, 24] as const;
const CENTER_SIZES = [56, 48, 42, 36, 30, 26] as const;
/** The ring's middle. */
export const RING = { x: 144, y: 104, radius: 82 } as const;
const BARS = { left: 16, right: 272, top: 18, pitch: 66, height: 14 } as const;
const CAPTION_Y = 224;
const RULE_Y = 256;
const HINT_Y = 262;
/** The curve's box in the left half. */
export const SPARK = { left: 14, right: 274, top: 44, bottom: 192 } as const;

export const LEVELS = { text: 15, label: 8, dim: 4, grid: 3, ok: 11, strong: 15, faint: 5 } as const;

/** Where each cell goes: rows of three columns. */
export function cellBoxes(cells: readonly CockpitCell[]): { cell: CockpitCell; x: number; y: number; width: number; height: number }[] {
  return cells.slice(0, 6).map((cell, index) => ({
    cell,
    x: RIGHT_X + (index % GRID.columns) * CELL_WIDTH,
    y: GRID.top + Math.floor(index / GRID.columns) * GRID.rowHeight,
    width: CELL_WIDTH,
    height: GRID.rowHeight,
  }));
}

/** How a cell's value is set: the biggest size that fits, cut with "…" only at the smallest. */
export function cellValueLayout(backend: TextBackend, value: string, width: number): { text: string; font: Font } {
  const room = width - 8;
  const font = fitFont(backend, value, { size: VALUE_SIZES[0], weight: 700 }, VALUE_SIZES, room);
  return { text: fitText(backend, value, font, room), font };
}

/** The headline lines, each at the biggest size that fits; two lines share one size so they read as one. */
export function headlineLayout(backend: TextBackend, lines: readonly string[]): { lines: string[]; font: Font } {
  const base: Font = { size: HEADLINE_SIZES[0], weight: 800 };
  const sizes = lines.map((line) => fitFont(backend, line, base, HEADLINE_SIZES, RIGHT_WIDTH).size);
  const size = Math.min(...sizes, lines.length > 1 ? 40 : HEADLINE_SIZES[0]);
  const font = { ...base, size };
  return { lines: lines.map((line) => fitText(backend, line, font, RIGHT_WIDTH)), font };
}

function drawRight(frame: Frame, model: CockpitModel, backend: TextBackend): void {
  // Header: app name small and dim, the clock bright.
  drawText(frame, backend, model.title, RIGHT_X, 4, { size: 16, weight: 700 }, { level: LEVELS.label, maxWidth: RIGHT_WIDTH - 70 });
  drawText(frame, backend, model.clock, RIGHT_END, 3, { size: 18, weight: 700 }, { align: "right", level: LEVELS.text });
  dashedLine(frame, RIGHT_X, 27, RIGHT_END, 27, LEVELS.grid, { dash: 3, gap: 3 });

  // The headline: one or two big lines between the header and the grid.
  const head = headlineLayout(backend, model.headline);
  const lineHeight = Math.round(head.font.size * 0.92);
  const block = lineHeight * head.lines.length;
  const top = 32 + Math.max(0, Math.round((GRID.top - 36 - block) / 2));
  head.lines.forEach((text, index) => drawText(frame, backend, text, RIGHT_X, top + index * lineHeight, head.font, { level: LEVELS.text }));

  // The grid: small dim label, big value; dashed rules between rows and columns.
  const boxes = cellBoxes(model.cells);
  const rows = new Set(boxes.map((box) => box.y));
  for (const y of rows) dashedLine(frame, RIGHT_X, y - 3, RIGHT_END, y - 3, LEVELS.grid, { dash: 3, gap: 3 });
  for (const box of boxes) {
    if (box.x > RIGHT_X) dashedLine(frame, box.x - 4, box.y + 2, box.x - 4, box.y + box.height - 8, LEVELS.grid, { dash: 2, gap: 3 });
    if (box.cell.alert) strokeRect(frame, box.x - 1, box.y, box.width - 4, box.height - 5, LEVELS.strong);
    drawText(frame, backend, box.cell.label, box.x + 3, box.y + 3, LABEL_FONT, { level: LEVELS.label, maxWidth: box.width - 8 });
    const value = cellValueLayout(backend, box.cell.value, box.width);
    drawText(frame, backend, value.text, box.x + 3, box.y + 19, value.font, { level: LEVELS.text });
  }
}

interface ArcStyle { readonly level: number; readonly thickness: number; readonly dash: number; readonly gap: number }

/** How an arc looks: fine = calm solid, warning = bright dashes, critical = thick bright, offline = faint dots. */
export function arcStyle(tone: Tone): ArcStyle {
  switch (tone) {
    case "ok": return { level: LEVELS.ok, thickness: 8, dash: 1, gap: 0 };
    case "warn": return { level: LEVELS.strong, thickness: 8, dash: 9, gap: 5 };
    case "critical": return { level: LEVELS.strong, thickness: 13, dash: 1, gap: 0 };
    case "offline": return { level: LEVELS.faint, thickness: 3, dash: 2, gap: 5 };
  }
}

/** A stroke along a circle from angle `from` to `to` (radians, 0 = up, clockwise). */
function arc(frame: Frame, cx: number, cy: number, radius: number, from: number, to: number, style: ArcStyle): void {
  const length = (to - from) * radius;
  const steps = Math.max(1, Math.ceil(length));
  const offset = Math.floor(style.thickness / 2);
  for (let step = 0; step <= steps; step += 1) {
    if (style.gap > 0 && step % (style.dash + style.gap) >= style.dash) continue;
    const angle = from + ((to - from) * step) / steps;
    const x = Math.round(cx + Math.sin(angle) * radius); const y = Math.round(cy - Math.cos(angle) * radius);
    fillRect(frame, x - offset, y - offset, style.thickness, style.thickness, style.level);
  }
}

/** The arcs of a ring: `count` equal parts of the circle with a small gap between them. */
export function ringSegments(count: number): { from: number; to: number }[] {
  if (count <= 0) return [];
  const whole = Math.PI * 2;
  if (count === 1) return [{ from: 0, to: whole }];
  const gap = Math.min(0.14, whole / count / 3);
  return Array.from({ length: count }, (_, index) => ({ from: (index * whole) / count + gap / 2, to: ((index + 1) * whole) / count - gap / 2 }));
}

function centerText(frame: Frame, backend: TextBackend, center: string, sub: string): void {
  const font = fitFont(backend, center, { size: CENTER_SIZES[0], weight: 800 }, CENTER_SIZES, RING.radius * 2 - 40);
  drawText(frame, backend, center, RING.x, RING.y - Math.round(font.size * 0.62), font, { align: "center", level: LEVELS.text });
  drawText(frame, backend, sub, RING.x, RING.y + Math.round(font.size * 0.36), { size: 16, weight: 700 }, { align: "center", level: LEVELS.label, maxWidth: RING.radius * 2 - 40 });
}

function drawRing(frame: Frame, graphic: Extract<CockpitGraphic, { kind: "ring" }>, backend: TextBackend): void {
  if (graphic.segments.length === 0) circle(frame, RING.x, RING.y, RING.radius, LEVELS.dim, { dash: 5, gap: 5, thickness: 2 });
  ringSegments(graphic.segments.length).forEach((segment, index) => arc(frame, RING.x, RING.y, RING.radius, segment.from, segment.to, arcStyle(graphic.segments[index] ?? "ok")));
  centerText(frame, backend, graphic.center, graphic.sub);
}

/** A ring: a faint track all round, the filled part from the top clockwise. */
function drawGauge(frame: Frame, graphic: Extract<CockpitGraphic, { kind: "gauge" }>, backend: TextBackend): void {
  circle(frame, RING.x, RING.y, RING.radius, LEVELS.dim, { dash: 3, gap: 4, thickness: 2 });
  if (graphic.value !== null) {
    const style = arcStyle(graphic.tone === "offline" ? "ok" : graphic.tone);
    const end = Math.max(0.02, Math.min(1, graphic.value)) * Math.PI * 2;
    arc(frame, RING.x, RING.y, RING.radius, 0, end, style);
  }
  centerText(frame, backend, graphic.center, graphic.sub);
}

/** One reading as a bar: label and value above, a track below, filled to the value. */
function drawBar(frame: Frame, bar: CockpitBar, y: number, backend: TextBackend): void {
  const width = BARS.right - BARS.left;
  drawText(frame, backend, bar.label, BARS.left, y, { size: 15, weight: 700 }, { level: LEVELS.label });
  drawText(frame, backend, bar.text, BARS.right, y - 6, { size: 28, weight: 800 }, { align: "right", level: bar.tone === "offline" ? LEVELS.label : LEVELS.text });
  const top = y + 32;
  strokeRect(frame, BARS.left, top, width, BARS.height, bar.tone === "critical" ? LEVELS.strong : LEVELS.dim);
  if (bar.value === null) return;
  const inner = Math.round(((width - 4) * bar.value) / 100);
  fillRect(frame, BARS.left + 2, top + 2, inner, BARS.height - 4, bar.tone === "ok" ? LEVELS.ok : LEVELS.strong);
}

/** The pixel position of every point of a curve inside the SPARK box; a flat or single-point curve sits in the middle. */
export function sparkPoints(points: readonly number[], band?: { low: number; high: number }): { x: number; y: number }[] {
  if (points.length === 0) return [];
  const values = band ? [...points, band.low, band.high] : [...points];
  let min = Math.min(...values); let max = Math.max(...values);
  if (max - min < 1e-9) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08; min -= pad; max += pad;
  const width = SPARK.right - SPARK.left; const height = SPARK.bottom - SPARK.top;
  return points.map((value, index) => ({
    x: SPARK.left + (points.length === 1 ? width : Math.round((index * width) / (points.length - 1))),
    y: SPARK.top + Math.round(((max - value) / (max - min)) * height),
  }));
}

function sparkY(value: number, points: readonly number[], band?: { low: number; high: number }): number {
  // The same scale as sparkPoints, for a horizontal reference line.
  const values = band ? [...points, band.low, band.high] : [...points];
  let min = Math.min(...values); let max = Math.max(...values);
  if (max - min < 1e-9) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08; min -= pad; max += pad;
  return SPARK.top + Math.round(((max - value) / (max - min)) * (SPARK.bottom - SPARK.top));
}

function drawSpark(frame: Frame, graphic: Extract<CockpitGraphic, { kind: "spark" }>, backend: TextBackend): void {
  const width = SPARK.right - SPARK.left;
  // Frame lines: a dim floor and ceiling, so an empty curve still reads as a chart.
  dashedLine(frame, SPARK.left, SPARK.bottom + 6, SPARK.right, SPARK.bottom + 6, LEVELS.grid, { dash: 3, gap: 3 });
  if (graphic.band && graphic.points.length > 0) {
    const high = Math.max(SPARK.top, sparkY(graphic.band.high, graphic.points, graphic.band));
    const low = Math.min(SPARK.bottom, sparkY(graphic.band.low, graphic.points, graphic.band));
    dashedLine(frame, SPARK.left, high, SPARK.right, high, LEVELS.dim, { dash: 2, gap: 4 });
    dashedLine(frame, SPARK.left, low, SPARK.right, low, LEVELS.dim, { dash: 2, gap: 4 });
    // The band's values at the left end, just above (high) and below (low) their lines.
    const small = { size: 15, weight: 600 } as const;
    if (graphic.labels?.bandHigh) drawText(frame, backend, graphic.labels.bandHigh, SPARK.left, Math.max(SPARK.top - 2, high - 18), small, { level: LEVELS.label, halo: true });
    if (graphic.labels?.bandLow) drawText(frame, backend, graphic.labels.bandLow, SPARK.left, Math.min(SPARK.bottom - 14, low + 3), small, { level: LEVELS.label, halo: true });
  }
  const at = sparkPoints(graphic.points, graphic.band);
  if (at.length === 0) {
    dashedLine(frame, SPARK.left, (SPARK.top + SPARK.bottom) / 2, SPARK.right, (SPARK.top + SPARK.bottom) / 2, LEVELS.dim, { dash: 5, gap: 5, thickness: 2 });
  } else {
    const level = graphic.tone === "offline" ? LEVELS.label : LEVELS.strong;
    for (let index = 1; index < at.length; index += 1) line(frame, at[index - 1]!.x, at[index - 1]!.y, at[index]!.x, at[index]!.y, level, 2);
    const last = at[at.length - 1]!;
    fillCircle(frame, Math.min(last.x, SPARK.right - 3), last.y, 4, LEVELS.text);
    // Highest and lowest point: a small number right at the point (above the peak, below the dip).
    if (at.length > 2) {
      const values = graphic.points;
      const iMax = values.indexOf(Math.max(...values)); const iMin = values.indexOf(Math.min(...values));
      const mark = (index: number, text: string | undefined, above: boolean): void => {
        if (!text || iMax === iMin) return;
        const p = at[index]!;
        const w = backend.measure(text, { size: 15, weight: 700 });
        const x = Math.max(SPARK.left + 30, Math.min(SPARK.right - w - 22, p.x - Math.round(w / 2)));
        const y = above ? Math.max(SPARK.top - 4, p.y - 20) : Math.min(SPARK.bottom - 12, p.y + 6);
        drawText(frame, backend, text, x, y, { size: 15, weight: 700 }, { level: LEVELS.text, halo: true });
      };
      mark(iMax, graphic.labels?.max, true);
      mark(iMin, graphic.labels?.min, false);
    }
  }
  drawText(frame, backend, graphic.top, SPARK.left, 6, { size: 22, weight: 700 }, { level: LEVELS.label, maxWidth: width - 50 });
  if (graphic.arrow !== undefined) arrow(frame, SPARK.right - 18, 22, 30, graphic.arrow, LEVELS.text, 3);
  const ticks = graphic.labels?.ticks;
  if (ticks && ticks.length > 1) {
    // Time marks evenly under the curve: first left-aligned, last right-aligned, the rest centred.
    ticks.forEach((tick, index) => {
      const x = SPARK.left + Math.round((index * width) / (ticks.length - 1));
      const align = index === 0 ? "left" : index === ticks.length - 1 ? "right" : "center";
      line(frame, x, SPARK.bottom + 3, x, SPARK.bottom + 9, LEVELS.dim, 1);
      drawText(frame, backend, tick, x, SPARK.bottom + 10, { size: 15, weight: 600 }, { level: LEVELS.label, align });
    });
  } else {
    drawText(frame, backend, graphic.bottom, SPARK.left, SPARK.bottom + 10, { size: 15, weight: 600 }, { level: LEVELS.dim, maxWidth: width });
  }
}

/** The TV picture's box in the left half, and the volume bar under it. */
export const TV = { left: 44, right: 244, top: 12, bottom: 122, barTop: 180, barHeight: 16 } as const;

function drawTv(frame: Frame, graphic: Extract<CockpitGraphic, { kind: "tv" }>, backend: TextBackend): void {
  const width = TV.right - TV.left; const height = TV.bottom - TV.top;
  const cx = Math.round((TV.left + TV.right) / 2); const cy = Math.round((TV.top + TV.bottom) / 2);
  const dark = graphic.screen === "off" || graphic.screen === "unknown";
  if (graphic.screen === "unknown") {
    const dash = { dash: 4, gap: 4, thickness: 3 };
    dashedLine(frame, TV.left, TV.top, TV.right, TV.top, LEVELS.dim, dash);
    dashedLine(frame, TV.left, TV.bottom, TV.right, TV.bottom, LEVELS.dim, dash);
    dashedLine(frame, TV.left, TV.top, TV.left, TV.bottom, LEVELS.dim, dash);
    dashedLine(frame, TV.right, TV.top, TV.right, TV.bottom, LEVELS.dim, dash);
  } else {
    strokeRect(frame, TV.left, TV.top, width, height, dark ? LEVELS.label : LEVELS.strong, 4);
  }
  // The stand.
  fillRect(frame, cx - 6, TV.bottom + 2, 12, 9, dark ? LEVELS.dim : LEVELS.label);
  fillRect(frame, cx - 40, TV.bottom + 11, 80, 4, dark ? LEVELS.dim : LEVELS.label);
  switch (graphic.screen) {
    case "playing":
      triangle(frame, cx + 4, cy, 26, 90, LEVELS.text);
      break;
    case "paused":
      fillRect(frame, cx - 20, cy - 24, 14, 48, LEVELS.text);
      fillRect(frame, cx + 6, cy - 24, 14, 48, LEVELS.text);
      break;
    case "idle":
      fillCircle(frame, cx, cy, 9, LEVELS.ok);
      break;
    case "off":
      // The power sign: an open ring with a bar through the gap.
      circle(frame, cx, cy + 4, 22, LEVELS.label, { thickness: 4 });
      fillRect(frame, cx - 9, cy - 24, 18, 14, 0);
      fillRect(frame, cx - 2, cy - 26, 5, 28, LEVELS.label);
      break;
    case "unknown":
      break;
  }
  // The volume: label left, value right, a track with the fill below.
  drawText(frame, backend, graphic.volumeLabel, BARS.left, TV.barTop - 26, { size: 15, weight: 700 }, { level: LEVELS.label, maxWidth: 150 });
  drawText(frame, backend, graphic.volumeText, BARS.right, TV.barTop - 34, { size: 28, weight: 800 }, { align: "right", level: graphic.volume === null ? LEVELS.label : LEVELS.text });
  const track = BARS.right - BARS.left;
  strokeRect(frame, BARS.left, TV.barTop, track, TV.barHeight, LEVELS.dim);
  if (graphic.volume !== null && !graphic.muted) {
    const inner = Math.round(((track - 4) * Math.max(0, Math.min(100, graphic.volume))) / 100);
    fillRect(frame, BARS.left + 2, TV.barTop + 2, inner, TV.barHeight - 4, LEVELS.ok);
  }
  if (graphic.muted) {
    const mid = TV.barTop + Math.floor(TV.barHeight / 2);
    dashedLine(frame, BARS.left + 4, mid, BARS.right - 4, mid, LEVELS.label, { dash: 3, gap: 4, thickness: 2 });
  }
}

function drawLeft(frame: Frame, model: CockpitModel, backend: TextBackend): void {
  const graphic = model.graphic;
  switch (graphic.kind) {
    case "ring": drawRing(frame, graphic, backend); break;
    case "gauge": drawGauge(frame, graphic, backend); break;
    case "spark": drawSpark(frame, graphic, backend); break;
    case "bars": graphic.bars.forEach((bar, index) => drawBar(frame, bar, BARS.top + index * BARS.pitch, backend)); break;
    case "tv": drawTv(frame, graphic, backend); break;
  }
  drawText(frame, backend, model.caption, 12, CAPTION_Y, { size: 22, weight: 700 }, { level: LEVELS.text, maxWidth: HALF - 20 });
  // The seam between the halves.
  dashedLine(frame, HALF, 4, HALF, RULE_Y - 4, LEVELS.grid, { dash: 2, gap: 4 });
}

export function composeCockpit(model: CockpitModel, backend: TextBackend): Frame {
  const frame = createFrame();
  drawLeft(frame, model, backend);
  drawRight(frame, model, backend);
  dashedLine(frame, 8, RULE_Y, 568, RULE_Y, LEVELS.grid, { dash: 3, gap: 3 });
  drawText(frame, backend, model.hint, 12, HINT_Y, { size: 14, weight: 600 }, { level: LEVELS.label, maxWidth: 552 });
  return frame;
}
