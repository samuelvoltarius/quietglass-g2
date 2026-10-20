import { createFrame, type Frame } from "../screen/frame";
import { dashedLine, fillRect, strokeRect } from "../screen/draw";
import { drawText, fitFont, fitText, type Font, type TextBackend } from "../screen/text";
import type { CockpitCell, ShareBar, TalkCockpitModel } from "./model";

/**
 * The summary cockpit (QUS v1): the whole display as one frame, sent as four tiles.
 * Same grid as Rain Lens and Status Glass.
 *
 *   left half (tiles NW + SW)          right half (tiles NE + SE)
 *   ┌─────────────────────────┐ ┌──────────────────────────────┐
 *   │ A      ██████████░░ 60% │ │ GESPRÄCH               14:05 │
 *   │ B      ██████░░░░░░ 40% │ │ 12 MIN                       │
 *   │  (speaker shares)       │ │ SPRECHER  WÖRTER   FRAGEN    │
 *   │                         │ │ 2         312      4         │
 *   │ 13:51 – 14:03           │ │ SPRACHE                      │
 *   ├─────────────────────────┴─┴──────────────────────────────┤
 *   │ Tippen = weiter · Wischen = Text · 2× = Ende             │
 *   └──────────────────────────────────────────────────────────┘
 */

export const HALF = 288;
const RIGHT_X = HALF + 10;
const RIGHT_END = 576 - 8;
const RIGHT_WIDTH = RIGHT_END - RIGHT_X;
export const GRID = { top: 118, rowHeight: 56, columns: 3 } as const;
export const CELL_WIDTH = Math.floor(RIGHT_WIDTH / GRID.columns);
const LABEL_FONT: Font = { size: 13, weight: 600 };
const VALUE_SIZES = [28, 24, 20, 17, 14, 12] as const;
const HEADLINE_SIZES = [56, 48, 44, 40, 36, 32, 28, 24] as const;
const BARS = { left: 16, right: 272, top: 22, pitch: 50, height: 14 } as const;
const CAPTION_Y = 224;
const RULE_Y = 256;
const HINT_Y = 262;

export const LEVELS = { text: 15, label: 8, dim: 4, grid: 3, ok: 11, strong: 15 } as const;

export function cellBoxes(cells: readonly CockpitCell[]): { cell: CockpitCell; x: number; y: number; width: number; height: number }[] {
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
  const size = Math.min(...lines.map((line) => fitFont(backend, line, base, HEADLINE_SIZES, RIGHT_WIDTH).size));
  const font = { ...base, size };
  return { lines: lines.map((line) => fitText(backend, line, font, RIGHT_WIDTH)), font };
}

function drawRight(frame: Frame, model: TalkCockpitModel, backend: TextBackend): void {
  drawText(frame, backend, model.title, RIGHT_X, 4, { size: 16, weight: 700 }, { level: LEVELS.label, maxWidth: RIGHT_WIDTH - 70 });
  drawText(frame, backend, model.clock, RIGHT_END, 3, { size: 18, weight: 700 }, { align: "right", level: LEVELS.text });
  dashedLine(frame, RIGHT_X, 27, RIGHT_END, 27, LEVELS.grid, { dash: 3, gap: 3 });

  const head = headlineLayout(backend, model.headline);
  const lineHeight = Math.round(head.font.size * 0.92);
  const block = lineHeight * head.lines.length;
  const top = 32 + Math.max(0, Math.round((GRID.top - 36 - block) / 2));
  head.lines.forEach((line, index) => drawText(frame, backend, line, RIGHT_X, top + index * lineHeight, head.font, { level: LEVELS.text }));

  const boxes = cellBoxes(model.cells);
  for (const y of new Set(boxes.map((box) => box.y))) dashedLine(frame, RIGHT_X, y - 3, RIGHT_END, y - 3, LEVELS.grid, { dash: 3, gap: 3 });
  for (const box of boxes) {
    if (box.x > RIGHT_X) dashedLine(frame, box.x - 4, box.y + 2, box.x - 4, box.y + box.height - 8, LEVELS.grid, { dash: 2, gap: 3 });
    drawText(frame, backend, box.cell.label, box.x + 3, box.y + 3, LABEL_FONT, { level: LEVELS.label, maxWidth: box.width - 8 });
    const value = cellValueLayout(backend, box.cell.value, box.width);
    drawText(frame, backend, value.text, box.x + 3, box.y + 19, value.font, { level: LEVELS.text });
  }
}

/** One speaker's share: name left, percent right, a track below filled to the share. */
function drawBar(frame: Frame, bar: ShareBar, y: number, backend: TextBackend): void {
  const width = BARS.right - BARS.left;
  drawText(frame, backend, bar.label, BARS.left, y, { size: 15, weight: 700 }, { level: LEVELS.label, maxWidth: 150 });
  drawText(frame, backend, bar.text, BARS.right, y - 6, { size: 26, weight: 800 }, { align: "right", level: LEVELS.text });
  const top = y + 28;
  strokeRect(frame, BARS.left, top, width, BARS.height, LEVELS.dim);
  const inner = Math.round(((width - 4) * Math.max(0, Math.min(100, bar.value))) / 100);
  if (inner > 0) fillRect(frame, BARS.left + 2, top + 2, inner, BARS.height - 4, LEVELS.strong);
}

function drawLeft(frame: Frame, model: TalkCockpitModel, backend: TextBackend): void {
  model.bars.forEach((bar, index) => drawBar(frame, bar, BARS.top + index * BARS.pitch, backend));
  drawText(frame, backend, model.caption, 12, CAPTION_Y, { size: 22, weight: 700 }, { level: LEVELS.text, maxWidth: HALF - 20 });
  dashedLine(frame, HALF, 4, HALF, RULE_Y - 4, LEVELS.grid, { dash: 2, gap: 4 });
}

export function composeCockpit(model: TalkCockpitModel, backend: TextBackend): Frame {
  const frame = createFrame();
  drawLeft(frame, model, backend);
  drawRight(frame, model, backend);
  dashedLine(frame, 8, RULE_Y, 568, RULE_Y, LEVELS.grid, { dash: 3, gap: 3 });
  drawText(frame, backend, model.hint, 12, HINT_Y, { size: 14, weight: 600 }, { level: LEVELS.label, maxWidth: 552 });
  return frame;
}
