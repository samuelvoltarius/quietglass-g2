import { createFrame, type Frame } from "../screen/frame";
import { circle, dashedLine, fillRect, strokeRect } from "../screen/draw";
import { drawText, fitFont, fitText, type Font, type TextBackend } from "../screen/text";
import type { CockpitBar, CockpitCell, CockpitModel, Tone } from "./model";

/**
 * The cockpit view (QUS v1): the whole display as one frame, sent as four
 * tiles. Same grid as Rain Lens.
 *
 *   left half (tiles NW + SW)           right half (tiles NE + SE)
 *   ┌──────────────────────────┐ ┌──────────────────────────────┐
 *   │   ring: one arc per      │ │ STATUS                 14:05 │
 *   │   server, "3/4" inside   │ │ 1 PROBLEM                    │
 *   │   (or CPU/RAM/DISK bars) │ │ OK      WARN     OFFLINE     │
 *   │                          │ │ 2       1        0           │
 *   │ Stand 14:05              │ │ CPU MAX RAM MAX  DISK MAX    │
 *   ├──────────────────────────┴─┴──────────────────────────────┤
 *   │ Tippen = neu laden · Wischen = Server · 2× = zurück       │
 *   └───────────────────────────────────────────────────────────┘
 *
 * The clock changes only the top right tile; nothing else is redrawn unless
 * the state changed.
 */

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

export const LEVELS = { text: 15, label: 8, dim: 4, grid: 3, ok: 11, strong: 15, faint: 5 } as const;

/** Where each cell goes: rows of three columns. */
export function cellBoxes(cells: readonly CockpitCell[]): { cell: CockpitCell; x: number; y: number; width: number; height: number }[] {
  return cells.map((cell, index) => ({
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
  head.lines.forEach((line, index) => drawText(frame, backend, line, RIGHT_X, top + index * lineHeight, head.font, { level: LEVELS.text }));

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

/** How a server's arc looks: fine = calm solid, warning = bright dashes, critical = thick bright, offline = faint dots. */
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

function drawRing(frame: Frame, graphic: Extract<CockpitModel["graphic"], { kind: "ring" }>, backend: TextBackend): void {
  if (graphic.segments.length === 0) circle(frame, RING.x, RING.y, RING.radius, LEVELS.dim, { dash: 5, gap: 5, thickness: 2 });
  ringSegments(graphic.segments.length).forEach((segment, index) => arc(frame, RING.x, RING.y, RING.radius, segment.from, segment.to, arcStyle(graphic.segments[index] ?? "ok")));
  const font = fitFont(backend, graphic.center, { size: CENTER_SIZES[0], weight: 800 }, CENTER_SIZES, RING.radius * 2 - 40);
  drawText(frame, backend, graphic.center, RING.x, RING.y - Math.round(font.size * 0.62), font, { align: "center", level: LEVELS.text });
  drawText(frame, backend, graphic.sub, RING.x, RING.y + Math.round(font.size * 0.36), { size: 16, weight: 700 }, { align: "center", level: LEVELS.label, maxWidth: RING.radius * 2 - 40 });
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

function drawLeft(frame: Frame, model: CockpitModel, backend: TextBackend): void {
  const graphic = model.graphic;
  if (graphic.kind === "ring") drawRing(frame, graphic, backend);
  else graphic.bars.forEach((bar, index) => drawBar(frame, bar, BARS.top + index * BARS.pitch, backend));
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
