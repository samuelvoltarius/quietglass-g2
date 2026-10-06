import type { DisplayLine } from "./layout";

/**
 * Scroll position is tracked in *words read*, not in lines.
 *
 * A line holds a variable number of words, so advancing one line per fixed
 * interval makes the delivery speed drift with the wrapping. Counting words
 * keeps words-per-minute honest no matter how the text breaks.
 */

export type PrompterMode = "presenter" | "speech" | "video" | "notes";

export interface ModePreset {
  readonly wpm: number;
  readonly visibleLines: number;
  /** Lines kept above the current line, so the speaker sees what was just said. */
  readonly leadLines: number;
}

export const MODE_PRESETS: Readonly<Record<PrompterMode, ModePreset>> = {
  // Slides: the speaker improvises, the script is a safety net.
  presenter: { wpm: 110, visibleLines: 4, leadLines: 1 },
  // Read aloud verbatim, steady pace.
  speech: { wpm: 130, visibleLines: 5, leadLines: 1 },
  // To camera: fewer words on screen keeps the eyes still.
  video: { wpm: 145, visibleLines: 3, leadLines: 0 },
  // Manual reference, no auto-scroll.
  notes: { wpm: 0, visibleLines: 6, leadLines: 0 },
};

export const MIN_WPM = 60;
export const MAX_WPM = 260;
export const WPM_STEP = 10;

export interface PrompterState {
  readonly mode: PrompterMode;
  readonly wpm: number;
  readonly running: boolean;
  /** Fractional; fractional part is the progress through the current word. */
  readonly wordsRead: number;
}

export function initialPrompterState(mode: PrompterMode = "speech"): PrompterState {
  return {
    mode,
    wpm: MODE_PRESETS[mode].wpm,
    running: false,
    wordsRead: 0,
  };
}

/** Cumulative word count before a line — the inverse of `lineAtWords`. */
export function wordsBeforeLine(lines: readonly DisplayLine[], lineIndex: number): number {
  let total = 0;
  const end = Math.max(0, Math.min(lineIndex, lines.length));
  for (let i = 0; i < end; i++) total += lines[i]?.words ?? 0;
  return total;
}

export function totalWords(lines: readonly DisplayLine[]): number {
  return wordsBeforeLine(lines, lines.length);
}

/** The line currently being spoken for a given word offset. */
export function lineAtWords(lines: readonly DisplayLine[], wordsRead: number): number {
  if (lines.length === 0) return 0;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const words = lines[i]?.words ?? 0;
    // A line with no words (blank) must not swallow the position.
    if (wordsRead < seen + Math.max(words, 1)) return i;
    seen += words;
  }
  return lines.length - 1;
}

/** Advances by elapsed time. Returns the state unchanged when paused or at the end. */
export function tick(
  state: PrompterState,
  lines: readonly DisplayLine[],
  elapsedMs: number,
): PrompterState {
  if (!state.running || state.wpm <= 0 || elapsedMs <= 0) return state;

  const limit = totalWords(lines);
  const advanced = state.wordsRead + (state.wpm * elapsedMs) / 60_000;
  const wordsRead = Math.min(advanced, limit);

  if (wordsRead === state.wordsRead) return state;
  // Reaching the end stops the scroll rather than spinning at the limit.
  return wordsRead >= limit
    ? { ...state, wordsRead: limit, running: false }
    : { ...state, wordsRead };
}

export function toggleRunning(state: PrompterState): PrompterState {
  // Notes mode has no auto-scroll to start.
  if (state.wpm <= 0) return state;
  return { ...state, running: !state.running };
}

export function setRunning(state: PrompterState, running: boolean): PrompterState {
  if (state.wpm <= 0) return { ...state, running: false };
  return state.running === running ? state : { ...state, running };
}

export function adjustWpm(state: PrompterState, delta: number): PrompterState {
  const wpm = clamp(state.wpm + delta, MIN_WPM, MAX_WPM);
  return wpm === state.wpm ? state : { ...state, wpm };
}

export function setMode(state: PrompterState, mode: PrompterMode): PrompterState {
  const preset = MODE_PRESETS[mode];
  return { ...state, mode, wpm: preset.wpm, running: false };
}

/** Jumps so that `lineIndex` becomes the current line. */
export function jumpToLine(
  state: PrompterState,
  lines: readonly DisplayLine[],
  lineIndex: number,
): PrompterState {
  const clamped = clamp(lineIndex, 0, Math.max(0, lines.length - 1));
  return { ...state, wordsRead: wordsBeforeLine(lines, clamped) };
}

export function jumpLines(
  state: PrompterState,
  lines: readonly DisplayLine[],
  delta: number,
): PrompterState {
  return jumpToLine(state, lines, lineAtWords(lines, state.wordsRead) + delta);
}

export function restart(state: PrompterState): PrompterState {
  return { ...state, wordsRead: 0, running: false };
}

/** 0…1 for a progress indicator. */
export function progress(state: PrompterState, lines: readonly DisplayLine[]): number {
  const limit = totalWords(lines);
  if (limit <= 0) return 0;
  return clamp(state.wordsRead / limit, 0, 1);
}

/** Remaining time at the current speed, in seconds; null when not scrolling. */
export function remainingSeconds(state: PrompterState, lines: readonly DisplayLine[]): number | null {
  if (state.wpm <= 0) return null;
  const left = Math.max(0, totalWords(lines) - state.wordsRead);
  return Math.round((left / state.wpm) * 60);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
