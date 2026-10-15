import type { ManeuverType } from "../routing/provider";
import { HUD_IMAGES, type SpeedBig } from "./hud";
import { pixelArrowGrid } from "./icons";
import { createGrayCanvas, encodePng, type GrayCanvas } from "./png";
import { drawGlyphs, labelWidth } from "./turncard";

/**
 * The three pictures of the HUD layout, all drawn without a canvas (same
 * bytes in the app, the tests and the preview):
 *
 *  - the turn arrow, 192 × 192, sent as two images of 192 × 96 (an image
 *    container may be at most 144 px high) - only when the manoeuvre TYPE
 *    changes, never for a new distance;
 *  - the speed-limit sign, 96 × 96 - only when the limit changes;
 *  - the speed in large digits, 184 × 64 - only when the shown km/h changes,
 *    and then at most once a second (the glasses have a single text size).
 *
 * Everything else that changes with every fix (distance, ETA, alerts) is text.
 */

export const HUD_ARROW_SIZE = 192;
/** Cells of the arrow grid; each is drawn as a 2 × 2 px square. */
export const HUD_ARROW_GRID = 96;
export const HUD_ARROW_HALF = HUD_ARROW_SIZE / 2;
export const LIMIT_SIGN_SIZE = 96;

/** The whole arrow as one grey canvas (the preview uses it; the glasses get it in two halves). */
export function drawHudArrow(type: ManeuverType | undefined): GrayCanvas {
  const canvas = createGrayCanvas(HUD_ARROW_SIZE, HUD_ARROW_SIZE);
  const grid = pixelArrowGrid(type, HUD_ARROW_GRID);
  const scale = HUD_ARROW_SIZE / HUD_ARROW_GRID;
  canvas.fillStyle = "#fff";
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "#") { x++; continue; }
      let end = x;
      while (end < row.length && row[end] === "#") end++;
      canvas.fillRect(x * scale, y * scale, (end - x) * scale, scale);
      x = end;
    }
  });
  return canvas;
}

/** Upper and lower half of the arrow as PNGs, 192 × 96 each. */
export async function hudArrowPngs(type: ManeuverType | undefined): Promise<[Uint8Array, Uint8Array]> {
  const whole = drawHudArrow(type);
  const half = HUD_ARROW_SIZE * HUD_ARROW_HALF;
  return [
    await encodePng(HUD_ARROW_SIZE, HUD_ARROW_HALF, whole.pixels.slice(0, half)),
    await encodePng(HUD_ARROW_SIZE, HUD_ARROW_HALF, whole.pixels.slice(half)),
  ];
}

const RING_OUTER = 46;
const RING_WIDTH = 9;
/** Room for the number inside the ring. */
const NUMBER_MAX_W = 60;
const NUMBER_MAX_H = 42;

/** The round limit sign: a thick white ring with the number in large pixel digits. Null = black (no limit known). */
export function drawLimitSign(limit: number | null): GrayCanvas {
  const size = LIMIT_SIGN_SIZE;
  const canvas = createGrayCanvas(size, size);
  if (limit === null) return canvas;
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - c, y - c);
      if (r <= RING_OUTER && r >= RING_OUTER - RING_WIDTH) canvas.pixels[y * size + x] = 255;
    }
  }
  const label = String(Math.round(limit));
  let scale = 8;
  while (scale > 1 && (labelWidth(label, scale) > NUMBER_MAX_W || 7 * scale > NUMBER_MAX_H)) scale--;
  canvas.fillStyle = "#fff";
  drawGlyphs(canvas, label, Math.round((size - labelWidth(label, scale)) / 2), Math.round((size - 7 * scale) / 2), scale);
  return canvas;
}

export function limitSignPng(limit: number | null): Promise<Uint8Array> {
  return encodePng(LIMIT_SIGN_SIZE, LIMIT_SIGN_SIZE, drawLimitSign(limit).pixels);
}

export const SPEED_IMAGE_WIDTH = HUD_IMAGES.speed.width;
export const SPEED_IMAGE_HEIGHT = HUD_IMAGES.speed.height;
/** 5 × 7 digits at 7 px per dot: 49 px high, "188" is 119 px wide. */
const SPEED_SCALE = 7;
const UNIT_SCALE = 2;
const SPEED_LEFT = 4;

/**
 * The speed as large white digits with a small `km/h` beside them; too fast
 * turns it round (white plate, black digits) so it shows without reading.
 * `GPS` sits small above the unit when the car link fell back to the phone.
 */
export function drawHudSpeed(value: SpeedBig | null): GrayCanvas {
  const width = SPEED_IMAGE_WIDTH, height = SPEED_IMAGE_HEIGHT;
  const canvas = createGrayCanvas(width, height);
  if (!value) return canvas;
  if (value.fast) { canvas.fillStyle = "#fff"; canvas.fillRect(0, 0, width, height); }
  const ink = value.fast ? "#000" : "#fff";
  const label = value.kmh === null ? "--" : String(Math.max(0, Math.round(value.kmh)));
  let scale = SPEED_SCALE;
  const unitWidth = labelWidth("km/h", UNIT_SCALE);
  while (scale > 2 && SPEED_LEFT + labelWidth(label, scale) + 6 + unitWidth > width - 2) scale--;
  const top = Math.round((height - 7 * scale) / 2);
  canvas.fillStyle = ink;
  drawGlyphs(canvas, label, SPEED_LEFT, top, scale);
  const unitX = SPEED_LEFT + labelWidth(label, scale) + 6;
  drawGlyphs(canvas, "km/h", unitX, top + 7 * scale - 7 * UNIT_SCALE, UNIT_SCALE);
  if (value.gps) drawGlyphs(canvas, "GPS", unitX, top, UNIT_SCALE);
  return canvas;
}

export function hudSpeedPng(value: SpeedBig | null): Promise<Uint8Array> {
  return encodePng(SPEED_IMAGE_WIDTH, SPEED_IMAGE_HEIGHT, drawHudSpeed(value).pixels);
}
