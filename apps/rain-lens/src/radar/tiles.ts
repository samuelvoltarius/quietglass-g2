/**
 * Web-Mercator tile arithmetic for the radar page, pure and without any
 * network: which 256 px tiles cover a window around a place, and where each
 * one lands in that window.
 */

export const TILE_SIZE = 256;
/** RainViewer's free tiles stop at zoom 7 (zoom 8 answers with a "not supported" picture). */
export const RADAR_ZOOM = 7;

export interface Position { readonly latitude: number; readonly longitude: number; }
export interface PixelPoint { readonly x: number; readonly y: number; }

const MAX_LATITUDE = 85.0511287798;

/** Pixel of a position on the whole-world map at `zoom` (origin top-left, x east, y south). */
export function worldPixel(position: Position, zoom = RADAR_ZOOM): PixelPoint {
  const size = TILE_SIZE * 2 ** zoom;
  const latitude = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, position.latitude));
  const radians = (latitude * Math.PI) / 180;
  const x = ((position.longitude + 180) / 360) * size;
  const y = ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * size;
  return { x, y };
}

/** Metres one pixel stands for at this latitude and zoom. */
export function metersPerPixel(latitude: number, zoom = RADAR_ZOOM): number {
  return (156_543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
}

export interface WindowSpec {
  /** Size of the window in pixels. */
  readonly width: number;
  readonly height: number;
  /** Where the position sits inside the window. */
  readonly anchorX: number;
  readonly anchorY: number;
}

export interface Placement {
  /** Tile column and row (the column wrapped round the world). */
  readonly tx: number;
  readonly ty: number;
  /** Where the tile's top-left corner lands in the window (may be negative: partly outside). */
  readonly x: number;
  readonly y: number;
}

/** The tiles that touch the window, row by row. Rows outside the map are left out. */
export function windowTiles(position: Position, spec: WindowSpec, zoom = RADAR_ZOOM): Placement[] {
  const center = worldPixel(position, zoom);
  const left = center.x - spec.anchorX;
  const top = center.y - spec.anchorY;
  const count = 2 ** zoom;
  const firstX = Math.floor(left / TILE_SIZE);
  const lastX = Math.floor((left + spec.width - 1) / TILE_SIZE);
  const firstY = Math.floor(top / TILE_SIZE);
  const lastY = Math.floor((top + spec.height - 1) / TILE_SIZE);
  const placements: Placement[] = [];
  for (let ty = firstY; ty <= lastY; ty += 1) {
    if (ty < 0 || ty >= count) continue;
    for (let tx = firstX; tx <= lastX; tx += 1) {
      placements.push({ tx: ((tx % count) + count) % count, ty, x: Math.round(tx * TILE_SIZE - left), y: Math.round(ty * TILE_SIZE - top) });
    }
  }
  return placements;
}

export const RAINVIEWER_HOST = "https://tilecache.rainviewer.com";

/** Tile URL: 256 px, colour scheme 2, smoothed, with snow (the "1_1" options). */
export function tileUrl(path: string, zoom: number, tx: number, ty: number, host = RAINVIEWER_HOST): string {
  return `${host}${path}/${TILE_SIZE}/${zoom}/${tx}/${ty}/2/1_1.png`;
}
