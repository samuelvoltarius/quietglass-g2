/**
 * Full-screen kit, part 1: the frame.
 *
 * Meant to be copied into other Quietglass G2 apps (each app keeps its own
 * copy of `src/screen/`, no shared package). It has no imports from the app
 * and no DOM except the optional canvas text backend in text.ts.
 *
 * The idea: draw the whole 576 x 288 display as ONE grey bitmap, then cut it
 * into the four 288 x 144 image containers (2 x 2, the SDK maximum per page
 * and per container). Every image update crosses Bluetooth as a whole, so the
 * sender (sender.ts) only resends the tiles whose pixels really changed: a
 * clock in the top-right corner costs one tile a minute, not four.
 *
 * Pixels are grey levels 0…15 (the host converts every image to 4-bit grey;
 * on the G2 they are sixteen brightnesses of green). 0 is off.
 */

export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;
export const TILE_WIDTH = 288;
export const TILE_HEIGHT = 144;
export const MAX_LEVEL = 15;

/** A grey bitmap; structurally the same as the app's other bitmaps. */
export interface Frame {
  readonly width: number;
  readonly height: number;
  /** Row-major grey levels 0…15. */
  readonly pixels: Uint8Array;
}

export function createFrame(width = SCREEN_WIDTH, height = SCREEN_HEIGHT): Frame {
  return { width, height, pixels: new Uint8Array(width * height) };
}

/** The four tiles of a frame, left to right, top to bottom (each half the frame's width and height). */
export function tiles(frame: Frame): [Frame, Frame, Frame, Frame] {
  const w = Math.floor(frame.width / 2); const h = Math.floor(frame.height / 2);
  return [crop(frame, 0, 0, w, h), crop(frame, w, 0, w, h), crop(frame, 0, h, w, h), crop(frame, w, h, w, h)];
}

/** A copy of one rectangle of `frame`; anything outside reads as 0. */
export function crop(frame: Frame, x: number, y: number, width: number, height: number): Frame {
  const out = createFrame(width, height);
  for (let row = 0; row < height; row += 1) {
    const sy = y + row;
    if (sy < 0 || sy >= frame.height) continue;
    for (let column = 0; column < width; column += 1) {
      const sx = x + column;
      if (sx < 0 || sx >= frame.width) continue;
      out.pixels[row * width + column] = frame.pixels[sy * frame.width + sx]!;
    }
  }
  return out;
}

/** Copies `source` into `target` at (x, y), clipped. With `skipZero` black source pixels leave the target alone. */
export function blit(target: Frame, source: Frame, x: number, y: number, skipZero = false): void {
  for (let row = 0; row < source.height; row += 1) {
    const ty = y + row;
    if (ty < 0 || ty >= target.height) continue;
    for (let column = 0; column < source.width; column += 1) {
      const tx = x + column;
      if (tx < 0 || tx >= target.width) continue;
      const level = source.pixels[row * source.width + column]!;
      if (skipZero && level === 0) continue;
      target.pixels[ty * target.width + tx] = level;
    }
  }
}

/** Short fingerprint (FNV-1a over size and pixels): equal pictures give equal keys. */
export function frameKey(frame: Frame): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < frame.pixels.length; index += 1) {
    hash ^= frame.pixels[index]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${frame.width}x${frame.height}:${hash.toString(16).padStart(8, "0")}`;
}
