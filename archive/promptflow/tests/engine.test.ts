import { describe, it, expect } from "vitest";
import { parseScript } from "../src/script/parse";
import { layoutScript, type DisplayLine } from "../src/prompter/layout";
import {
  adjustWpm, initialPrompterState, jumpLines, jumpToLine, lineAtWords,
  MAX_WPM, MIN_WPM, MODE_PRESETS, progress, remainingSeconds, restart,
  setMode, setRunning, tick, toggleRunning, totalWords, wordsBeforeLine,
} from "../src/prompter/engine";

/** Four lines of three words each: 12 words total. */
const lines: DisplayLine[] = [0, 1, 2, 3].map((i) => ({
  text: "one two three", paragraph: i, paragraphStart: true, words: 3,
}));

describe("word accounting", () => {
  it("sums words before a line", () => {
    expect(wordsBeforeLine(lines, 0)).toBe(0);
    expect(wordsBeforeLine(lines, 2)).toBe(6);
    expect(totalWords(lines)).toBe(12);
  });

  it("clamps an out-of-range line instead of throwing", () => {
    expect(wordsBeforeLine(lines, -5)).toBe(0);
    expect(wordsBeforeLine(lines, 99)).toBe(12);
  });

  it("maps a word offset back to its line", () => {
    expect(lineAtWords(lines, 0)).toBe(0);
    expect(lineAtWords(lines, 3)).toBe(1);
    expect(lineAtWords(lines, 11.9)).toBe(3);
  });

  it("does not stall on a line that holds no words", () => {
    const withBlank: DisplayLine[] = [
      { text: "", paragraph: 0, paragraphStart: true, words: 0 },
      { text: "a b", paragraph: 1, paragraphStart: true, words: 2 },
    ];
    expect(lineAtWords(withBlank, 0)).toBe(0);
    expect(lineAtWords(withBlank, 1)).toBe(1);
  });

  it("returns line 0 for an empty script", () => {
    expect(lineAtWords([], 5)).toBe(0);
  });
});

describe("tick", () => {
  it("does not move while paused", () => {
    const state = initialPrompterState("speech");
    expect(tick(state, lines, 1000)).toBe(state);
  });

  it("advances exactly words-per-minute over time", () => {
    // 120 wpm = 2 words per second.
    const state = { ...initialPrompterState("speech"), wpm: 120, running: true };
    expect(tick(state, lines, 1000).wordsRead).toBeCloseTo(2, 6);
    expect(tick(state, lines, 3000).wordsRead).toBeCloseTo(6, 6);
  });

  it("keeps pace regardless of how the text wraps", () => {
    // Same 12 words as one long line must take the same time as four short ones.
    const oneLine: DisplayLine[] = [{ text: "x", paragraph: 0, paragraphStart: true, words: 12 }];
    const state = { ...initialPrompterState("speech"), wpm: 60, running: true };
    expect(tick(state, oneLine, 60_000).wordsRead).toBe(tick(state, lines, 60_000).wordsRead);
  });

  it("stops at the end instead of running past it", () => {
    const state = { ...initialPrompterState("speech"), wpm: 600, running: true };
    const done = tick(state, lines, 10_000);
    expect(done.wordsRead).toBe(12);
    expect(done.running).toBe(false);
  });

  it("ignores non-positive elapsed time", () => {
    const state = { ...initialPrompterState("speech"), running: true };
    expect(tick(state, lines, 0)).toBe(state);
    expect(tick(state, lines, -50)).toBe(state);
  });

  it("never scrolls in notes mode", () => {
    const state = { ...initialPrompterState("notes"), running: true };
    expect(tick(state, lines, 5000)).toBe(state);
  });
});

describe("transport controls", () => {
  it("toggles running", () => {
    const state = initialPrompterState("speech");
    expect(toggleRunning(state).running).toBe(true);
    expect(toggleRunning(toggleRunning(state)).running).toBe(false);
  });

  it("refuses to start notes mode, which has no auto-scroll", () => {
    expect(toggleRunning(initialPrompterState("notes")).running).toBe(false);
    expect(setRunning(initialPrompterState("notes"), true).running).toBe(false);
  });

  it("clamps speed to the supported band", () => {
    const state = initialPrompterState("speech");
    expect(adjustWpm({ ...state, wpm: MIN_WPM }, -100).wpm).toBe(MIN_WPM);
    expect(adjustWpm({ ...state, wpm: MAX_WPM }, 100).wpm).toBe(MAX_WPM);
  });

  it("applies a mode preset and pauses on switch", () => {
    const state = { ...initialPrompterState("speech"), running: true };
    const video = setMode(state, "video");
    expect(video.wpm).toBe(MODE_PRESETS.video.wpm);
    expect(video.running).toBe(false);
  });

  it("jumps to a line and clamps out-of-range targets", () => {
    const state = initialPrompterState("speech");
    expect(jumpToLine(state, lines, 2).wordsRead).toBe(6);
    expect(jumpToLine(state, lines, 99).wordsRead).toBe(9);
    expect(jumpToLine(state, lines, -3).wordsRead).toBe(0);
  });

  it("jumps relative to the current line", () => {
    const state = jumpToLine(initialPrompterState("speech"), lines, 2);
    expect(jumpLines(state, lines, -1).wordsRead).toBe(3);
    expect(jumpLines(state, lines, 1).wordsRead).toBe(9);
  });

  it("restarts to the top, paused", () => {
    const state = { ...initialPrompterState("speech"), wordsRead: 7, running: true };
    expect(restart(state)).toMatchObject({ wordsRead: 0, running: false });
  });
});

describe("readouts", () => {
  it("reports progress as a fraction", () => {
    const state = initialPrompterState("speech");
    expect(progress(state, lines)).toBe(0);
    expect(progress({ ...state, wordsRead: 6 }, lines)).toBe(0.5);
    expect(progress(state, [])).toBe(0);
  });

  it("estimates the remaining seconds at the current speed", () => {
    const state = { ...initialPrompterState("speech"), wpm: 120, wordsRead: 0 };
    expect(remainingSeconds(state, lines)).toBe(6);
  });

  it("gives no estimate when nothing is scrolling", () => {
    expect(remainingSeconds(initialPrompterState("notes"), lines)).toBeNull();
  });
});

describe("realistic script", () => {
  it("lays out and paces a parsed script end to end", () => {
    const script = parseScript("# Talk\n\n" + "word ".repeat(100));
    const laid = layoutScript(script, { maxWidth: 40 });
    const state = { ...initialPrompterState("speech"), wpm: 100, running: true };
    // 100 words at 100 wpm is one minute.
    expect(remainingSeconds(state, laid)).toBe(60);
    expect(tick(state, laid, 30_000).wordsRead).toBeCloseTo(50, 5);
  });
});
