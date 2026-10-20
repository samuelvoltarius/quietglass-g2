import { createFrame, type Frame } from "../screen/frame";
import { circle, dashedLine, fillRect, strokeRect } from "../screen/draw";
import { drawText, fitFont, fitText, type Font, type TextBackend } from "../screen/text";
import type { CockpitCell, CockpitModel, CockpitRing } from "./model";

/**
 * The shift cockpit (QUS v1): the whole display as one frame, sent as four
 * tiles. Same grid as Rain Lens.
 *
 *   left half (tiles NW + SW)           right half (tiles NE + SE)
 *   ┌──────────────────────────┐ ┌──────────────────────────────┐
 *   │   ring: today against    │ │ SHIFT                  14:05 │
 *   │   the daily target,      │ │ NOCH 2:15                    │
 *   │   "62%" inside           │ │ START   ENDE    PAUSE        │
 *   │                          │ │ 08:30   16:50   0:25         │
 *   │ Arbeit                   │ │ HEUTE   WOCHE                │
 *   ├──────────────────────────┴─┴──────────────────────────────┤
 *   │ Tippen = stoppen · 2× = Ende                              │
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

  // The headline: one big line between the header and the grid.
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

/** How the ring's parts look: recorded time is a calm solid arc, the running entry bright dashes, the track faint dots. */
export function arcStyle(part: "recorded" | "running" | "reached" | "track"): ArcStyle {
  switch (part) {
    case "recorded": return { level: LEVELS.ok, thickness: 10, dash: 1, gap: 0 };
    case "running": return { level: LEVELS.strong, thickness: 10, dash: 6, gap: 3 };
    case "reached": return { level: LEVELS.strong, thickness: 12, dash: 1, gap: 0 };
    case "track": return { level: LEVELS.faint, thickness: 2, dash: 2, gap: 4 };
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

const WHOLE = Math.PI * 2;

/** The arcs of the ring in radians: the recorded part, then the running part on top of it. */
export function ringArcs(ring: CockpitRing): { recorded: [number, number] | null; running: [number, number] | null } {
  const recorded = ring.recorded > 0 ? ([0, ring.recorded * WHOLE] as [number, number]) : null;
  const running = ring.total > ring.recorded ? ([ring.recorded * WHOLE, ring.total * WHOLE] as [number, number]) : null;
  return { recorded, running };
}

function drawRing(frame: Frame, ring: CockpitRing, backend: TextBackend): void {
  circle(frame, RING.x, RING.y, RING.radius, LEVELS.faint, { dash: arcStyle("track").dash, gap: arcStyle("track").gap, thickness: arcStyle("track").thickness });
  const arcs = ringArcs(ring);
  const recordedStyle = ring.reached ? arcStyle("reached") : arcStyle("recorded");
  if (arcs.recorded) arc(frame, RING.x, RING.y, RING.radius, arcs.recorded[0], arcs.recorded[1], recordedStyle);
  if (arcs.running) arc(frame, RING.x, RING.y, RING.radius, arcs.running[0], arcs.running[1], ring.reached ? arcStyle("reached") : arcStyle("running"));
  // The target mark at the top: where the ring ends.
  if (ring.hasTarget) fillRect(frame, RING.x - 1, RING.y - RING.radius - 11, 3, 22, LEVELS.text);
  const font = fitFont(backend, ring.center, { size: CENTER_SIZES[0], weight: 800 }, CENTER_SIZES, RING.radius * 2 - 40);
  drawText(frame, backend, ring.center, RING.x, RING.y - Math.round(font.size * 0.62), font, { align: "center", level: LEVELS.text });
  drawText(frame, backend, ring.sub, RING.x, RING.y + Math.round(font.size * 0.36), { size: 16, weight: 700 }, { align: "center", level: LEVELS.label, maxWidth: RING.radius * 2 - 40 });
}

function drawLeft(frame: Frame, model: CockpitModel, backend: TextBackend): void {
  drawRing(frame, model.ring, backend);
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
