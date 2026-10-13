/**
 * Where the radar page's pictures sit. Kept apart from the drawing code so the
 * page layout (glasses/text.ts, part of every build) does not pull the radar
 * drawing and the base map into the public bundle.
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
