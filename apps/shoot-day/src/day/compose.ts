import { createFrame, type Frame } from "../screen/frame";
import { dashedLine, fillCircle, fillRect, circle, line, strokeRect } from "../screen/draw";
import { drawText, fitFont, fitText, type Font, type TextBackend } from "../screen/text";
import type { DayCell, DayModel, DayEntry } from "./model";

/**
 * The day cockpit (QUS v1): the whole display as one frame, sent as four
 * tiles. Same grid as Rain Lens and Status Glass.
 *
 *   left half: day timeline            right half
 *   ┌──────────────────────────┐ ┌─────────────────────────────┐
 *   │ ○ 09:00 Aufbau           │ │ SHOOT DAY             14:05 │
 *   │ ● 12:30 Interview   <--  │ │ 14:30                       │
 *   │ │ 14:30 Außenaufnahme    │ │ AUSSENAUFNAHME              │
 *   │ │ 18:00 Abbau            │ │ SZENE  ORT     KUNDE        │
 *   │ in 25 min                │ │ 3/8    Studio  Muster       │
 *   ├──────────────────────────┴─┴─────────────────────────────┤
 *   │ Tippen = Licht · 2× = zurück                              │
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
const CAPTION_Y = 224;
const RULE_Y = 256;
const HINT_Y = 262;
export const LEVELS = { text: 15, label: 8, dim: 4, grid: 3, ok: 11, strong: 15, faint: 5 } as const;
/** The timeline: a spine at x = SPINE_X, one row every ROW_PITCH px. */
export const TIMELINE = { spineX: 28, textX: 48, top: 22, pitch: 48 } as const;

export function cellBoxes(cells: readonly DayCell[]): { cell: DayCell; x: number; y: number; width: number; height: number }[] {
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
  const sizes = lines.map((text) => fitFont(backend, text, base, HEADLINE_SIZES, RIGHT_WIDTH).size);
  const size = Math.min(...sizes, lines.length > 1 ? 40 : HEADLINE_SIZES[0]);
  const font = { ...base, size };
  return { lines: lines.map((text) => fitText(backend, text, font, RIGHT_WIDTH)), font };
}

function drawRight(frame: Frame, model: DayModel, backend: TextBackend): void {
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

function drawEntry(frame: Frame, entry: DayEntry, y: number, backend: TextBackend): void {
  const cy = y + 12;
  const x = TIMELINE.spineX;
  if (entry.state === "past") fillCircle(frame, x, cy, 5, LEVELS.dim);
  else if (entry.state === "now") fillCircle(frame, x, cy, 6, LEVELS.ok);
  else if (entry.state === "next") { fillCircle(frame, x, cy, 9, LEVELS.strong); fillCircle(frame, x, cy, 4, 0); }
  else circle(frame, x, cy, 5, LEVELS.label);
  const strong = entry.state === "next";
  const level = entry.state === "past" ? LEVELS.dim + 2 : strong ? LEVELS.text : LEVELS.ok;
  drawText(frame, backend, entry.time, TIMELINE.textX, y - 3, { size: strong ? 22 : 18, weight: 700 }, { level });
  const font = fitFont(backend, entry.what, { size: strong ? 18 : 16, weight: 500 }, [18, 16, 14, 12], HALF - TIMELINE.textX - 10);
  drawText(frame, backend, entry.what, TIMELINE.textX, y + 21, font, { level: entry.state === "past" ? LEVELS.dim + 2 : LEVELS.label + 4, maxWidth: HALF - TIMELINE.textX - 10 });
}

function drawLeft(frame: Frame, model: DayModel, backend: TextBackend): void {
  const rows = model.timeline;
  if (rows.length > 0) {
    const bottom = TIMELINE.top + (rows.length - 1) * TIMELINE.pitch + 12;
    line(frame, TIMELINE.spineX, TIMELINE.top + 12 - (model.hiddenBefore > 0 ? 14 : 0), TIMELINE.spineX, bottom + (model.hiddenAfter > 0 ? 14 : 0), LEVELS.dim);
    rows.forEach((entry, index) => drawEntry(frame, entry, TIMELINE.top + index * TIMELINE.pitch, backend));
  } else {
    fillRect(frame, TIMELINE.spineX - 1, TIMELINE.top, 2, 150, LEVELS.grid);
  }
  drawText(frame, backend, model.caption, 12, CAPTION_Y, { size: 22, weight: 700 }, { level: LEVELS.text, maxWidth: HALF - 20 });
  dashedLine(frame, HALF, 4, HALF, RULE_Y - 4, LEVELS.grid, { dash: 2, gap: 4 });
}

export function composeDay(model: DayModel, backend: TextBackend): Frame {
  const frame = createFrame();
  drawLeft(frame, model, backend);
  drawRight(frame, model, backend);
  dashedLine(frame, 8, RULE_Y, 568, RULE_Y, LEVELS.grid, { dash: 3, gap: 3 });
  drawText(frame, backend, model.hint, 12, HINT_Y, { size: 14, weight: 600 }, { level: LEVELS.label, maxWidth: 552 });
  return frame;
}
