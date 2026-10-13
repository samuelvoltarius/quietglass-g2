import type { Temperature } from "./status";

/** The nozzle curve shows this much history. */
export const CURVE_WINDOW_MS = 5 * 60 * 1000;

/** More than the window can hold at the fastest poll rate; a hard cap against a runaway clock. */
const MAX_SAMPLES = 400;

export interface TempSample {
  /** When the reading arrived, in ms. */
  readonly t: number;
  readonly now: number;
  readonly target: number;
}

/**
 * The nozzle temperature of the last five minutes, one sample per status
 * reply. Only replies add samples, so a redraw never changes the curve.
 */
export class TempHistory {
  #samples: TempSample[] = [];

  add(t: number, nozzle: Temperature | null): void {
    if (nozzle === null) return;
    // A clock that went backwards must not leave samples from the "future" behind.
    this.#samples = this.#samples.filter((sample) => sample.t <= t);
    this.#samples.push({ t, now: nozzle.now, target: nozzle.target });
    this.#samples = this.#samples.filter((sample) => t - sample.t <= CURVE_WINDOW_MS).slice(-MAX_SAMPLES);
  }

  samples(): readonly TempSample[] {
    return this.#samples;
  }

  clear(): void {
    this.#samples = [];
  }
}

/** A heat-up and a steady hold, for the demo and for tests: one sample every 5 s, ending at `end`. */
export function demoTempSamples(end: number, count = 60): TempSample[] {
  const out: TempSample[] = [];
  for (let i = 0; i < count; i += 1) {
    const heat = Math.min(1, i / 20);
    const wobble = i > 20 ? Math.round(2.2 * Math.sin(i * 0.9)) : 0;
    out.push({ t: end - (count - 1 - i) * 5_000, now: Math.round(30 + heat * 190) + wobble, target: 220 });
  }
  return out;
}
