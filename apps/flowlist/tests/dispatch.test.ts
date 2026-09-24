import { describe, it, expect } from "vitest";
import { dispatch } from "../src/input/dispatch";
import { startRun, complete } from "../src/checklist/run";
import type { Checklist, Step } from "../src/checklist/model";

const step = (id: string, over: Partial<Step> = {}): Step => ({
  id, text: "step " + id, kind: "normal", ...over,
});

const list = (...steps: Step[]): Checklist => ({ id: "l1", title: "L", steps });
const simple = list(step("a"), step("b"), step("c"));

describe("dispatch", () => {
  it("completes the step on a tap", () => {
    const result = dispatch(simple, startRun(simple), "click");
    expect(result.state.currentId).toBe("b");
  });

  it("leaves on a double tap", () => {
    expect(dispatch(simple, startRun(simple), "doubleClick").effects).toEqual([{ kind: "exit" }]);
  });

  it("goes back on swipe up", () => {
    const state = complete(simple, startRun(simple));
    expect(dispatch(simple, state, "scrollUp").state.currentId).toBe("a");
  });

  it("skips on swipe down only when the step allows it", () => {
    const optional = list(step("a", { kind: "optional" }), step("b"));
    expect(dispatch(optional, startRun(optional), "scrollDown").state.currentId).toBe("b");

    const state = startRun(simple);
    expect(dispatch(simple, state, "scrollDown").state).toBe(state);
  });

  it("turns both swipes into option movement on a choice step", () => {
    const branching = list(
      step("q", { kind: "choice", choices: [{ label: "Yes" }, { label: "No" }] }),
      step("after"),
    );
    const down = dispatch(branching, startRun(branching), "scrollDown").state;
    expect(down.choiceIndex).toBe(1);
    expect(down.currentId).toBe("q");

    const up = dispatch(branching, down, "scrollUp").state;
    expect(up.choiceIndex).toBe(0);
  });

  it("shows detail while held and hides it on release", () => {
    const state = startRun(simple);
    expect(dispatch(simple, state, "longPress").effects).toEqual([{ kind: "showDetail", on: true }]);
    expect(dispatch(simple, state, "longPressRelease").effects)
      .toEqual([{ kind: "showDetail", on: false }]);
  });

  it("does not change the run while showing detail", () => {
    const state = startRun(simple);
    expect(dispatch(simple, state, "longPress").state).toBe(state);
    expect(dispatch(simple, state, "longPressRelease").state).toBe(state);
  });

  it("needs two taps to pass a critical step", () => {
    const critical = list(step("a", { kind: "critical" }), step("b"));
    const armed = dispatch(critical, startRun(critical), "click").state;
    expect(armed.currentId).toBe("a");
    expect(armed.awaitingConfirm).toBe(true);

    expect(dispatch(critical, armed, "click").state.currentId).toBe("b");
  });

  it("cancels a pending confirmation with swipe up", () => {
    const critical = list(step("a", { kind: "critical" }), step("b"));
    const armed = dispatch(critical, startRun(critical), "click").state;
    const cancelled = dispatch(critical, armed, "scrollUp").state;
    expect(cancelled.awaitingConfirm).toBe(false);
    expect(cancelled.currentId).toBe("a");
  });
});
