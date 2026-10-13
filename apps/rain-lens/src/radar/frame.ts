import { createBitmap, drawText, fillRect, line, MAX_LEVEL, plot, textWidth, type Bitmap } from "../glasses/bitmap";
import { RADAR_ZOOM, TILE_SIZE, metersPerPixel, windowTiles, type Placement, type Position } from "./tiles";

/**
 * One radar picture for the whole 576 x 288 display, as four 288 x 144 tiles
 * (2 x 2 image containers). Pure drawing, no canvas and no network.
 *
 * The top 34 and bottom 36 rows stay black: that is where the header and the
 * footer text sit (the source credit must stay readable). The map area in
 * between is centred on the place, drawn at 1 pixel per radar pixel, with two
 * dotted range rings (100 and 200 km) for scale and the place as a pixel cross.
 */

export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;
export const TILE_WIDTH = 288;
export const TILE_HEIGHT = 144;
/** The four image containers, left to right, top to bottom. */
export const RADAR_TILES = [
  { id: 11, name: "radar-nw", x: 0, y: 0, width: TILE_WIDTH, height: TILE_HEIGHT },
  { id: 12, name: "radar-ne", x: TILE_WIDTH, y: 0, width: TILE_WIDTH, height: TILE_HEIGHT },
  { id: 13, name: "radar-sw", x: 0, y: TILE_HEIGHT, width: TILE_WIDTH, height: TILE_HEIGHT },
  { id: 14, name: "radar-se", x: TILE_WIDTH, y: TILE_HEIGHT, width: TILE_WIDTH, height: TILE_HEIGHT },
] as const;

/** The map area between the header and footer text. */
export const MAP = { x: 0, y: 34, width: SCREEN_WIDTH, height: 218 } as const;
/** Where the place is drawn: the middle of the map area. */
export const ANCHOR = { x: MAP.width / 2, y: MAP.height / 2 } as const;
export const RING_KM = [100, 200] as const;

/** Radar grey levels of a 256 x 256 tile, one byte per pixel, or null for a tile without data. */
export type TileLevels = Uint8Array | null;
/** Looks up the levels of one tile (column, row at the radar zoom). */
export type TileLookup = (tx: number, ty: number) => TileLevels;

/** Placements of the tiles the map area needs for this place; the loader fetches exactly these. */
export function neededTiles(position: Position, zoom = RADAR_ZOOM): Placement[] {
  return windowTiles(position, { width: MAP.width, height: MAP.height, anchorX: ANCHOR.x, anchorY: ANCHOR.y }, zoom);
}

/** Copies one tile into the map area, clipped; later tiles never overwrite a lit pixel with a dark one. */
function blit(target: Bitmap, levels: Uint8Array, placement: Placement): void {
  for (let row = 0; row < TILE_SIZE; row += 1) {
    const y = MAP.y + placement.y + row;
    if (y < MAP.y || y >= MAP.y + MAP.height) continue;
    for (let column = 0; column < TILE_SIZE; column += 1) {
      const x = MAP.x + placement.x + column;
      if (x < MAP.x || x >= MAP.x + MAP.width) continue;
      const level = levels[row * TILE_SIZE + column] ?? 0;
      if (level > 0) target.pixels[y * target.width + x] = level;
    }
  }
}

/** A dotted circle clipped to the map area. */
function ring(target: Bitmap, cx: number, cy: number, radius: number, level: number): void {
  const steps = Math.max(24, Math.round(radius * 1.2));
  for (let step = 0; step < steps; step += 1) {
    if (step % 3 === 2) continue;
    const angle = (step / steps) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(angle) * radius);
    const y = Math.round(cy + Math.sin(angle) * radius);
    if (x >= MAP.x && x < MAP.x + MAP.width && y >= MAP.y && y < MAP.y + MAP.height) plot(target, x, y, level);
  }
}

/** The place: a white cross with a black halo, so it shows over any radar level. */
export function drawCross(target: Bitmap, cx: number, cy: number): void {
  fillRect(target, cx - 11, cy - 2, 23, 5, 0);
  fillRect(target, cx - 2, cy - 11, 5, 23, 0);
  line(target, cx - 9, cy, cx - 3, cy, MAX_LEVEL, 1);
  line(target, cx + 3, cy, cx + 9, cy, MAX_LEVEL, 1);
  line(target, cx, cy - 9, cx, cy - 3, MAX_LEVEL, 1);
  line(target, cx, cy + 3, cx, cy + 9, MAX_LEVEL, 1);
  plot(target, cx, cy, MAX_LEVEL);
}

/** The whole display as one bitmap (grey levels 0…15). */
export function composeFrame(position: Position, lookup: TileLookup, zoom = RADAR_ZOOM): Bitmap {
  const bitmap = createBitmap(SCREEN_WIDTH, SCREEN_HEIGHT);
  const cx = MAP.x + ANCHOR.x;
  const cy = MAP.y + ANCHOR.y;
  // Rings first, so the radar paints over them where it rains.
  const perPixel = metersPerPixel(position.latitude, zoom);
  for (const km of RING_KM) {
    const radius = (km * 1000) / perPixel;
    ring(bitmap, cx, cy, radius, 4);
    const label = `${km} KM`;
    const labelX = Math.round(cx + radius * Math.SQRT1_2 + 3);
    const labelY = Math.round(cy - radius * Math.SQRT1_2 - 5);
    if (labelX + textWidth(label, 1) < MAP.x + MAP.width && labelY > MAP.y && labelY + 5 < MAP.y + MAP.height) drawText(bitmap, label, labelX, labelY, 1, 6);
  }
  for (const placement of neededTiles(position, zoom)) {
    const levels = lookup(placement.tx, placement.ty);
    if (levels) blit(bitmap, levels, placement);
  }
  drawCross(bitmap, cx, cy);
  return bitmap;
}

/** The four 288 x 144 pieces of a display bitmap, in container order. */
export function splitTiles(bitmap: Bitmap): [Bitmap, Bitmap, Bitmap, Bitmap] {
  const piece = (left: number, top: number): Bitmap => {
    const out = createBitmap(TILE_WIDTH, TILE_HEIGHT);
    for (let row = 0; row < TILE_HEIGHT; row += 1) {
      out.pixels.set(bitmap.pixels.subarray((top + row) * bitmap.width + left, (top + row) * bitmap.width + left + TILE_WIDTH), row * TILE_WIDTH);
    }
    return out;
  };
  return [piece(0, 0), piece(TILE_WIDTH, 0), piece(0, TILE_HEIGHT), piece(TILE_WIDTH, TILE_HEIGHT)];
}

/** A short fingerprint of a bitmap; equal pictures give equal keys, so unchanged tiles are never resent. */
export function bitmapKey(bitmap: Bitmap): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bitmap.pixels.length; index += 1) {
    hash ^= bitmap.pixels[index] ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
