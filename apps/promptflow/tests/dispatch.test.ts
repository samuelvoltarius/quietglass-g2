import { describe, it, expect } from "vitest";
import { dispatch, jumpToSection } from "../src/input/dispatch";
import { parseScript } from "../src/script/parse";
import { layoutScript } from "../src/prompter/layout";
import { initialPrompterState, lineAtWords, WPM_STEP } from "../src/prompter/engine";

const script = parseScript("# T\n\nalpha one two\n\n## Two\n\nbravo one two\n\n## Three\n\ncharlie one two");
const lines = layoutScript(script, { maxWidth: 40 });
const context = { script, lines };

describe("dispatch", () => {
  it("starts and stops on a tap", () => {
    const state = initialPrompterState("speech");
    const started = dispatch(state, "click", context).state;
    expect(started.running).toBe(true);
    expect(dispatch(started, "click", context).state.running).toBe(false);
  });

  it("leaves the app on a double tap", () => {
    expect(dispatch(initialPrompterState("speech"), "doubleClick", context).effects)
      .toEqual([{ kind: "exit" }]);
  });

  it("trims speed while running so the reader keeps their place", () => {
    const running = { ...initialPrompterState("speech"), running: true, wordsRead: 3 };
    const faster = dispatch(running, "scrollUp", context).state;
    expect(faster.wpm).toBe(running.wpm + WPM_STEP);
    expect(faster.wordsRead).toBe(3);

    expect(dispatch(running, "scrollDown", context).state.wpm).toBe(running.wpm - WPM_STEP);
  });

  it("moves through the script while paused", () => {
    const paused = initialPrompterState("speech");
    const forward = dispatch(paused, "scrollDown", { ...context, stepLines: 1 }).state;
    expect(lineAtWords(lines, forward.wordsRead)).toBe(1);

    const back = dispatch(forward, "scrollUp", { ...context, stepLines: 1 }).state;
    expect(lineAtWords(lines, back.wordsRead)).toBe(0);
  });

  it("does nothing on long-press release", () => {
    const state = initialPrompterState("speech");
    expect(dispatch(state, "longPressRelease", context).state).toBe(state);
  });
});

describe("section jumps", () => {
  it("moves forward to the next section", () => {
    const state = initialPrompterState("speech");
    const next = jumpToSection(state, script, lines, 1);
    expect(lines[lineAtWords(lines, next.wordsRead)]?.paragraph).toBe(1);
  });

  it("returns to the start of the current section before the previous one", () => {
    const atThird = jumpToSection(jumpToSection(initialPrompterState("speech"), script, lines, 1), script, lines, 1);
    expect(lines[lineAtWords(lines, atThird.wordsRead)]?.paragraph).toBe(2);

    const back = jumpToSection(atThird, script, lines, -1);
    expect(lines[lineAtWords(lines, back.wordsRead)]?.paragraph).toBe(1);
  });

  it("runs to the end when no section follows", () => {
    const last = jumpToSection(initialPrompterState("speech"), script, lines, 1);
    const end = jumpToSection(jumpToSection(last, script, lines, 1), script, lines, 1);
    expect(lineAtWords(lines, end.wordsRead)).toBe(lines.length - 1);
  });

  it("is a no-op on an empty script", () => {
    const state = initialPrompterState("speech");
    expect(jumpToSection(state, parseScript(""), [], 1)).toBe(state);
  });
});
