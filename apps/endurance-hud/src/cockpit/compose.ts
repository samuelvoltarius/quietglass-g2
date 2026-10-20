import { createFrame, type Frame } from "../screen/frame";
import { dashedLine, fillRect, strokeRect } from "../screen/draw";
import { drawText, fitFont, fitText, type Font, type TextBackend } from "../screen/text";
import type { CockpitModel, RingGraphic } from "./model";

/**
 * The cockpit view (QUS v1): the whole display as one frame, sent as four
 * tiles. Same grid as Rain Lens.
 *
 *   left half (tiles NW + SW)           right half (tiles NE + SE)
 *   ┌──────────────────────────┐ ┌──────────────────────────────┐
 *   │  ring of five zones      │ │ ENDURANCE HUD          14:05 │
 *   │  pulse in the middle     │ │ 31.4 KM/H                    │
 *   │ LEISTUNG       KADENZ    │ │ SPORT   ZEIT    DISTANZ      │
 *   │ 238 W          91 RPM    │ │ Ø TEMPO ZONE    PULS MAX     │
 *   │ RAD · LIVE               │ │                              │
 *   ├──────────────────────────┴─┴──────────────────────────────┤
 *   │ Tippen = neu · Wischen = Sport · 2× = Ende                  │
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

/** The ring of the five zones: the NW tile. */
export const RING = { x: 144, y: 72, radius: 60 } as const;

interface ArcStyle { readonly level: number; readonly thickness: number; readonly dash: number; readonly gap: number }

/** How a zone's arc looks: below the heart rate's zone calm solid, the zone itself thick and bright, above it faint dots. */
export function zoneArcStyle(index: number, zone: number): ArcStyle {
  if (zone === 0 || index + 1 > zone) return { level: LEVELS.faint, thickness: 3, dash: 2, gap: 5 };
  if (index + 1 === zone) return { level: LEVELS.strong, thickness: 12, dash: 1, gap: 0 };
  return { level: LEVELS.ok, thickness: 7, dash: 1, gap: 0 };
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

function drawRing(frame: Frame, graphic: RingGraphic, backend: TextBackend): void {
  ringSegments(5).forEach((segment, index) => arc(frame, RING.x, RING.y, RING.radius, segment.from, segment.to, zoneArcStyle(index, graphic.zone)));
  const font = fitFont(backend, graphic.center, { size: CENTER_SIZES[0], weight: 800 }, CENTER_SIZES, RING.radius * 2 - 44);
  drawText(frame, backend, graphic.center, RING.x, RING.y - Math.round(font.size * 0.62), font, { align: "center", level: LEVELS.text });
  drawText(frame, backend, graphic.sub, RING.x, RING.y + Math.round(font.size * 0.34), { size: 14, weight: 700 }, { align: "center", level: LEVELS.label, maxWidth: RING.radius * 2 - 30 });
}

/** The two stats of the lower left tile: label small and dim, value big. */
function drawStats(frame: Frame, stats: RingGraphic["stats"], backend: TextBackend): void {
  stats.forEach((stat, index) => {
    const x = 14 + index * 136;
    drawText(frame, backend, stat.label, x, 154, LABEL_FONT, { level: LEVELS.label, maxWidth: 126 });
    const value = fitFont(backend, stat.value, { size: 30, weight: 800 }, [30, 26, 22, 18, 14], 126);
    drawText(frame, backend, fitText(backend, stat.value, value, 126), x, 172, value, { level: LEVELS.text });
  });
}

function drawLeft(frame: Frame, model: CockpitModel, backend: TextBackend): void {
  drawRing(frame, model.graphic, backend);
  drawStats(frame, model.graphic.stats, backend);
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
