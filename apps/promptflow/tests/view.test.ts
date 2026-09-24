import { describe, it, expect } from "vitest";
import { buildView, formatDuration } from "../src/glasses/view";
import { parseScript } from "../src/script/parse";
import { layoutScript } from "../src/prompter/layout";
import { initialPrompterState, jumpToLine, setMode } from "../src/prompter/engine";
import { EMPTY_SCRIPT } from "../src/script/model";

/** Blank line between paragraphs. */
const BREAK = "\n\n";

const script = parseScript(
  ["# Talk", "line one here", "## Middle", "line two here", "line three here"].join(BREAK),
);
const lines = layoutScript(script, { maxWidth: 40 });

describe("buildView", () => {
  it("invites setup when no script is loaded", () => {
    const view = buildView(EMPTY_SCRIPT, [], initialPrompterState("speech"));
    expect(view.body.join(" ")).toContain("phone app");
    expect(view.footer).toBe("");
  });

  it("shows the script title before any section starts", () => {
    expect(buildView(script, lines, initialPrompterState("speech")).header).toBe("Talk");
  });

  it("switches the header to the current section", () => {
    const state = jumpToLine(initialPrompterState("speech"), lines, 1);
    expect(buildView(script, lines, state).header).toBe("Middle");
  });

  it("shows only as many lines as the mode allows", () => {
    expect(buildView(script, lines, initialPrompterState("video")).body).toHaveLength(3);
  });

  it("honours an explicit line count from the phone settings", () => {
    expect(buildView(script, lines, initialPrompterState("speech"), { visibleLines: 2 }).body)
      .toHaveLength(2);
  });

  it("keeps the window inside the script at the end", () => {
    const state = jumpToLine(initialPrompterState("speech"), lines, lines.length - 1);
    const view = buildView(script, lines, state, { visibleLines: 2 });
    expect(view.body).toHaveLength(2);
    expect(view.body.at(-1)).toContain("three");
  });

  it("adds no cursor by default and marks the spoken line when asked", () => {
    const state = jumpToLine(initialPrompterState("speech"), lines, 1);
    expect(buildView(script, lines, state).body.some((l) => l.startsWith(">"))).toBe(false);

    // This script is shorter than the window, so it stays anchored at the top
    // and the cursor marks line 1 in place rather than scrolling it up.
    const marked = buildView(script, lines, state, { showCursor: true, leadLines: 0 });
    expect(marked.body[1]?.startsWith("> ")).toBe(true);
    expect(marked.body[0]?.startsWith("  ")).toBe(true);
  });

  it("states paused and reading distinctly", () => {
    const paused = initialPrompterState("speech");
    expect(buildView(script, lines, paused).footer).toContain("PAUSED");
    expect(buildView(script, lines, { ...paused, running: true }).footer).toContain("READING");
  });

  it("labels notes mode instead of a transport state and hides the speed", () => {
    const footer = buildView(script, lines, setMode(initialPrompterState("speech"), "notes")).footer;
    expect(footer).toContain("NOTES");
    expect(footer).not.toContain("wpm");
  });

  it("reports progress as a percentage", () => {
    expect(buildView(script, lines, initialPrompterState("speech")).footer).toContain("0%");
  });
});

describe("scrolling window", () => {
  const paragraphs = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const long = parseScript(["# T", ...paragraphs].join(BREAK));
  const longLines = layoutScript(long, { maxWidth: 40 });

  it("scrolls the window once the script outgrows it", () => {
    const state = jumpToLine(initialPrompterState("speech"), longLines, 10);
    const view = buildView(long, longLines, state, { visibleLines: 3, leadLines: 1 });
    expect(view.body).toEqual(["line 9", "line 10", "line 11"]);
  });

  it("keeps the lead line above the spoken one", () => {
    const state = jumpToLine(initialPrompterState("speech"), longLines, 5);
    const view = buildView(long, longLines, state, { visibleLines: 3, leadLines: 1, showCursor: true });
    expect(view.body[1]).toBe("> line 5");
  });

  it("clamps at the very start where there is no lead", () => {
    const state = jumpToLine(initialPrompterState("speech"), longLines, 0);
    const view = buildView(long, longLines, state, { visibleLines: 3, leadLines: 1 });
    expect(view.body[0]).toBe("line 0");
  });
});

describe("formatDuration", () => {
  it("formats minutes and seconds with a padded remainder", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(600)).toBe("10:00");
  });

  it("never renders a negative time", () => {
    expect(formatDuration(-10)).toBe("0:00");
  });
});
