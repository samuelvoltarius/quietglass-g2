/**
 * Metronome timing.
 *
 * Position is derived from elapsed time, never accumulated per tick. A
 * counter incremented on each redraw would drift with every dropped or late
 * frame; computing "where should we be at time t" is immune to that, so a
 * stalled BLE link makes the display late but never wrong.
 */

export const MIN_BPM = 30;
export const MAX_BPM = 240;

export interface TimeSignature {
  /** Beats per bar. */
  readonly beats: number;
  /** Note value that gets the beat: 4 = quarter, 8 = eighth. */
  readonly unit: number;
}

export const COMMON_SIGNATURES: readonly TimeSignature[] = [
  { beats: 4, unit: 4 },
  { beats: 3, unit: 4 },
  { beats: 2, unit: 4 },
  { beats: 6, unit: 8 },
  { beats: 5, unit: 4 },
  { beats: 7, unit: 8 },
];

export interface MetronomeSettings {
  readonly bpm: number;
  readonly signature: TimeSignature;
  /**
   * `beat` marks every beat, `bar` marks only the downbeat.
   *
   * Over BLE each display update costs tens of milliseconds and the jitter is
   * not controllable, so marking every beat becomes unreliable as the tempo
   * rises. Marking the bar stays readable at any tempo and is what a player
   * actually needs — the beats in between are felt, not read.
   */
  readonly mark: "beat" | "bar";
}

export const DEFAULT_SETTINGS: MetronomeSettings = {
  bpm: 100,
  signature: { beats: 4, unit: 4 },
  mark: "beat",
};

export interface MetronomeState {
  readonly running: boolean;
  /** Timestamp the current run started; null while stopped. */
  readonly startedAt: number | null;
  /** Beats completed in previous runs, so pausing does not lose the count. */
  readonly beatsBefore: number;
}

export function createState(): MetronomeState {
  return { running: false, startedAt: null, beatsBefore: 0 };
}

export function msPerBeat(bpm: number): number {
  return 60_000 / clampBpm(bpm);
}

export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return DEFAULT_SETTINGS.bpm;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
}

export function start(state: MetronomeState, now: number): MetronomeState {
  if (state.running) return state;
  return { ...state, running: true, startedAt: now };
}

export function stop(state: MetronomeState, settings: MetronomeSettings, now: number): MetronomeState {
  if (!state.running || state.startedAt === null) return state;
  return {
    running: false,
    startedAt: null,
    beatsBefore: state.beatsBefore + elapsedBeats(state, settings, now),
  };
}

export function toggle(state: MetronomeState, settings: MetronomeSettings, now: number): MetronomeState {
  return state.running ? stop(state, settings, now) : start(state, now);
}

export function reset(): MetronomeState {
  return createState();
}

/** Whole beats elapsed in the current run. */
function elapsedBeats(state: MetronomeState, settings: MetronomeSettings, now: number): number {
  if (state.startedAt === null) return 0;
  const elapsed = Math.max(0, now - state.startedAt);
  return Math.floor(elapsed / msPerBeat(settings.bpm));
}

/** Total beats counted since the last reset, across pauses. */
export function totalBeats(state: MetronomeState, settings: MetronomeSettings, now: number): number {
  return state.beatsBefore + elapsedBeats(state, settings, now);
}

export interface Position {
  /** 1-based beat within the bar. */
  readonly beat: number;
  /** 1-based bar number since the last reset. */
  readonly bar: number;
  /** True on the first beat of a bar. */
  readonly downbeat: boolean;
  /** 0…1 through the current beat, for a progress indicator. */
  readonly phase: number;
}

export function positionAt(
  state: MetronomeState,
  settings: MetronomeSettings,
  now: number,
): Position {
  const beats = totalBeats(state, settings, now);
  const perBar = Math.max(1, Math.round(settings.signature.beats));
  const beat = (beats % perBar) + 1;
  const bar = Math.floor(beats / perBar) + 1;

  let phase = 0;
  if (state.running && state.startedAt !== null) {
    const period = msPerBeat(settings.bpm);
    phase = ((now - state.startedAt) % period) / period;
  }

  return { beat, bar, downbeat: beat === 1, phase };
}

/**
 * Milliseconds until the next beat boundary, so the caller can schedule a
 * redraw on the beat instead of polling at a fixed rate.
 */
export function msToNextBeat(
  state: MetronomeState,
  settings: MetronomeSettings,
  now: number,
): number {
  if (!state.running || state.startedAt === null) return msPerBeat(settings.bpm);
  const period = msPerBeat(settings.bpm);
  const since = (now - state.startedAt) % period;
  return period - since;
}

/** Tap tempo: turns a series of tap timestamps into a bpm. */
export function bpmFromTaps(taps: readonly number[]): number | null {
  if (taps.length < 2) return null;
  // Only recent taps: an old one left over from a previous attempt would skew
  // the average badly.
  const recent = taps.slice(-5);
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const previous = recent[i - 1];
    const current = recent[i];
    if (previous === undefined || current === undefined) continue;
    const gap = current - previous;
    if (gap > 0 && gap < 4000) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return clampBpm(60_000 / mean);
}
