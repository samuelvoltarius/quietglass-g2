/**
 * The moth.
 *
 * LUMEN's whole idea is that a creature gets tired when you stop photographing
 * and never dies. On a phone that is an illustration; on glasses it is the
 * thing you actually see, so it has to read at a glance in monochrome green at
 * 576 x 288 — and it has to look tired when it is tired, without a caption
 * explaining that it is.
 *
 * Five states, matching LUMEN's own thresholds in config.KREATUR.
 */

export type MothState = "leuchtet" | "wach" | "matt" | "schläfrig" | "eingerollt";

/** LUMEN's thresholds, lowest bound first when read bottom-up. */
const THRESHOLDS: ReadonlyArray<readonly [number, MothState]> = [
  [80, "leuchtet"],
  [55, "wach"],
  [32, "matt"],
  [14, "schläfrig"],
  [0, "eingerollt"],
];

export function stateForLight(light: number): MothState {
  for (const [threshold, state] of THRESHOLDS) {
    if (light >= threshold) return state;
  }
  return "eingerollt";
}

/**
 * The moth, drawn in text.
 *
 * Wings open wide when it is thriving and fold inward as the light runs out.
 * The shape alone carries the state — the name below it is confirmation, not
 * the message.
 */
const SHAPES: Readonly<Record<MothState, readonly string[]>> = {
  // Wide open, in motion, with light coming off it.
  leuchtet: [
    " \\\\\\  ***  ///",
    "  \\\\\\ (o) ///",
    "   ===={ }====",
    "  ///  |||  \\\\\\",
  ],
  // Open and steady.
  wach: [
    "  \\\\\\  .  ///",
    "   ==={o}===",
    "  ///  |  \\\\\\",
  ],
  // Half folded.
  matt: [
    "   \\\\ . //",
    "   =={o}==",
    "   //  \\\\",
  ],
  // Folded together, barely moving.
  "schläfrig": [
    "    \\\\.//",
    "    =(-)=",
  ],
  // Curled up, waiting. It does not leave.
  eingerollt: [
    "     (~)",
  ],
};

export function drawMoth(state: MothState): readonly string[] {
  return SHAPES[state] ?? SHAPES.eingerollt;
}

/**
 * What LUMEN itself says the moth is doing. Passed through rather than
 * reinvented, so the glasses and the web app never disagree.
 */
export function mothLine(state: MothState, gesture: string | null): string {
  return gesture ? state + " — " + gesture : state;
}

/** 0…100, clamped, for the light meter. */
export function clampLight(light: number): number {
  if (!Number.isFinite(light)) return 0;
  return Math.min(100, Math.max(0, light));
}

/**
 * A bar for the light level.
 *
 * Deliberately coarse: the exact number is not actionable, but "nearly empty"
 * versus "full" is, and a bar reads faster than digits at a glance.
 */
export function lightBar(light: number, width = 10): string {
  const value = clampLight(light);
  const filled = Math.round((value / 100) * width);
  return "[" + "#".repeat(filled) + "-".repeat(Math.max(0, width - filled)) + "]";
}
