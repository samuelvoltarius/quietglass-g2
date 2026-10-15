import { createBitmap, fillRect, line, MAX_LEVEL, plot, type Bitmap } from "../glasses/bitmap";
import { baseMapFor, CUT_LEVEL, TRANSPARENT, type BaseMap } from "./basemap";
import { RADAR_AREA, SCREEN_HEIGHT, SCREEN_WIDTH, TILE_HEIGHT, TILE_WIDTH, type MapArea } from "./layout";
import { RADAR_ZOOM, TILE_SIZE, windowTiles, type Placement, type Position } from "./tiles";

/**
 * One radar picture for the whole 576 x 288 display, as four 288 x 144 tiles
 * (2 x 2 image containers). Pure drawing, no canvas and no network.
 *
 * The top 34 and bottom 36 rows stay black: that is where the header and the
 * footer text sit (the source credit must stay readable). The map area in
 * between is centred on the place, drawn at 1 pixel per radar pixel: the dim
 * base map (borders, coast, lakes, rivers, range rings) below, the rain above
 * it in the bright levels 6…15, place names on top and the place as a cross.
 */

export { ANCHOR, MAP, RADAR_AREA, RADAR_TILES, SCREEN_HEIGHT, SCREEN_WIDTH, TILE_HEIGHT, TILE_WIDTH } from "./layout";
export { RING_KM } from "./basemap";

/** Radar grey levels of a 256 x 256 tile, one byte per pixel, or null for a tile without data. */
export type TileLevels = Uint8Array | null;
/** Looks up the levels of one tile (column, row at the radar zoom). */
export type TileLookup = (tx: number, ty: number) => TileLevels;

/** Placements of the tiles the map area needs for this place; the loader fetches exactly these. */
export function neededTiles(position: Position, zoom = RADAR_ZOOM, area: MapArea = RADAR_AREA): Placement[] {
  return windowTiles(position, { width: area.width, height: area.height, anchorX: area.anchorX, anchorY: area.anchorY }, zoom);
}

/** Radar level 1…15 on the screen: 6…15, so rain is always brighter than the base map (2…3). */
export function rainLevel(level: number): number {
  return level <= 0 ? 0 : Math.min(MAX_LEVEL, 6 + Math.round(((Math.min(level, MAX_LEVEL) - 1) * 9) / 14));
}

/**
 * Copies one tile into the map area, clipped; later tiles never overwrite a lit
 * pixel with a dark one. A base-map line under rain is cut dark into it.
 */
function blit(target: Bitmap, levels: Uint8Array, placement: Placement, lines: Uint8Array | null, area: MapArea): void {
  for (let row = 0; row < TILE_SIZE; row += 1) {
    const y = area.y + placement.y + row;
    if (y < area.y || y >= area.y + area.height) continue;
    for (let column = 0; column < TILE_SIZE; column += 1) {
      const x = area.x + placement.x + column;
      if (x < area.x || x >= area.x + area.width) continue;
      const level = levels[row * TILE_SIZE + column] ?? 0;
      if (level > 0) { const at = y * target.width + x; target.pixels[at] = lines && lines[at]! > 0 ? CUT_LEVEL : rainLevel(level); }
    }
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

/**
 * The whole display as one bitmap (grey levels 0…15). `base` is the base map
 * for this place (drawn once per place, see basemap.ts); null draws the radar
 * on black, `lookup` returning null everywhere draws the map alone.
 */
export function composeFrame(position: Position, lookup: TileLookup, zoom = RADAR_ZOOM, base: BaseMap | null = baseMapFor(position, zoom), area: MapArea = RADAR_AREA, cross = true): Bitmap {
  const bitmap = createBitmap(SCREEN_WIDTH, SCREEN_HEIGHT);
  if (base) bitmap.pixels.set(base.lines);
  for (const placement of neededTiles(position, zoom, area)) {
    const levels = lookup(placement.tx, placement.ty);
    if (levels) blit(bitmap, levels, placement, base?.lines ?? null, area);
  }
  if (base) for (let at = 0; at < base.overlay.length; at += 1) { const level = base.overlay[at]!; if (level !== TRANSPARENT) bitmap.pixels[at] = level; }
  if (cross) drawCross(bitmap, area.x + area.anchorX, area.y + area.anchorY);
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
