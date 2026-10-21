import { createFrame, type Frame } from "../screen/frame";
import { dashedLine, fillCircle, fillRect, line, strokeRect } from "../screen/draw";
import { drawText, fitFont, fitText, type Font, type TextBackend } from "../screen/text";
import type { CockpitModel, GaugeGraphic } from "./model";

/**
 * The cockpit view (QUS v1): the whole display as one frame, sent as four
 * tiles. Same grid as Rain Lens.
 *
 *   left half (tiles NW + SW)           right half (tiles NE + SE)
 *   ┌──────────────────────────┐ ┌──────────────────────────────┐
 *   │   dial 0° ... 60°        │ │ POSTURE                14:05 │
 *   │   needle, warning band   │ │ AUFRECHT                     │
 *   │ ──────────────────────── │ │ GRENZE  AUFRECHT GENEIGT     │
 *   │   12°  NACH VORNE        │ │ HINWEIS IN GEHALTEN SENSOR   │
 *   │ Gespeichert              │ │                              │
 *   ├──────────────────────────┴─┴──────────────────────────────┤
 *   │ Tippen = neu speichern · Wischen = Menü · 2× = Ende         │
 *   └───────────────────────────────────────────────────────────┘
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

/** The dial: the upper left tile (144 px high). 0° is at the left end of the arc, GAUGE_MAX at the right end. */
export const GAUGE = { x: 144, y: 128, radius: 100 } as const;
export const GAUGE_MAX = 60;

/** The point on the dial for `degrees` at `radius` from the pivot. */
export function gaugePoint(degrees: number, radius: number): [number, number] {
  const share = Math.max(0, Math.min(GAUGE_MAX, degrees)) / GAUGE_MAX;
  const theta = Math.PI - share * Math.PI;
  return [Math.round(GAUGE.x + Math.cos(theta) * radius), Math.round(GAUGE.y - Math.sin(theta) * radius)];
}

/** A stroke along the dial from `from` to `to` degrees. */
function dial(frame: Frame, from: number, to: number, level: number, thickness: number): void {
  const steps = Math.max(2, Math.ceil(((to - from) / GAUGE_MAX) * Math.PI * GAUGE.radius));
  const offset = Math.floor(thickness / 2);
  for (let step = 0; step <= steps; step += 1) {
    const [x, y] = gaugePoint(from + ((to - from) * step) / steps, GAUGE.radius);
    fillRect(frame, x - offset, y - offset, thickness, thickness, level);
  }
}

/** The dial, the warning zone as a thick band, the needle. While upright everything is calm; leaning lights it up. */
export function drawGauge(frame: Frame, graphic: GaugeGraphic): void {
  const warn = Math.max(1, Math.min(GAUGE_MAX - 1, graphic.warnAngle));
  dial(frame, 0, warn, LEVELS.dim, 4);
  dial(frame, warn, GAUGE_MAX, LEVELS.strong, 10);
  // Ticks at 0 and at the warning angle.
  for (const mark of [0, warn]) {
    const [x0, y0] = gaugePoint(mark, GAUGE.radius - 14);
    const [x1, y1] = gaugePoint(mark, GAUGE.radius + 10);
    line(frame, x0, y0, x1, y1, LEVELS.text, 2);
  }
  fillRect(frame, GAUGE.x - 6, GAUGE.y - 6, 13, 13, graphic.alert ? LEVELS.strong : LEVELS.label);
  if (graphic.angle === null) return;
  const [tx, ty] = gaugePoint(graphic.angle, GAUGE.radius - 18);
  line(frame, GAUGE.x, GAUGE.y, tx, ty, graphic.alert ? LEVELS.strong : LEVELS.ok, 4);
  fillCircle(frame, tx, ty, 8, graphic.alert ? LEVELS.strong : LEVELS.ok);
}

function drawLeft(frame: Frame, model: CockpitModel, backend: TextBackend): void {
  drawGauge(frame, model.graphic);
  // The angle as a big number, in the lower left tile.
  const font = fitFont(backend, model.graphic.center, { size: CENTER_SIZES[0], weight: 800 }, CENTER_SIZES, HALF - 60);
  drawText(frame, backend, model.graphic.center, HALF / 2, 152, font, { align: "center", level: model.graphic.alert ? LEVELS.strong : LEVELS.text });
  drawText(frame, backend, model.graphic.sub, HALF / 2, 152 + Math.round(font.size * 0.95), { size: 16, weight: 700 }, { align: "center", level: LEVELS.label, maxWidth: HALF - 24 });
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
