import { positionAt, totalBeats, type MetronomeSettings, type MetronomeState } from "../metronome/engine";

/**
 * The pendulum is only drawn up to this tempo: one picture per beat has to
 * cross Bluetooth, and a beat shorter than half a second is more than the link
 * keeps up with. Above it the row of dots carries the beat.
 */
export const PENDULUM_MAX_BPM = 120;
/** At or below this tempo a beat is long enough for a second picture (the swing through the middle). */
export const PENDULUM_MIDSWING_MAX_BPM = 60;

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
