import { describe, it, expect } from "vitest";
import { buildView, formatDuration, HEADER_WIDTH, MAX_BODY_ROWS, truncate, wrap } from "../src/glasses/view";
import { complete, moveChoice, skip, startRun } from "../src/checklist/run";
import type { Checklist, Step } from "../src/checklist/model";

const step = (id: string, over: Partial<Step> = {}): Step => ({
  id, text: "step " + id, kind: "normal", ...over,
});

const list = (...steps: Step[]): Checklist => ({ id: "l1", title: "Pre-flight", steps });

const simple = list(step("a"), step("b"), step("c"));

describe("empty state", () => {
  it("points at the phone when nothing is loaded", () => {
    const empty = list();
    const view = buildView(empty, startRun(empty));
    expect(view.body.join(" ")).toContain("on your phone");
    expect(view.footer).toBe("Hold = help · 2× = exit");
    expect(buildView(empty, startRun(empty), { sideMenu: true }).footer).toBe("Hold = menu · 2× = exit");
  });
});

describe("running view", () => {
  it("shows the current step and its position", () => {
    const view = buildView(simple, startRun(simple));
    // The step is drawn as a picture; the body only supports it.
    expect(view.headline).toBe("step a");
    expect(view.body).not.toContain("step a");
    expect(view.header).toContain("1/3");
  });

  it("names the app and the position in the header, whatever the section is called (QIS v1)", () => {
    const sectioned = list(step("a", { section: "Camera" }));
    expect(buildView(sectioned, startRun(sectioned)).header).toBe("FLOWLIST · 1/1");
  });

  it("previews the next step when asked", () => {
    const view = buildView(simple, startRun(simple), { showNext: true });
    expect(view.body.join(" ")).toContain("next: step b");
  });

  it("omits the preview at the last step", () => {
    let state = startRun(simple);
    state = complete(simple, state);
    state = complete(simple, state);
    expect(buildView(simple, state, { showNext: true }).body.join(" ")).not.toContain("next:");
  });

  it("shows detail instead of the preview while held", () => {
    const detailed = list(step("a", { detail: "engine must be cold" }));
    const view = buildView(detailed, startRun(detailed), { showNext: true, showDetail: true });
    expect(view.body.join(" ")).toContain("engine must be cold");
    expect(view.body.join(" ")).not.toContain("next:");
  });
});

describe("critical steps", () => {
  const critical = list(step("a", { kind: "critical" }), step("b"));

  it("states plainly that a confirmation is pending", () => {
    const state = complete(critical, startRun(critical));
    const view = buildView(critical, state);
    expect(view.body[0]).toBe("CONFIRM:");
    expect(view.header).toBe("FLOWLIST · Confirm?");
    expect(view.footer).toBe("Tap again = confirm · Swipe/2× = cancel");
  });
});

describe("choice steps", () => {
  const branching = list(
    step("q", { kind: "choice", choices: [{ label: "Yes" }, { label: "No" }] }),
    step("after"),
  );

  it("lists the options and marks the highlighted one", () => {
    const view = buildView(branching, startRun(branching));
    expect(view.body).toContain("> Yes");
    expect(view.body).toContain("  No");
  });

  it("moves the marker with the highlight", () => {
    const view = buildView(branching, moveChoice(branching, startRun(branching), 1));
    expect(view.body).toContain("  Yes");
    expect(view.body).toContain("> No");
  });

  it("explains the swipe meaning for a choice", () => {
    expect(buildView(branching, startRun(branching)).footer).toContain("Swipe = choose");
  });
});

describe("optional steps", () => {
  it("without a side menu the footer offers back/skip on the swipe and help on the hold", () => {
    const optional = list(step("a", { kind: "optional" }));
    const footer = buildView(optional, startRun(optional)).footer;
    expect(footer).toContain("Swipe = back/skip");
    expect(footer).toContain("Hold = help");
  });

  it("with a side menu the footer points at the menu for help, going back and skipping (QIS v1.2)", () => {
    const optional = list(step("a", { kind: "optional" }));
    const footer = buildView(optional, startRun(optional), { sideMenu: true }).footer;
    expect(footer).toContain("Hold = menu");
    expect(footer).not.toContain("Swipe");
  });

  it("an armed step back asks for a second tap", () => {
    const view = buildView(simple, startRun(simple), { armed: "back" });
    expect(view.footer).toBe("Tap again = step back · Swipe/2× = cancel");
    expect(view.header).toBe("FLOWLIST · Back?");
  });
});

describe("finished view", () => {
  it("summarises the run", () => {
    const mixed = list(step("a"), step("b", { kind: "optional" }));
    let state = startRun(mixed, 0);
    state = complete(mixed, state, "done", 1000);
    state = skip(mixed, state, 5000);

    const view = buildView(mixed, state, {}, 9000);
    expect(view.headline).toBe("Complete.");
    expect(view.body.join(" ")).toContain("1 of 1 done");
    expect(view.body.join(" ")).toContain("1 skipped");
    expect(view.body.join(" ")).toContain("took 0:05");
  });

  it("offers the way out", () => {
    const one = list(step("a"));
    expect(buildView(one, complete(one, startRun(one))).footer).toContain("2× = exit");
  });
});

describe("text helpers", () => {
  it("wraps on word boundaries", () => {
    expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
  });

  it("keeps an over-long word rather than dropping it", () => {
    expect(wrap("supercalifragilistic", 5).join("")).toContain("supercalifragilistic");
  });

  it("returns nothing for blank text", () => {
    expect(wrap("   ", 10)).toEqual([]);
  });

  it("truncates with an ellipsis only when needed", () => {
    expect(truncate("short", 10)).toBe("short");
    // Trimming the trailing space may make it shorter; it must never be longer.
    expect(truncate("much too long here", 10).length).toBeLessThanOrEqual(10);
    expect(truncate("much too long here", 10).endsWith("…")).toBe(true);
  });

  it("formats durations with a padded remainder", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(-5)).toBe("0:00");
  });
});

describe("display budget", () => {
  const long = "word ".repeat(80).trim();
  const fits = (body: readonly string[], width = 56): void => {
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
    for (const row of body) expect(row.length).toBeLessThanOrEqual(width);
  };

  it("regression: a long step with its detail stays within seven rows", () => {
    const list: Checklist = { id: "x", title: "T", steps: [{ id: "a", text: long, kind: "critical", detail: long }] };
    const run = { ...startRun(list, 0), awaitingConfirm: true };
    const view = buildView(list, run, { showDetail: true }, 0);
    fits(view.body);
    expect(view.body[0]).toBe("CONFIRM:");
    expect(view.body.some((row) => row.endsWith("…"))).toBe(true);
  });

  it("regression: a long branch keeps the highlighted option in view", () => {
    const choices = Array.from({ length: 10 }, (_, i) => ({ label: "Option " + i }));
    const list: Checklist = { id: "x", title: "T", steps: [{ id: "a", text: long, kind: "choice", choices }] };
    const run = { ...startRun(list, 0), choiceIndex: 8 };
    const view = buildView(list, run, {}, 0);
    fits(view.body);
    expect(view.body).toContain("> Option 8");
  });

  it("regression: the next-step preview fits the line including its label", () => {
    const list: Checklist = { id: "x", title: "T", steps: [
      { id: "a", text: "Now", kind: "normal" },
      { id: "b", text: long, kind: "normal" },
    ] };
    fits(buildView(list, startRun(list, 0), { showNext: true }, 0).body);
  });

  it("regression: a long section name is cut to one header line", () => {
    const list: Checklist = { id: "x", title: "T", steps: [{ id: "a", text: "Go", kind: "normal", section: long }] };
    expect(buildView(list, startRun(list, 0), {}, 0).header.length).toBeLessThanOrEqual(HEADER_WIDTH);
  });

  it("regression: a pasted URL is split instead of running off the display", () => {
    const rows = wrap("see https://example.com/" + "x".repeat(80), 56);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(56);
    expect(rows.join("")).toContain("x".repeat(80));
  });
});

describe("big step picture", () => {
  const long = "word ".repeat(60).trim();

  it("keeps the step out of the body when the picture shows it whole", () => {
    const view = buildView(simple, startRun(simple), { headlineFits: () => true });
    expect(view.headline).toBe("step a");
    expect(view.body.join(" ")).not.toContain("step a");
  });

  it("repeats the full text in the body when the picture would have to cut it", () => {
    const one = list(step("a", { text: long }));
    const view = buildView(one, startRun(one), { headlineFits: () => false });
    expect(view.headline).toBe(long);
    expect(view.body.length).toBeGreaterThan(1);
    expect(view.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
    expect(view.body[0]).toContain("word word");
  });

  it("puts choices under the picture, up to four rows", () => {
    const pick = list(step("a", { kind: "choice", choices: Array.from({ length: 6 }, (_, i) => ({ label: `Option ${i}`, next: "end" })) }));
    const view = buildView(pick, startRun(pick), { headlineFits: () => true });
    expect(view.body).toHaveLength(4);
    expect(view.body[0]).toBe("> Option 0");
  });
});
