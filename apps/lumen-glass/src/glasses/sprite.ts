import type { MothState } from "../lumen/moth";
import type { PixelIcon } from "./pixel";

/**
 * The pixel moth in the header corner (16 x 9, drawn at 3x into 64 x 30).
 *
 * Frames depend only on (state, now), so they are testable and the caller
 * decides how often to redraw. Only an awake moth moves: its wings go up and
 * down once per second. Every other state stands still, so a tired moth looks
 * tired and nothing is sent to the glasses for no reason.
 */

/** Wings spread and drooping, the resting shape. */
const WINGS_DOWN: PixelIcon = [
  "......#..#......",
  ".......##.......",
  "####...##...####",
  "######.##.######",
  ".#####.##.#####.",
  "..####.##.####..",
  "...###.##.###...",
  "....##.##.##....",
  ".....#.##.#.....",
];

/** Wings raised high over the body. */
const WINGS_UP: PixelIcon = [
  "##....#..#....##",
  "####..#..#..####",
  "#####.####.#####",
  ".####..##..####.",
  "..###..##..###..",
  "...##..##..##...",
  "....#..##..#....",
  ".......##.......",
  "................",
];

/** Wings folded together, for a sleepy moth. */
const FOLDED: PixelIcon = [
  "......#..#......",
  ".......##.......",
  "......####......",
  "......####......",
  ".......##.......",
  ".......##.......",
  "........#.......",
  "................",
  "................",
];

/** Curled up and waiting; it does not leave. */
const CURLED: PixelIcon = [
  "................",
  "................",
  "................",
  "......####......",
  ".....######.....",
  ".....#.##.#.....",
  "......####......",
  "................",
  "................",
];

/** One wing beat takes two steps, so a full flap is one second. */
export const FLAP_STEP_MS = 500;

export function mothSprite(state: MothState, now: number): PixelIcon {
  switch (state) {
    case "leuchtet":
      return WINGS_UP;
    case "wach":
      return Math.floor(now / FLAP_STEP_MS) % 2 === 0 ? WINGS_UP : WINGS_DOWN;
    case "matt":
      return WINGS_DOWN;
    case "schläfrig":
      return FOLDED;
    case "eingerollt":
    default:
      return CURLED;
  }
}

/** True when the sprite changes over time and the page should be redrawn on a clock. */
export function isFlapping(state: MothState): boolean {
  return state === "wach";
}

export function spriteKey(icon: PixelIcon): string {
  return icon.join("|");
}
