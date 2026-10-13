import { MAX_LEVEL } from "../glasses/bitmap";

/**
 * Turns one radar pixel (RGBA from RainViewer's tile) into a grey level on the
 * glasses, 0 (nothing) to 15 (the heaviest).
 *
 * The tile's palette runs: faint grey-brown with low opacity for drizzle,
 * light to dark blue for rain, yellow, orange and red for heavy rain, dark red
 * and pink for the extreme end. Pale cyan with low opacity is snow. The mapping
 * keeps that order, so brighter always means more precipitation.
 */
export function levelOf(red: number, green: number, blue: number, alpha: number): number {
  if (alpha < 12) return 0;
  // Snow: very light cyan, opacity carries the strength.
  if (red >= 185 && green >= 250 && blue >= 250) return clamp(2 + (alpha / 255) * 6);
  // Faint drizzle: grey-brown, opacity carries the strength.
  if (alpha < 250 && blue <= 160 && green <= 215) return clamp(1.5 + (alpha / 255) * 4);
  // Heavy rain: yellow, orange, red, dark red.
  if (red >= 180 && blue < 120) return clamp(11 + (255 - green) / 255 * 3.5);
  if (red >= 90 && red > green + 60 && blue < 120) return 14;
  // Extreme: pink.
  if (red > 200 && blue > 200 && green < 190) return MAX_LEVEL;
  // Rain: light blue is weak, dark blue is strong.
  const brightness = 0.3 * red + 0.59 * green + 0.11 * blue;
  return clamp(6 + ((205 - brightness) / 155) * 4.5);
}

function clamp(level: number): number {
  return Math.max(1, Math.min(MAX_LEVEL, Math.round(level)));
}

/** Converts an RGBA pixel buffer (a decoded tile) to grey levels, one byte per pixel. */
export function levelsFromRgba(rgba: ArrayLike<number>, pixels: number): Uint8Array {
  const levels = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    const at = index * 4;
    levels[index] = levelOf(rgba[at] ?? 0, rgba[at + 1] ?? 0, rgba[at + 2] ?? 0, rgba[at + 3] ?? 0);
  }
  return levels;
}
