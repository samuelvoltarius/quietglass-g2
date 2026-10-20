import { createFrame, type Frame } from "../screen/frame";
import { circle, dashedLine, fillCircle, fillRect, line, strokeRect } from "../screen/draw";
import { drawText, fitFont, fitText, type Font, type TextBackend } from "../screen/text";
import type { BeatGraphic, CockpitModel } from "./model";

/**
 * The cockpit view (QUS v1): the whole display as one frame, sent as four
 * tiles. Same grid as Rain Lens.
 *
 *   left half (tiles NW + SW)           right half (tiles NE + SE)
 *   ┌──────────────────────────┐ ┌──────────────────────────────┐
 *   │ ● ○ ○ ○  beat dots       │ │ CADENCE                14:05 │
 *   │   pendulum               │ │ 100 BPM                      │
 *   │ ──────────────────────── │ │ LÄUFT                        │
 *   │   26  (bar)              │ │ TAKTART  MARKE   HEUTE       │
 *   │ Tonleitern               │ │ ZEIT     BESTE   EINHEITEN   │
 *   ├──────────────────────────┴─┴──────────────────────────────┤
 *   │ Tippen = Pause · Wischen = Tempo · Halten = Takt 1 · 2× = Ende │
 *   └───────────────────────────────────────────────────────────┘
 *
 * What changes with every beat lives in the upper left tile only (dots and
 * pendulum), the bar number in the lower left one, the session minutes in the
 * lower right one: a beat costs one tile, not four.
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
export const CENTER_SIZES = [56, 48, 42, 36, 30, 26] as const;
const CAPTION_Y = 224;
const RULE_Y = 256;
const HINT_Y = 262;

export const LEVELS = { text: 15, label: 8, dim: 4, grid: 3, ok: 11, strong: 15, faint: 5 } as const;

export function cellBoxes<T>(cells: readonly T[]): { cell: T; x: number; y: number; width: number; height: number }[] {
  return cells.map((cell, index) => ({
    cell,
    x: RIGHT_X + (index % GRID.columns) * CELL_WIDTH,
    y: GRID.top + Math.floor(index / GRID.columns) * GRID.rowHeight,
    width: CELL_WIDTH,
    height: GRID.rowHeight,
  }));
}

export function cellValueLayout(backend: TextBackend, value: string, width: number): { text: string; font: Font } {
  const room = width - 8;
  const font = fitFont(backend, value, { size: VALUE_SIZES[0], weight: 700 }, VALUE_SIZES, room);
  return { text: fitText(backend, value, font, room), font };
}

export function headlineLayout(backend: TextBackend, lines: readonly string[]): { lines: string[]; font: Font } {
  const base: Font = { size: HEADLINE_SIZES[0], weight: 800 };
  const sizes = lines.map((line) => fitFont(backend, line, base, HEADLINE_SIZES, RIGHT_WIDTH).size);
  const size = Math.min(...sizes, lines.length > 1 ? 40 : HEADLINE_SIZES[0]);
  const font = { ...base, size };
  return { lines: lines.map((text) => fitText(backend, text, font, RIGHT_WIDTH)), font };
}

function drawRight(frame: Frame, model: CockpitModel, backend: TextBackend): void {
  drawText(frame, backend, model.title, RIGHT_X, 4, { size: 16, weight: 700 }, { level: LEVELS.label, maxWidth: RIGHT_WIDTH - 70 });
  drawText(frame, backend, model.clock, RIGHT_END, 3, { size: 18, weight: 700 }, { align: "right", level: LEVELS.text });
  dashedLine(frame, RIGHT_X, 27, RIGHT_END, 27, LEVELS.grid, { dash: 3, gap: 3 });

  const head = headlineLayout(backend, model.headline);
  const lineHeight = Math.round(head.font.size * 0.92);
  const block = lineHeight * head.lines.length;
  const top = 32 + Math.max(0, Math.round((GRID.top - 36 - block) / 2));
  head.lines.forEach((text, index) => drawText(frame, backend, text, RIGHT_X, top + index * lineHeight, head.font, { level: LEVELS.text }));

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

const ANGLE = Math.PI / 6;
/** The upper left tile is 144 px high; everything that moves per beat stays inside it. */
const PIVOT = { x: HALF / 2, y: 130 };
const ROD = 100;

/** The dots of the bar; with the pendulum small on top, without it big in the middle of the tile. */
export function drawDots(frame: Frame, dots: readonly boolean[], big: boolean): void {
  const radius = big ? 12 : 7;
  const y = big ? 72 : 16;
  const pitch = Math.min(big ? 34 : 28, (HALF - 32) / Math.max(1, dots.length));
  const x0 = HALF / 2 - (pitch * (dots.length - 1)) / 2;
  dots.forEach((lit, index) => {
    const x = Math.round(x0 + index * pitch);
    if (lit) fillCircle(frame, x, y, radius, LEVELS.strong);
    else circle(frame, x, y, radius, LEVELS.label, { thickness: 2 });
  });
}

export function drawPendulum(frame: Frame, swing: number): void {
  fillRect(frame, PIVOT.x - 28, 136, 56, 5, LEVELS.text);
  for (const far of [-1, 1]) {
    const x = PIVOT.x + far * Math.sin(ANGLE) * ROD;
    const y = PIVOT.y - Math.cos(ANGLE) * ROD;
    fillRect(frame, x - 2, y - 2, 5, 5, LEVELS.dim);
  }
  const angle = (swing / 2) * ANGLE;
  const tipX = PIVOT.x + Math.sin(angle) * ROD;
  const tipY = PIVOT.y - Math.cos(angle) * ROD;
  line(frame, PIVOT.x, PIVOT.y, tipX, tipY, LEVELS.text, 3);
  const wx = PIVOT.x + Math.sin(angle) * ROD * 0.62;
  const wy = PIVOT.y - Math.cos(angle) * ROD * 0.62;
  fillRect(frame, wx - 8, wy - 7, 17, 15, LEVELS.text);
  fillRect(frame, PIVOT.x - 4, PIVOT.y - 4, 9, 9, LEVELS.text);
}

function drawLeft(frame: Frame, model: CockpitModel, backend: TextBackend): void {
  const graphic: BeatGraphic = model.graphic;
  drawDots(frame, graphic.dots, graphic.swing === null);
  if (graphic.swing !== null) drawPendulum(frame, graphic.swing);
  // The bar number, in the lower left tile.
  const font = fitFont(backend, graphic.center, { size: CENTER_SIZES[0], weight: 800 }, CENTER_SIZES, HALF - 60);
  drawText(frame, backend, graphic.center, HALF / 2, 152, font, { align: "center", level: LEVELS.text });
  drawText(frame, backend, graphic.sub, HALF / 2, 152 + Math.round(font.size * 0.95), { size: 16, weight: 700 }, { align: "center", level: LEVELS.label });
  drawText(frame, backend, model.caption, 12, CAPTION_Y, { size: 22, weight: 700 }, { level: LEVELS.text, maxWidth: HALF - 20 });
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
