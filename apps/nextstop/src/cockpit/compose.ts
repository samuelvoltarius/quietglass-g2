import { createFrame, tiles, frameKey, type Frame } from "../screen/frame";
import { circle, dashedLine, fillRect, strokeRect } from "../screen/draw";
import { drawText, fitFont, fitText, type Font, type TextBackend } from "../screen/text";
import type { CockpitModel, CockpitRing, Tone } from "./model";
import { modelKey } from "./model";

/**
 * The departures cockpit (QUS v1): the whole display as one frame, sent as
 * four tiles. Same grid as Rain Lens.
 *
 *   left half (tiles NW + SW)           right half (tiles NE + SE)
 *   ┌──────────────────────────┐ ┌──────────────────────────────┐
 *   │   countdown ring: fills  │ │ NEXTSTOP               14:05 │
 *   │   as the bus comes,      │ │ BUS 3 · 4 MIN                │
 *   │   minutes inside         │ │ → SALZBURG HBF               │
 *   │                          │ │ DANACH  STEIG   VERSPÄTUNG   │
 *   │ Alpha Platz              │ │ 9 MIN   2       +2 MIN       │
 *   ├──────────────────────────┴─┴──────────────────────────────┤
 *   │ 1/5 · Tippen = folgen · Wischen = wählen · 2× = zurück    │
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
const CENTER_SIZES = [72, 64, 56, 48, 42, 36, 30] as const;
const DIRECTION_SIZES = [24, 22, 20, 18, 16] as const;
/** The ring's middle. */
export const RING = { x: 144, y: 104, radius: 82 } as const;
const CAPTION_Y = 224;
const RULE_Y = 256;
const HINT_Y = 262;

export const LEVELS = { text: 15, label: 8, dim: 4, grid: 3, ok: 11, strong: 15, faint: 5 } as const;

/** Where each cell goes: rows of three columns. */
export function cellBoxes<T>(cells: readonly T[]): { cell: T; x: number; y: number; width: number; height: number }[] {
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

/** The headline at the biggest size that fits, the direction below it at its own, smaller size. */
export function headlineLayout(backend: TextBackend, headline: string, direction: string): { head: string; headFont: Font; dir: string; dirFont: Font } {
  const headFont = fitFont(backend, headline, { size: HEADLINE_SIZES[0], weight: 800 }, HEADLINE_SIZES, RIGHT_WIDTH);
  const dirFont = fitFont(backend, direction, { size: DIRECTION_SIZES[0], weight: 700 }, DIRECTION_SIZES, RIGHT_WIDTH);
  return {
    head: fitText(backend, headline, headFont, RIGHT_WIDTH), headFont,
    dir: fitText(backend, direction, dirFont, RIGHT_WIDTH), dirFont,
  };
}

/** What the right half, the seam and the hint line need; the departures cockpit and the walking cockpit share it. */
export type ChromeModel = Pick<CockpitModel, "title" | "clock" | "headline" | "direction" | "cells" | "hint">;

function drawRight(frame: Frame, model: ChromeModel, backend: TextBackend): void {
  // Header: app name small and dim, the clock bright.
  drawText(frame, backend, model.title, RIGHT_X, 4, { size: 16, weight: 700 }, { level: LEVELS.label, maxWidth: RIGHT_WIDTH - 70 });
  drawText(frame, backend, model.clock, RIGHT_END, 3, { size: 18, weight: 700 }, { align: "right", level: LEVELS.text });
  dashedLine(frame, RIGHT_X, 27, RIGHT_END, 27, LEVELS.grid, { dash: 3, gap: 3 });

  // The headline: one big line, the direction under it.
  const layout = headlineLayout(backend, model.headline, model.direction);
  const headHeight = Math.round(layout.headFont.size * 0.92);
  const block = headHeight + layout.dirFont.size;
  const top = 32 + Math.max(0, Math.round((GRID.top - 36 - block) / 2));
  drawText(frame, backend, layout.head, RIGHT_X, top, layout.headFont, { level: LEVELS.text });
  drawText(frame, backend, layout.dir, RIGHT_X, top + headHeight + 2, layout.dirFont, { level: LEVELS.label });

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

/** How the ring looks: on time = calm solid, delayed = bright dashes, cancelled = faint dots. */
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

function drawRing(frame: Frame, ring: CockpitRing, backend: TextBackend): void {
  // The track: a faint dashed circle; on top the part that has run down.
  circle(frame, RING.x, RING.y, RING.radius, LEVELS.dim, { dash: 5, gap: 5, thickness: 2 });
  if (ring.progress > 0) arc(frame, RING.x, RING.y, RING.radius, 0, Math.min(ring.progress, 1) * Math.PI * 2, arcStyle(ring.tone));
  const font = fitFont(backend, ring.center, { size: CENTER_SIZES[0], weight: 800 }, CENTER_SIZES, RING.radius * 2 - 40);
  const high = ring.sub === "" ? Math.round(font.size * 0.5) : Math.round(font.size * 0.62);
  drawText(frame, backend, ring.center, RING.x, RING.y - high, font, { align: "center", level: LEVELS.text });
  if (ring.sub !== "") {
    drawText(frame, backend, ring.sub, RING.x, RING.y + Math.round(font.size * 0.36), { size: 16, weight: 700 }, { align: "center", level: LEVELS.label, maxWidth: RING.radius * 2 - 40 });
  }
}

export function composeCockpit(model: CockpitModel, backend: TextBackend): Frame {
  const frame = createFrame();
  drawRing(frame, model.ring, backend);
  drawText(frame, backend, model.caption, 12, CAPTION_Y, { size: 22, weight: 700 }, { level: LEVELS.text, maxWidth: HALF - 20 });
  drawChrome(frame, model, backend);
  return frame;
}

/** The seam between the halves, the right half (head, headline, cells) and the hint line under both. */
export function drawChrome(frame: Frame, model: ChromeModel, backend: TextBackend): void {
  dashedLine(frame, HALF, 4, HALF, RULE_Y - 4, LEVELS.grid, { dash: 2, gap: 4 });
  drawRight(frame, model, backend);
  dashedLine(frame, 8, RULE_Y, 568, RULE_Y, LEVELS.grid, { dash: 3, gap: 3 });
  drawText(frame, backend, model.hint, 12, HINT_Y, { size: 14, weight: 600 }, { level: LEVELS.label, maxWidth: 552 });
}

/** The four tiles of a model with their pixel keys. */
export interface ComposedTiles { readonly tiles: [Frame, Frame, Frame, Frame]; readonly keys: readonly string[] }

let remembered: { key: string; name: string; composed: ComposedTiles } | null = null;

/** The clock tick asks again and again; the same model is drawn once. */
export function composeTiles(model: CockpitModel, backend: TextBackend): ComposedTiles {
  const key = modelKey(model);
  if (remembered && remembered.key === key && remembered.name === backend.name) return remembered.composed;
  const parts = tiles(composeCockpit(model, backend));
  const composed: ComposedTiles = { tiles: parts, keys: parts.map(frameKey) };
  remembered = { key, name: backend.name, composed };
  return composed;
}
