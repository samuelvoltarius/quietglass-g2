import { describe, it, expect } from "vitest";
import {
  back, complete, currentStep, elapsedSeconds, isFinished, moveChoice,
  positionOf, progress, skip, startRun,
} from "../src/checklist/run";
import type { Checklist, Step } from "../src/checklist/model";

const step = (id: string, over: Partial<Step> = {}): Step => ({
  id, text: "step " + id, kind: "normal", ...over,
});

const list = (...steps: Step[]): Checklist => ({ id: "l1", title: "List", steps });

const simple = list(step("a"), step("b"), step("c"));

describe("starting a run", () => {
  it("begins at the first step", () => {
    const state = startRun(simple);
    expect(state.currentId).toBe("a");
    expect(isFinished(state)).toBe(false);
    expect(positionOf(simple, state)).toBe(1);
  });

  it("is immediately finished for an empty checklist", () => {
    const state = startRun(list());
    expect(isFinished(state)).toBe(true);
    expect(state.finishedAt).not.toBeNull();
  });
});

describe("completing steps", () => {
  it("walks forward and records each step as done", () => {
    let state = startRun(simple);
    state = complete(simple, state);
    expect(state.currentId).toBe("b");
    expect(state.status["a"]).toBe("done");
  });

  it("finishes after the last step", () => {
    let state = startRun(simple);
    state = complete(simple, state);
    state = complete(simple, state);
    state = complete(simple, state);
    expect(isFinished(state)).toBe(true);
    expect(state.finishedAt).not.toBeNull();
    expect(positionOf(simple, state)).toBe(0);
  });

  it("does nothing once the run is over", () => {
    const one = list(step("a"));
    const finished = complete(one, startRun(one));
    expect(isFinished(finished)).toBe(true);
    expect(complete(one, finished)).toBe(finished);
  });

  it("returns no current step when finished", () => {
    const one = list(step("a"));
    expect(currentStep(one, complete(one, startRun(one)))).toBeNull();
  });
});

describe("critical steps", () => {
  const critical = list(step("a", { kind: "critical" }), step("b"));

  it("asks once before accepting", () => {
    let state = startRun(critical);
    state = complete(critical, state);
    expect(state.awaitingConfirm).toBe(true);
    expect(state.currentId).toBe("a");

    state = complete(critical, state);
    expect(state.currentId).toBe("b");
    expect(state.status["a"]).toBe("done");
  });

  it("cancels the confirmation on back instead of leaving the step", () => {
    let state = complete(critical, startRun(critical));
    expect(state.awaitingConfirm).toBe(true);

    state = back(critical, state);
    expect(state.awaitingConfirm).toBe(false);
    expect(state.currentId).toBe("a");
  });
});

describe("optional steps", () => {
  const withOptional = list(step("a", { kind: "optional" }), step("b"));

  it("can be skipped", () => {
    const state = skip(withOptional, startRun(withOptional));
    expect(state.status["a"]).toBe("skipped");
    expect(state.currentId).toBe("b");
  });

  it("refuses to skip a required step", () => {
    const state = startRun(simple);
    expect(skip(simple, state)).toBe(state);
  });

  it("is left out of the progress denominator", () => {
    const state = startRun(withOptional);
    expect(progress(withOptional, state).total).toBe(1);
  });
});

describe("going back", () => {
  it("returns to the previous step and clears its status", () => {
    let state = complete(simple, startRun(simple));
    state = back(simple, state);
    expect(state.currentId).toBe("a");
    expect(state.status["a"]).toBeUndefined();
  });

  it("does nothing at the very first step", () => {
    const state = startRun(simple);
    expect(back(simple, state)).toBe(state);
  });

  it("can reopen a finished run", () => {
    let state = startRun(list(step("a")));
    state = complete(list(step("a")), state);
    expect(isFinished(state)).toBe(true);

    state = back(list(step("a")), state);
    expect(isFinished(state)).toBe(false);
    expect(state.finishedAt).toBeNull();
  });
});

describe("branching", () => {
  const branching = list(
    step("start", {
      kind: "choice",
      choices: [{ label: "Yes", goto: "yes" }, { label: "No", goto: "no" }],
    }),
    step("yes"),
    step("no"),
    step("end"),
  );

  it("follows the highlighted choice", () => {
    const state = complete(branching, startRun(branching));
    expect(state.currentId).toBe("yes");
  });

  it("follows a different choice after moving the highlight", () => {
    let state = moveChoice(branching, startRun(branching), 1);
    expect(state.choiceIndex).toBe(1);
    state = complete(branching, state);
    expect(state.currentId).toBe("no");
  });

  it("wraps the highlight around both ends", () => {
    const state = startRun(branching);
    expect(moveChoice(branching, state, -1).choiceIndex).toBe(1);
    expect(moveChoice(branching, moveChoice(branching, state, 1), 1).choiceIndex).toBe(0);
  });

  it("ignores highlight moves on a plain step", () => {
    const state = startRun(simple);
    expect(moveChoice(simple, state, 1)).toBe(state);
  });

  it("falls through in order when a jump target does not exist", () => {
    const broken = list(
      step("start", { kind: "choice", choices: [{ label: "Go", goto: "nowhere" }] }),
      step("next"),
    );
    expect(complete(broken, startRun(broken)).currentId).toBe("next");
  });

  it("goes back to where the user actually came from, not list order", () => {
    let state = complete(branching, moveChoice(branching, startRun(branching), 1));
    expect(state.currentId).toBe("no");
    state = back(branching, state);
    expect(state.currentId).toBe("start");
  });
});

describe("progress and timing", () => {
  it("counts done and skipped separately", () => {
    const mixed = list(step("a"), step("b", { kind: "optional" }), step("c"));
    let state = startRun(mixed);
    state = complete(mixed, state);
    state = skip(mixed, state);

    const p = progress(mixed, state);
    expect(p.done).toBe(1);
    expect(p.skipped).toBe(1);
    expect(p.total).toBe(2);
    expect(p.fraction).toBe(0.5);
  });

  it("reports a complete fraction for an empty checklist", () => {
    expect(progress(list(), startRun(list())).fraction).toBe(1);
  });

  it("stops the clock when the run finishes", () => {
    const one = list(step("a"));
    const state = complete(one, startRun(one, 1_000), "done", 4_000);
    expect(elapsedSeconds(state, 99_000)).toBe(3);
  });

  it("keeps counting while the run is open", () => {
    const state = startRun(simple, 1_000);
    expect(elapsedSeconds(state, 6_000)).toBe(5);
  });
});
