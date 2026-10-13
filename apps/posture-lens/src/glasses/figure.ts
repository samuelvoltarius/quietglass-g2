import { createBitmap, drawPattern, MAX_LEVEL, type Bitmap } from "./bitmap";

/**
 * The little person in the header corner (64 x 30), seen from the side. The
 * more the head leans forward, the more the figure slumps: four steps from
 * straight to hunched. The picture is only sent when the step changes.
 *
 * Patterns are 11 x 9 cells drawn at 3x, which is 33 x 27 px.
 */

export const FIGURE_IMAGE = { id: 5, name: "figure", x: 576 - 64, y: 1, width: 64, height: 30 } as const;

export type FigureStage = 0 | 1 | 2 | 3;

const STAGES: Readonly<Record<FigureStage, readonly string[]>> = {
  // Straight: head over shoulders over hips.
  0: [
    "....##.....",
    "....##.....",
    "....#......",
    "....#......",
    "....#......",
    "....#......",
    "....##.....",
    "....#.#....",
    "...##.##...",
  ],
  // A little forward.
  1: [
    ".....##....",
    ".....##....",
    "....#......",
    "....#......",
    "....#......",
    "....#......",
    "....##.....",
    "....#.#....",
    "...##.##...",
  ],
  // Leaning: shoulders follow the head.
  2: [
    "......##...",
    "......##...",
    ".....#.....",
    "....#......",
    "....#......",
    "....#......",
    "....##.....",
    "....#.#....",
    "...##.##...",
  ],
  // Hunched: head hangs low in front of a rounded back.
  3: [
    "...........",
    "...........",
    ".......##..",
    ".....#.##..",
    "....#.#....",
    "...#..#....",
    "...##.#....",
    "....#.#....",
    "...##.##...",
  ],
};

/**
 * Stage for a lean of `angle` degrees against the warning angle: straight
 * well below it, leaning around it, hunched once clearly past it.
 */
export function figureStage(angle: number | null, warnAngle: number): FigureStage {
  if (angle === null || !Number.isFinite(angle) || !(warnAngle > 0)) return 0;
  const share = Math.max(0, angle) / warnAngle;
  if (share < 0.35) return 0;
  if (share < 0.75) return 1;
  if (share < 1.25) return 2;
  return 3;
}

/** Hysteresis against the stage shown now: it only moves once the angle is 5 % of the warning angle past a boundary. */
export function nextStage(previous: FigureStage | null, angle: number | null, warnAngle: number): FigureStage {
  const wanted = figureStage(angle, warnAngle);
  if (previous === null || previous === wanted || angle === null) return wanted;
  const slack = warnAngle * 0.05;
  const further = figureStage(angle + (wanted > previous ? -slack : slack), warnAngle);
  return further === wanted ? wanted : previous;
}

export interface FigureState {
  readonly stage: FigureStage;
  /** Leaning or warned: full brightness. */
  readonly alert: boolean;
}

export function figureKey(state: FigureState): string {
  return `fig:${state.stage}:${state.alert ? 1 : 0}`;
}

export function figurePattern(stage: FigureStage): readonly string[] {
  return STAGES[stage];
}

export function drawFigure(state: FigureState): Bitmap {
  const bitmap = createBitmap(FIGURE_IMAGE.width, FIGURE_IMAGE.height);
  const pattern = figurePattern(state.stage);
  const scale = 3;
  const x = Math.floor((bitmap.width - 11 * scale) / 2);
  const y = Math.floor((bitmap.height - pattern.length * scale) / 2);
  drawPattern(bitmap, pattern, x, y, scale, state.alert ? MAX_LEVEL : 9);
  return bitmap;
}
