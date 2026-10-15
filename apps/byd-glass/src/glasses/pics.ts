import { DIM, FULL, MID, createBitmap, drawPattern, drawText, fillRect, strokeRect, textWidth, type Bitmap } from "./gfx";

/**
 * Every picture on the glasses as a pure function of its inputs: equal values
 * give equal bitmaps, so nothing crosses BLE twice. Only the small sign in the
 * top-right corner (64 x 30) and the charge bar animate; the big pictures
 * change with the car's values (Overdrive reports about every 5 s).
 */

export const ICON_WIDTH = 64;
export const ICON_HEIGHT = 30;
/** Animation step: also the blinker rhythm (~1 Hz on/off). */
export const ICON_STEP_MS = 500;

export const HALF = 288;
export const BIG_HEIGHT = 144;
export const CHARGE_TOP_HEIGHT = 100;
export const CHARGE_BAR_HEIGHT = 36;
export const STATUS_HEIGHT = 104;

// ---- the sign: a car ------------------------------------------------------

export type IconKind = "drive" | "charge" | "park" | "alert" | "loading" | "offline";

export interface Signals {
  readonly left: boolean;
  readonly right: boolean;
  readonly highBeam: boolean;
}

const BODY = [
  "......#########.......",
  ".....#....#....##.....",
  "....#.....#......#....",
  ".####################.",
  "######################",
  "###......######......#",
];
const ARROW_LEFT = ["...#", "..##", ".###", "####", ".###", "..##", "...#"];
const ARROW_RIGHT = ARROW_LEFT.map((row) => [...row].reverse().join(""));
const BOLT = ["...##", "..##.", ".##..", "#####", "..##.", ".##..", "##..."];
const CAR_X = 10;
const CAR_Y = 5;

function wheel(b: Bitmap, cx: number, cy: number, value: number, spoke: number | null): void {
  for (let dy = -3; dy <= 3; dy += 1) {
    for (let dx = -3; dx <= 3; dx += 1) {
      const d = dx * dx + dy * dy;
      if (d <= 10) fillRect(b, cx + dx, cy + dy, 1, 1, value);
    }
  }
  fillRect(b, cx, cy, 1, 1, 0);
  if (spoke !== null) {
    const [sx, sy] = ([[0, -2], [2, 0], [0, 2], [-2, 0]] as const)[spoke % 4] ?? [0, -2];
    fillRect(b, cx + sx, cy + sy, 1, 1, 0);
  }
}

export function carIcon(kind: IconKind, now: number, signals: Signals = { left: false, right: false, highBeam: false }): Bitmap {
  const b = createBitmap(ICON_WIDTH, ICON_HEIGHT);
  const step = Math.floor(now / ICON_STEP_MS);
  const on = step % 2 === 0;
  const dimBody = kind === "offline" || kind === "loading";
  const body = kind === "alert" && !on ? BODY.map((row) => row.replace(/#/g, "+")) : dimBody ? BODY.map((row) => row.replace(/#/g, "-")) : BODY;
  drawPattern(b, body, CAR_X, CAR_Y, 2);
  const spinning = kind === "drive" || kind === "loading";
  const wheelValue = dimBody ? MID : FULL;
  wheel(b, CAR_X + 13, CAR_Y + 13, wheelValue, spinning ? step : null);
  wheel(b, CAR_X + 37, CAR_Y + 13, wheelValue, spinning ? step + 2 : null);

  if (kind === "charge") drawPattern(b, on ? BOLT : BOLT.map((row) => row.replace(/#/g, "+")), 54, 8, 2);
  if (kind === "park") drawText(b, "P", 56, 9, 2, MID);
  if (kind === "alert") drawText(b, "!", 56, 8, 2, on ? FULL : MID);
  if (kind === "offline") {
    for (let i = 0; i < 9; i += 1) { fillRect(b, 54 + i, 9 + i, 2, 2, MID); fillRect(b, 62 - i, 9 + i, 2, 2, MID); }
  }
  if (signals.left && on) drawPattern(b, ARROW_LEFT, 0, 8, 2);
  if (signals.right && on && kind === "drive") drawPattern(b, ARROW_RIGHT, 56, 8, 2);
  if (signals.highBeam) {
    for (const y of [0, 2, 4]) fillRect(b, 1 + (y === 2 ? 0 : 1), y, 7, 1, FULL);
  }
  return b;
}

// ---- big digits helpers -----------------------------------------------------

/** Largest integer scale (<= max) at which `text` fits `width` x `height`. */
export function fitScale(text: string, width: number, height: number, max: number): number {
  let scale = max;
  while (scale > 1 && (textWidth(text, scale) > width || 7 * scale > height)) scale -= 1;
  return scale;
}

function label(b: Bitmap, text: string, x: number, y: number, scale: number): number {
  const w = textWidth(text, scale) + 2 * scale + 4;
  fillRect(b, x, y, w, 7 * scale + 6, FULL);
  drawText(b, text, x + scale + 2, y + 3, scale, 0);
  return w;
}

// ---- drive: speed (left) and energy (right) ---------------------------------

export interface SpeedSpec {
  readonly speed: number | null;
  readonly gear: string | null;
  readonly limitWarn: boolean;
  readonly stale: boolean;
  readonly unit: string;
  readonly limitLabel: string;
}

export function speedFrame(spec: SpeedSpec, width = HALF, height = BIG_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  const text = spec.speed === null ? "--" : String(Math.max(0, Math.round(spec.speed)));
  const top = spec.limitWarn ? 34 : 12;
  const scale = fitScale(text, width - 56, height - top - 24, 14);
  drawText(b, text, 6, top, scale, spec.stale ? MID : FULL);
  drawText(b, spec.unit, 8, height - 18, 2, MID);
  if (spec.gear) {
    const g = spec.gear.slice(0, 1).toUpperCase();
    strokeRect(b, width - 44, height - 50, 40, 46, MID, 2);
    drawText(b, g, width - 44 + Math.round((40 - textWidth(g, 4)) / 2), height - 50 + 9, 4, FULL);
  }
  if (spec.limitWarn) {
    label(b, spec.limitLabel, 0, 0, 3);
    strokeRect(b, 0, 0, width, height, FULL, 2);
  }
  return b;
}

export interface EnergySpec {
  readonly soc: number | null;
  readonly rangeKm: number | null;
  readonly powerKw: number | null;
  readonly km: string;
  readonly kw: string;
  readonly regen: string;
}

/** Regen up to 40 kW to the left of zero, drive up to 100 kW to the right. */
export const REGEN_MAX_KW = 40;
export const DRIVE_MAX_KW = 100;

export function powerBar(b: Bitmap, powerKw: number | null, x: number, y: number, w: number, h: number): void {
  const zero = x + Math.round(w * 0.3);
  strokeRect(b, x, y, w, h, DIM, 1);
  fillRect(b, zero - 1, y - 4, 3, h + 8, FULL);
  if (powerKw === null) return;
  if (powerKw >= 0) {
    const len = Math.round(Math.min(1, powerKw / DRIVE_MAX_KW) * (x + w - zero - 3));
    fillRect(b, zero + 2, y + 3, len, h - 6, FULL);
  } else {
    const len = Math.round(Math.min(1, -powerKw / REGEN_MAX_KW) * (zero - x - 3));
    // Regen: hatched, so it reads differently from drive power at a glance.
    for (let px = zero - 2; px > zero - 2 - len; px -= 1) {
      fillRect(b, px, y + 3, 1, h - 6, (zero - px) % 4 < 2 ? FULL : MID);
    }
  }
}

export function energyFrame(spec: EnergySpec, width = HALF, height = BIG_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  const soc = spec.soc === null ? "--%" : `${Math.round(spec.soc)}%`;
  drawText(b, soc, 6, 4, 6, FULL);
  const range = spec.rangeKm === null ? "--" : String(Math.round(spec.rangeKm));
  const rw = textWidth(range, 4) + 6 + textWidth(spec.km, 2);
  drawText(b, range, width - rw - 4, 14, 4, FULL);
  drawText(b, spec.km, width - textWidth(spec.km, 2) - 4, 28, 2, MID);
  // State of charge as a thin bar.
  strokeRect(b, 4, 52, width - 8, 12, DIM, 1);
  if (spec.soc !== null) fillRect(b, 6, 54, Math.round((width - 12) * Math.max(0, Math.min(100, spec.soc)) / 100), 8, FULL);
  powerBar(b, spec.powerKw, 4, 80, width - 8, 24);
  const p = spec.powerKw;
  const text = p === null ? "-- " + spec.kw : `${p > 0 ? "+" : p < 0 ? "-" : ""}${Math.abs(Math.round(p))} ${spec.kw}`;
  drawText(b, text, 6, 114, 3, FULL);
  if (p !== null && p < 0) drawText(b, spec.regen, width - textWidth(spec.regen, 3) - 6, 114, 3, MID);
  return b;
}

// ---- charge -----------------------------------------------------------------

export function chargeSocFrame(soc: number | null, rangeKm: number | null, kmLabel: string, width = HALF, height = CHARGE_TOP_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  const text = soc === null ? "--%" : `${Math.round(soc)}%`;
  const scale = fitScale(text, width - 8, 72, 10);
  drawText(b, text, 6, 4, scale, FULL);
  const range = `${rangeKm === null ? "--" : Math.round(rangeKm)} ${kmLabel}`;
  drawText(b, range, 8, height - 22, 3, MID);
  return b;
}

export interface ChargeKwSpec {
  readonly kw: number | null;
  readonly dc: boolean;
  readonly etaMin: number | null;
  readonly done: boolean;
  readonly kwLabel: string;
  readonly minLabel: string;
  readonly doneLabel: string;
}

export function chargeKwFrame(spec: ChargeKwSpec, width = HALF, height = CHARGE_TOP_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  if (spec.done) {
    const scale = fitScale(spec.doneLabel, width - 12, 60, 7);
    drawText(b, spec.doneLabel, 6, 18, scale, FULL);
    return b;
  }
  const kw = spec.kw === null ? "--" : String(Math.round(spec.kw));
  const scale = fitScale(kw, width - 120, 72, 10);
  drawText(b, kw, 6, 4, scale, FULL);
  drawText(b, spec.kwLabel, 6 + textWidth(kw, scale) + 8, 4 + 7 * scale - 21, 3, MID);
  label(b, spec.dc ? "DC" : "AC", width - textWidth("DC", 3) - 14, 2, 3);
  if (spec.etaMin !== null) {
    const eta = spec.etaMin >= 60 ? `${Math.floor(spec.etaMin / 60)}:${String(spec.etaMin % 60).padStart(2, "0")} H` : `${spec.etaMin} ${spec.minLabel}`;
    drawText(b, eta, 8, height - 22, 3, MID);
  }
  return b;
}

/** Battery outline filled to the charge; while charging a light runs ahead of the fill. */
export function chargeBarFrame(soc: number | null, now: number, animate: boolean, width = HALF, height = CHARGE_BAR_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  const bodyW = width - 10;
  strokeRect(b, 0, 2, bodyW, height - 4, FULL, 2);
  fillRect(b, bodyW, Math.round(height / 2) - 6, 8, 12, FULL);
  const inner = bodyW - 8;
  const level = soc === null ? 0 : Math.max(0, Math.min(100, soc)) / 100;
  const fill = Math.round(inner * level);
  fillRect(b, 4, 6, fill, height - 12, FULL);
  if (animate && fill < inner) {
    const step = Math.floor(now / ICON_STEP_MS);
    const room = inner - fill;
    const cells = Math.max(1, Math.floor(room / 16));
    const at = fill + 4 + (step % cells) * 16 + 3;
    fillRect(b, at, 10, Math.min(10, inner + 4 - at), height - 20, MID);
  }
  return b;
}

// ---- status: tyres and lock ----------------------------------------------------

export interface TyreSpec {
  /** Pressure text ("2,5") or null. */
  readonly text: string | null;
  readonly leak: boolean;
  readonly low: boolean;
}

export function tyresFrame(tyres: { readonly fl: TyreSpec; readonly fr: TyreSpec; readonly rl: TyreSpec; readonly rr: TyreSpec }, width = HALF, height = STATUS_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  const cx = Math.round(width / 2);
  // Car seen from above, nose up.
  strokeRect(b, cx - 26, 4, 52, height - 8, FULL, 2);
  fillRect(b, cx - 20, 22, 40, 2, MID);
  fillRect(b, cx - 20, height - 26, 40, 2, MID);
  const spots: Array<[keyof typeof tyres, number, number, boolean]> = [
    ["fl", cx - 40, 12, true], ["fr", cx + 28, 12, false],
    ["rl", cx - 40, height - 40, true], ["rr", cx + 28, height - 40, false],
  ];
  for (const [key, x, y, left] of spots) {
    const tyre = tyres[key];
    if (tyre.leak) fillRect(b, x, y, 12, 28, FULL);
    else if (tyre.low) { strokeRect(b, x, y, 12, 28, FULL, 2); fillRect(b, x + 3, y + 3, 6, 22, MID); }
    else strokeRect(b, x, y, 12, 28, FULL, 2);
    const text = (tyre.text ?? "--") + (tyre.leak || tyre.low ? "!" : "");
    const scale = 4;
    const w = textWidth(text, scale);
    const tx = left ? x - 8 - w : x + 20;
    const ty = y + 1;
    if (tyre.leak) {
      fillRect(b, tx - 3, ty - 3, w + 6, 7 * scale + 6, FULL);
      drawText(b, text, tx, ty, scale, 0);
    } else {
      drawText(b, text, tx, ty, scale, tyre.text === null ? MID : FULL);
    }
  }
  return b;
}

const LOCK_CLOSED = [
  "...#####...",
  "..#.....#..",
  "..#.....#..",
  "..#.....#..",
  "###########",
  "###########",
  "#####.#####",
  "####...####",
  "#####.#####",
  "#####.#####",
  "###########",
  "###########",
];
const LOCK_OPEN = [
  "...#####...",
  "..#.....#..",
  "..#........",
  "..#........",
  "###########",
  "###########",
  "#####.#####",
  "####...####",
  "#####.#####",
  "#####.#####",
  "###########",
  "###########",
];

export interface LockSpec {
  readonly locked: boolean | null;
  readonly doorOpen: boolean;
  readonly word: string;
  readonly doorWord: string;
}

export function lockFrame(spec: LockSpec, width = HALF, height = STATUS_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  const pattern = spec.locked === false ? LOCK_OPEN : LOCK_CLOSED;
  drawPattern(b, spec.locked === null ? pattern.map((row) => row.replace(/#/g, "-")) : pattern, 12, 12, 6);
  const scale = fitScale(spec.word, width - 98, 42, 6);
  drawText(b, spec.word, 92, 14, scale, spec.locked === null ? MID : FULL);
  if (spec.doorOpen) {
    const s = fitScale(spec.doorWord, width - 100, 21, 3);
    label(b, spec.doorWord, 90, height - 7 * s - 12, s);
  }
  return b;
}
