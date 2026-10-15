import { blit, createFrame, type Frame } from "../screen/frame";
import { arrow, circle, crosshair, dashedCircle, dashedLine, fillCircle, fillRect, pattern, strokeRect, triangle } from "../screen/draw";
import { drawText, fitFont, fitText, type Font, type TextBackend } from "../screen/text";
import { ICON_PATTERNS } from "../weather/icons";
import type { CockpitCell, CockpitModel } from "./model";

/**
 * The cockpit view: the whole display as one frame, sent as four tiles.
 *
 *   left half (tiles NW + SW)            right half (tiles NE + SE)
 *   ┌──────────────────────────┐ ┌──────────────────────────────┐
 *   │ wind ◎     ▲N            │ │ RAINLENS               14:05 │
 *   │      radar / pictogram   │ │ REGEN IN                     │
 *   │        ┼  (dashed ring)  │ │ ~25 MIN                      │
 *   │                          │ │ TEMP    GEFÜHLT  FEUCHTE     │
 *   │ ━━━━━━━━━━╋- - - - - -   │ │ HIMMEL  WIND     BÖEN        │
 *   │ 14:05 · Salzburg         │ │ REGEN 2 H  WARNUNG           │
 *   └──────────────────────────┘ └──────────────────────────────┘
 *
 * The radar loop changes only the left tiles; the clock only the top right.
 */

export const HALF = 288;
export const MAP_HEIGHT = 218;
/** The user's place on the left half (the radar is centred on it). */
export const CENTER = { x: 144, y: 109 } as const;
const RIGHT_X = HALF + 10;
const RIGHT_END = 576 - 8;
const RIGHT_WIDTH = RIGHT_END - RIGHT_X;
export const GRID = { top: 118, rowHeight: 56, columns: 3 } as const;
export const CELL_WIDTH = Math.floor(RIGHT_WIDTH / GRID.columns);
const LABEL_FONT: Font = { size: 13, weight: 600 };
const VALUE_SIZES = [28, 24, 20, 17, 14, 12] as const;
const HEADLINE_SIZES = [44, 40, 36, 32, 28, 24] as const;
const LOOP = { x: 12, width: 264, y: 230, spanMinutes: 60 } as const;

export const LEVELS = { text: 15, label: 8, dim: 4, grid: 3, ring: 9, loopPast: 10, loopFuture: 5, rain: 7 } as const;

/** Where each cell goes: rows of three columns, a span taking more. */
export function cellBoxes(cells: readonly CockpitCell[]): { cell: CockpitCell; x: number; y: number; width: number; height: number }[] {
  const boxes: { cell: CockpitCell; x: number; y: number; width: number; height: number }[] = [];
  let column = 0; let row = 0;
  for (const cell of cells) {
    const span = Math.min(GRID.columns, Math.max(1, cell.span ?? 1));
    if (column + span > GRID.columns) { column = 0; row += 1; }
    boxes.push({ cell, x: RIGHT_X + column * CELL_WIDTH, y: GRID.top + row * GRID.rowHeight, width: CELL_WIDTH * span, height: GRID.rowHeight });
    column += span;
    if (column >= GRID.columns) { column = 0; row += 1; }
  }
  return boxes;
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
    if (box.cell.alert) strokeRect(frame, box.x - 1, box.y, box.width - 4, box.height - 5, LEVELS.ring);
    drawText(frame, backend, box.cell.label, box.x + 3, box.y + 3, LABEL_FONT, { level: LEVELS.label, maxWidth: box.width - 8 });
    const value = cellValueLayout(backend, box.cell.value, box.width);
    drawText(frame, backend, value.text, box.x + 3, box.y + 19, value.font, { level: LEVELS.text });
  }
}

/** The loop bar: the past hour solid, the next hour dashed with the 15-minute rain above it, a marker on the frame shown. */
function drawLoop(frame: Frame, loop: CockpitModel["loop"]): void {
  const xOf = (minutes: number): number => Math.round(LOOP.x + ((Math.max(-LOOP.spanMinutes, Math.min(LOOP.spanMinutes, minutes)) + LOOP.spanMinutes) / (2 * LOOP.spanMinutes)) * LOOP.width);
  const now = xOf(0);
  fillRect(frame, LOOP.x, LOOP.y, now - LOOP.x, 2, LEVELS.loopPast);
  dashedLine(frame, now, LOOP.y, LOOP.x + LOOP.width, LOOP.y, LEVELS.loopFuture, { dash: 4, gap: 3, thickness: 2 });
  for (const minutes of loop.frames) fillRect(frame, xOf(minutes), LOOP.y - 3, 1, 3, LEVELS.loopPast);
  // Rain of the next hour, one bar per quarter.
  const quarter = (LOOP.width / 2) / 4;
  loop.rain.slice(0, 4).forEach((mm, index) => {
    if (mm < 0.05) return;
    const height = Math.min(12, 2 + Math.round(mm * 8));
    fillRect(frame, now + 2 + index * quarter, LOOP.y - 2 - height, quarter - 3, height, LEVELS.rain);
  });
  fillRect(frame, now, LOOP.y - 5, 1, 10, LEVELS.text);
  const marker = xOf(loop.shown ?? 0);
  triangle(frame, marker, LOOP.y + 8, 4, 0, LEVELS.text);
}

/** North marker on top, the wind arrow in its own little dial at the top left. */
function drawCompass(frame: Frame, model: CockpitModel, backend: TextBackend): void {
  triangle(frame, CENTER.x, 9, 6, 0, LEVELS.text);
  drawText(frame, backend, "N", CENTER.x + 8, 2, { size: 13, weight: 700 }, { level: LEVELS.label, halo: true });
  if (model.windFrom === null) return;
  fillCircle(frame, 24, 24, 20, 0);
  dashedCircle(frame, 24, 24, 19, LEVELS.dim, { dash: 3, gap: 3 });
  // The arrow shows where the wind blows to.
  arrow(frame, 24, 24, 28, (model.windFrom + 180) % 360, LEVELS.text, 2);
}

function drawLeft(frame: Frame, model: CockpitModel, backend: TextBackend): void {
  if (model.map) {
    blit(frame, model.map, 0, 0);
    if (model.ring) {
      dashedCircle(frame, CENTER.x, CENTER.y, model.ring.radius, LEVELS.ring, { dash: 5, gap: 4 });
      const at = Math.SQRT1_2 * model.ring.radius;
      drawText(frame, backend, `${model.ring.km} km`, CENTER.x + at + 4, CENTER.y - at - 16, { size: 13, weight: 700 }, { level: LEVELS.ring, halo: true });
    }
    crosshair(frame, CENTER.x, CENTER.y, LEVELS.text, { arm: 10, gap: 3, halo: true });
  } else {
    // No radar: the current weather as a large pictogram inside a dashed dial.
    const icon = ICON_PATTERNS[model.kind];
    const scale = 9; const size = 12 * scale;
    pattern(frame, icon, CENTER.x - size / 2, CENTER.y - size / 2, scale, LEVELS.text);
    dashedCircle(frame, CENTER.x, CENTER.y, 96, LEVELS.dim, { dash: 5, gap: 5 });
    circle(frame, CENTER.x, CENTER.y, 2, LEVELS.dim);
  }
  drawCompass(frame, model, backend);
  drawLoop(frame, model.loop);
  drawText(frame, backend, model.caption, LOOP.x, 246, { size: 24, weight: 700 }, { level: LEVELS.text, maxWidth: HALF - LOOP.x - 8 });
  // The seam between the halves.
  dashedLine(frame, HALF, 4, HALF, 284, LEVELS.grid, { dash: 2, gap: 4 });
}

export function composeCockpit(model: CockpitModel, backend: TextBackend): Frame {
  const frame = createFrame();
  drawLeft(frame, model, backend);
  drawRight(frame, model, backend);
  return frame;
}
