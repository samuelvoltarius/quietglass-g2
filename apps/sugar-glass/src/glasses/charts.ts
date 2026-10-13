import { DIM, FULL, MID, createBitmap, drawPattern, drawText, fillRect, line, strokeRect, textWidth, type Bitmap } from "./gfx";
import type { Direction, Reading } from "../ns/model";

/**
 * Every picture on the glasses as a pure function of its inputs: equal values
 * give equal bitmaps, so nothing crosses BLE twice.
 */

export const ICON_WIDTH = 64;
export const ICON_HEIGHT = 30;
/** The big value with arrow and delta (left), the 3-hour curve (right). */
export const VALUE_WIDTH = 288;
export const VALUE_HEIGHT = 144;
export const CURVE_WIDTH = 288;
export const CURVE_HEIGHT = 144;
/** The sign animates in these steps. */
export const ICON_STEP_MS = 600;

export type Mood = "ok" | "alert" | "loading" | "offline";

// ---- the sign: a drop -------------------------------------------------------

const DROP = [
  "....##....",
  "....##....",
  "...####...",
  "...####...",
  "..######..",
  ".########.",
  ".########.",
  "##########",
  "##########",
  "##########",
  ".########.",
  "..######..",
];
const DROP_OUTLINE = [
  "....##....",
  "....##....",
  "...#..#...",
  "...#..#...",
  "..#....#..",
  ".#......#.",
  ".#......#.",
  "#........#",
  "#........#",
  "#........#",
  ".#......#.",
  "..######..",
];

/**
 * The drop in the top-right corner. ok: a highlight glints down the drop;
 * alert: full drop and "!" alternate (pulsing); loading: the drop fills from
 * the bottom; offline: an outline with a dim cross.
 */
export function dropFrame(mood: Mood, now: number): Bitmap {
  const b = createBitmap(ICON_WIDTH, ICON_HEIGHT);
  const step = Math.floor(now / ICON_STEP_MS);
  const scale = 2;
  const x = Math.floor((ICON_WIDTH - 10 * scale) / 2) - 12;
  const y = Math.floor((ICON_HEIGHT - 12 * scale) / 2);
  if (mood === "alert") {
    if (step % 2 === 0) {
      drawPattern(b, DROP, x, y, scale);
      drawText(b, "!", x + 6, y + 8, 2, 0);
      drawText(b, "!", 40, 4, 3, FULL);
    } else {
      drawPattern(b, DROP_OUTLINE, x, y, scale);
      drawText(b, "!", 40, 4, 3, MID);
    }
    return b;
  }
  if (mood === "offline") {
    drawPattern(b, DROP_OUTLINE.map((row) => row.replace(/#/g, "-")), x, y, scale);
    line(b, 40, 8, 54, 22, MID, 2);
    line(b, 54, 8, 40, 22, MID, 2);
    return b;
  }
  if (mood === "loading") {
    drawPattern(b, DROP_OUTLINE, x, y, scale);
    const level = step % 6;
    const rows = DROP.slice(12 - level * 2);
    drawPattern(b, rows, x, y + (12 - rows.length) * scale, scale);
    return b;
  }
  drawPattern(b, DROP, x, y, scale);
  // A dark glint that runs down the drop, then a pause.
  const glint = step % 8;
  if (glint < 5) fillRect(b, x + 6, y + 6 + glint * 3, 2, 4, 0);
  // Three falling dots to the right: a slow drip.
  for (let i = 0; i < 3; i += 1) {
    const dy = (step + i * 3) % 9;
    fillRect(b, 42 + i * 6, 4 + dy * 2, 3, 3, i === step % 3 ? FULL : DIM);
  }
  return b;
}

// ---- the trend arrow ----------------------------------------------------------

/** Angle in degrees (0 = right, 90 = up) and how many arrows. */
export function arrowFor(direction: Direction): { angle: number; count: number } | null {
  switch (direction) {
    case "TripleUp": return { angle: 90, count: 3 };
    case "DoubleUp": return { angle: 90, count: 2 };
    case "SingleUp": return { angle: 90, count: 1 };
    case "FortyFiveUp": return { angle: 45, count: 1 };
    case "Flat": return { angle: 0, count: 1 };
    case "FortyFiveDown": return { angle: -45, count: 1 };
    case "SingleDown": return { angle: -90, count: 1 };
    case "DoubleDown": return { angle: -90, count: 2 };
    case "TripleDown": return { angle: -90, count: 3 };
    default: return null;
  }
}

function arrow(b: Bitmap, cx: number, cy: number, angleDeg: number, length: number, thickness: number, value = FULL): void {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = -Math.sin(a);
  const half = length / 2;
  const tipX = cx + dx * half;
  const tipY = cy + dy * half;
  line(b, cx - dx * half, cy - dy * half, tipX - dx * thickness * 0.6, tipY - dy * thickness * 0.6, value, thickness);
  const head = length * 0.42;
  for (const turn of [Math.PI * 0.78, -Math.PI * 0.78]) {
    const hx = Math.cos(a + turn);
    const hy = -Math.sin(a + turn);
    line(b, tipX, tipY, tipX + hx * head, tipY + hy * head, value, thickness);
  }
}

/** One, two or three arrows in a box; "?" when the trend is unknown. */
export function drawTrend(b: Bitmap, direction: Direction, x: number, y: number, w: number, h: number, value = FULL): void {
  const spec = arrowFor(direction);
  if (!spec) {
    drawText(b, "?", x + Math.round((w - textWidth("?", 6)) / 2), y + Math.round((h - 42) / 2), 6, MID);
    return;
  }
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (spec.count === 1) { arrow(b, cx, cy, spec.angle, Math.min(w, h) - 8, 7, value); return; }
  const gap = spec.count === 2 ? 22 : 18;
  for (let i = 0; i < spec.count; i += 1) {
    const offset = (i - (spec.count - 1) / 2) * gap;
    arrow(b, cx + offset, cy, spec.angle, Math.min(h - 8, 64), 5, value);
  }
}

// ---- the big value ----------------------------------------------------------

export interface ValueSpec {
  /** The value already formatted ("106", "5,9"), or null for "--". */
  readonly value: string | null;
  readonly direction: Direction;
  /** "+4" / "-12" / null. */
  readonly delta: string | null;
  /** "MG/DL" / "MMOL". */
  readonly unit: string;
  /** "3 MIN". */
  readonly age: string;
  /** Alarm word drawn inverted on top ("NIEDRIG"), or null. */
  readonly label: string | null;
  /** The value is too old to trust: drawn dimmed and struck through. */
  readonly stale: boolean;
}

export function valueFrame(spec: ValueSpec, width = VALUE_WIDTH, height = VALUE_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  const arrowWidth = 78;
  const text = spec.value ?? "--";
  let scale = 12;
  while (scale > 4 && (textWidth(text, scale) > width - arrowWidth - 10 || 7 * scale > (spec.label ? 80 : 92))) scale -= 1;
  const top = spec.label ? 30 : 12;
  const ink = spec.stale ? MID : FULL;
  if (spec.label) {
    const labelScale = 3;
    const lw = textWidth(spec.label, labelScale) + 12;
    fillRect(b, 0, 0, Math.min(width, lw), 26, FULL);
    drawText(b, spec.label, 6, 3, labelScale, 0);
  }
  drawText(b, text, 4, top, scale, ink);
  if (spec.stale) line(b, 0, top + 7 * scale + 4, textWidth(text, scale) + 8, top - 4, FULL, 3);
  drawTrend(b, spec.stale ? "NONE" : spec.direction, width - arrowWidth, top - 6, arrowWidth, 7 * scale + 12, ink);
  const bottom = height - 23;
  let cursor = 4;
  if (spec.delta) cursor += drawText(b, spec.delta, cursor, bottom, 3, FULL) + 12;
  cursor += drawText(b, spec.unit, cursor, bottom + 7, 2, MID) + 14;
  drawText(b, spec.age, Math.max(cursor, width - textWidth(spec.age, 3) - 4), bottom, 3, spec.stale ? FULL : MID);
  if (spec.label) strokeRect(b, 0, 0, width, height, FULL, 2);
  return b;
}

// ---- the curve ----------------------------------------------------------------

export interface CurveSpec {
  /** Newest first (as the API returns them). */
  readonly readings: readonly Reading[];
  readonly now: number;
  /** Hours shown. */
  readonly hours: number;
  readonly targetLow: number;
  readonly targetHigh: number;
  readonly urgentLow: number;
  /** Labels for the two target lines, already in the chosen unit. */
  readonly lowLabel: string;
  readonly highLabel: string;
}

/**
 * The last hours as dots like Nightscout: target band as two dashed lines,
 * the urgent-low line dotted, hour marks, the newest reading as a big dot.
 * The vertical scale is 40–300 mg/dL and grows when values are higher.
 */
export function curveFrame(spec: CurveSpec, width = CURVE_WIDTH, height = CURVE_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  const left = 22;
  const right = width - 4;
  const top = 4;
  const bottom = height - 14;
  const span = spec.hours * 3_600_000;
  const start = spec.now - span;
  const shown = spec.readings.filter((r) => r.at >= start && r.at <= spec.now + 60_000);
  const lowest = 40;
  const highest = Math.min(400, Math.max(300, ...shown.map((r) => r.mgdl + 10)));
  const y = (mgdl: number): number => bottom - ((Math.min(highest, Math.max(lowest, mgdl)) - lowest) / (highest - lowest)) * (bottom - top);
  const x = (t: number): number => left + ((t - start) / span) * (right - left);

  // Frame of the plot: a dim base line.
  fillRect(b, left, bottom + 1, right - left + 1, 1, DIM);
  // Hour marks.
  for (let h = 1; h < spec.hours; h += 1) {
    const hx = Math.round(x(spec.now - h * 3_600_000));
    for (let yy = top; yy <= bottom; yy += 4) fillRect(b, hx, yy, 1, 1, DIM);
    const label = `-${h}H`;
    drawText(b, label, hx - Math.round(textWidth(label, 1) / 2), bottom + 4, 1, MID);
  }
  // Target band.
  for (const [mgdl, label] of [[spec.targetHigh, spec.highLabel], [spec.targetLow, spec.lowLabel]] as const) {
    const ly = Math.round(y(mgdl));
    for (let xx = left; xx <= right; xx += 6) fillRect(b, xx, ly, 3, 1, MID);
    drawText(b, label, 0, Math.max(0, Math.min(height - 7, ly - 3)), 1, MID);
  }
  const uy = Math.round(y(spec.urgentLow));
  for (let xx = left; xx <= right; xx += 3) fillRect(b, xx, uy, 1, 1, DIM);

  // Dots, oldest first so the newest sits on top.
  const ordered = [...shown].sort((a, c) => a.at - c.at);
  ordered.forEach((r, i) => {
    const newest = i === ordered.length - 1;
    const size = newest ? 7 : 4;
    const out = r.mgdl < spec.targetLow || r.mgdl > spec.targetHigh;
    const px = Math.round(x(r.at) - size / 2);
    const py = Math.round(y(r.mgdl) - size / 2);
    if (out && !newest) strokeRect(b, px, py, size, size, FULL, 1);
    else fillRect(b, px, py, size, size, FULL);
  });
  if (ordered.length === 0) drawText(b, "--", Math.round((width - textWidth("--", 4)) / 2), Math.round(height / 2) - 14, 4, MID);
  return b;
}
