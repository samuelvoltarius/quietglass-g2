import { describe, it, expect } from "vitest";
import { buildView, formatDuration, truncate, wrap } from "../src/glasses/view";
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
    expect(view.body.join(" ")).toContain("phone app");
  });
});

describe("running view", () => {
  it("shows the current step and its position", () => {
    const view = buildView(simple, startRun(simple));
    expect(view.body[0]).toBe("step a");
    expect(view.header).toContain("1/3");
  });

  it("uses the section as the header when the step has one", () => {
    const sectioned = list(step("a", { section: "Camera" }));
    expect(buildView(sectioned, startRun(sectioned)).header).toContain("Camera");
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
    expect(view.footer).toContain("tap again = confirm");
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
    expect(buildView(branching, startRun(branching)).footer).toContain("swipe = choose");
  });
});

describe("optional steps", () => {
  it("advertises that skipping is allowed", () => {
    const optional = list(step("a", { kind: "optional" }));
    expect(buildView(optional, startRun(optional)).footer).toContain("skip");
  });
});

describe("finished view", () => {
  it("summarises the run", () => {
    const mixed = list(step("a"), step("b", { kind: "optional" }));
    let state = startRun(mixed, 0);
    state = complete(mixed, state, "done", 1000);
    state = skip(mixed, state, 5000);

    const view = buildView(mixed, state, {}, 9000);
    expect(view.body[0]).toBe("Complete.");
    expect(view.body.join(" ")).toContain("1 of 1 done");
    expect(view.body.join(" ")).toContain("1 skipped");
    expect(view.footer).toContain("0:05");
  });

  it("offers the way out", () => {
    const one = list(step("a"));
    expect(buildView(one, complete(one, startRun(one))).footer).toContain("exit");
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
