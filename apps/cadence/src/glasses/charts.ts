import { positionAt, totalBeats, type MetronomeSettings, type MetronomeState } from "../metronome/engine";
import { DIM, FULL, createBitmap, drawText, fillRect, line, textWidth, type Bitmap } from "./gfx";

/** The big tempo number. */
export const BPM_WIDTH = 224;
export const BPM_HEIGHT = 72;
/** The pendulum. */
export const PENDULUM_WIDTH = 200;
export const PENDULUM_HEIGHT = 96;

/**
 * The pendulum is only drawn up to this tempo: one picture per beat has to
 * cross Bluetooth, and a beat shorter than half a second is more than the link
 * keeps up with. Above it the row of dots carries the beat, as before.
 */
export const PENDULUM_MAX_BPM = 120;
/** At or below this tempo a beat is long enough for a second picture (the swing through the middle). */
export const PENDULUM_MIDSWING_MAX_BPM = 60;

/** The tempo as large pixel digits with a small "BPM" beside them. Pure in the tempo. */
export function bpmFrame(bpm: number): Bitmap {
  const b = createBitmap(BPM_WIDTH, BPM_HEIGHT);
  const digits = String(Math.max(0, Math.round(Number.isFinite(bpm) ? bpm : 0)));
  const scale = 9;
  const width = drawText(b, digits, 2, 4, scale);
  const label = "BPM";
  const small = 3;
  drawText(b, label, Math.min(BPM_WIDTH - textWidth(label, small) - 2, 2 + width + 10), 4 + 7 * scale - 7 * small, small);
  return b;
}

/** -2 far left, -1 left, 0 upright, 1 right, 2 far right. */
export type Swing = -2 | -1 | 0 | 1 | 2;

/**
 * Where the pendulum is at `now`, or null when it is not drawn (too fast).
 * At each beat it stands at the far side, alternating left and right; for slow
 * tempi it passes through the middle half-way to the next beat. Stopped, it
 * hangs upright. Pure in (state, settings, now).
 */
export function pendulumSwing(state: MetronomeState, settings: MetronomeSettings, now: number): Swing | null {
  if (settings.bpm > PENDULUM_MAX_BPM) return null;
  if (!state.running) return 0;
  const side = totalBeats(state, settings, now) % 2 === 0 ? -1 : 1;
  const { phase } = positionAt(state, settings, now);
  if (settings.bpm <= PENDULUM_MIDSWING_MAX_BPM && phase >= 0.5) return 0;
  return (side * 2) as Swing;
}

const ANGLE = Math.PI / 6; // far position: 30 degrees from upright

/** One pendulum picture; null is an empty picture (the slot is blanked). */
export function pendulumFrame(swing: Swing | null): Bitmap {
  const b = createBitmap(PENDULUM_WIDTH, PENDULUM_HEIGHT);
  if (swing === null) return b;
  const cx = PENDULUM_WIDTH / 2;
  const pivotY = PENDULUM_HEIGHT - 12;
  const length = 78;
  // Base plate and the two far positions as dim marks.
  fillRect(b, cx - 28, PENDULUM_HEIGHT - 8, 56, 6, FULL);
  for (const far of [-1, 1]) {
    const x = cx + far * Math.sin(ANGLE) * length;
    const y = pivotY - Math.cos(ANGLE) * length;
    fillRect(b, x - 2, y - 2, 5, 5, DIM);
  }
  const angle = (swing / 2) * ANGLE;
  const tipX = cx + Math.sin(angle) * length;
  const tipY = pivotY - Math.cos(angle) * length;
  line(b, cx, pivotY, tipX, tipY, FULL, 3);
  // The weight sits a little below the tip.
  const wx = cx + Math.sin(angle) * length * 0.62;
  const wy = pivotY - Math.cos(angle) * length * 0.62;
  fillRect(b, wx - 8, wy - 7, 17, 15, FULL);
  fillRect(b, cx - 4, pivotY - 4, 9, 9, FULL);
  return b;
}
