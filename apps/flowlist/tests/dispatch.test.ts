import { describe, it, expect } from "vitest";
import { dispatch, dispatchMenu, MENU } from "../src/input/dispatch";
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

  it("with a side menu a swipe never goes back, skips or arms anything (QIS v1.2): it only moves on a question", () => {
    const state = complete(simple, startRun(simple));
    for (const gesture of ["scrollUp", "scrollDown"] as const) {
      expect(dispatch(simple, state, gesture, null, true), gesture).toEqual({ state, effects: [] });
    }
    const optional = list(step("a", { kind: "optional" }), step("b"));
    const start = startRun(optional);
    for (const gesture of ["scrollUp", "scrollDown"] as const) {
      expect(dispatch(optional, start, gesture, null, true), gesture).toEqual({ state: start, effects: [] });
    }
  });

  it("without a side menu a swipe only arms: up = step back (not at the first step), down = skip (optional steps only)", () => {
    const state = complete(simple, startRun(simple));
    expect(dispatch(simple, state, "scrollUp")).toEqual({ state, effects: [{ kind: "arm", action: "back" }] });
    expect(dispatch(simple, startRun(simple), "scrollUp").effects).toEqual([]);
    expect(dispatch(simple, state, "scrollDown")).toEqual({ state, effects: [] });
    const optional = list(step("a", { kind: "optional" }), step("b"));
    const start = startRun(optional);
    expect(dispatch(optional, start, "scrollDown")).toEqual({ state: start, effects: [{ kind: "arm", action: "skip" }] });
    // Nothing changes until the confirming tap.
    expect(dispatch(simple, state, "click", "back").state.currentId).toBe("a");
    expect(dispatch(optional, start, "click", "skip").state.currentId).toBe("b");
  });

  it("menu: Step back is armed first; a tap or a second click of the item carries it out (QIS v1.2)", () => {
    const state = complete(simple, startRun(simple));
    expect(state.currentId).toBe("b");
    const asked = dispatchMenu(simple, state, MENU.back);
    expect(asked.state).toBe(state);
    expect(asked.effects).toEqual([{ kind: "arm", action: "back" }]);
    // a single tap while armed
    const byTap = dispatch(simple, state, "click", "back");
    expect(byTap.state.currentId).toBe("a");
    expect(byTap.effects).toEqual([{ kind: "arm", action: null }]);
    // the same menu item again
    const byMenu = dispatchMenu(simple, state, MENU.back, "back");
    expect(byMenu.state.currentId).toBe("a");
    expect(byMenu.effects).toEqual([{ kind: "arm", action: null }]);
    // swipe, 2× and hold cancel without a change
    for (const gesture of ["scrollUp", "scrollDown", "doubleClick", "longPress"] as const) {
      expect(dispatch(simple, state, gesture, "back"), gesture).toEqual({ state, effects: [{ kind: "arm", action: null }] });
    }
  });

  it("menu: nothing to step back to at the first step, and none while a confirmation is pending", () => {
    const first = startRun(simple);
    expect(dispatchMenu(simple, first, MENU.back)).toEqual({ state: first, effects: [] });
    const critical = list(step("a", { kind: "critical" }), step("b"));
    const confirming = dispatch(critical, startRun(critical), "click").state;
    expect(dispatchMenu(critical, confirming, MENU.back)).toEqual({ state: confirming, effects: [] });
  });

  it("menu: Skip step works on optional steps only, armed first (QIS v1.2)", () => {
    const optional = list(step("a", { kind: "optional" }), step("b"));
    const start = startRun(optional);
    const asked = dispatchMenu(optional, start, MENU.skip);
    expect(asked.state).toBe(start);
    expect(asked.effects).toEqual([{ kind: "arm", action: "skip" }]);
    const skipped = dispatch(optional, start, "click", "skip");
    expect(skipped.state.currentId).toBe("b");
    expect(skipped.state.status["a"]).toBe("skipped");
    expect(skipped.effects).toEqual([{ kind: "arm", action: null }]);
    expect(dispatchMenu(optional, start, MENU.skip, "skip").state.status["a"]).toBe("skipped");
    const state = startRun(simple);
    expect(dispatchMenu(simple, state, MENU.skip)).toEqual({ state, effects: [] });
  });

  it("menu: Help opens the help, Info shows the detail only where there is one", () => {
    const detailed = list(step("a", { detail: "engine must be cold" }), step("b"));
    expect(dispatchMenu(simple, startRun(simple), MENU.help).effects).toEqual([{ kind: "help" }]);
    expect(dispatchMenu(detailed, startRun(detailed), MENU.info).effects).toEqual([{ kind: "showDetail", on: true }]);
    expect(dispatchMenu(simple, startRun(simple), MENU.info).effects).toEqual([]);
  });

  it("cancels an armed action on swipe, 2× or hold, without exiting and without a change", () => {
    const optional = list(step("a", { kind: "optional" }), step("b"));
    const start = startRun(optional);
    for (const gesture of ["scrollUp", "scrollDown", "doubleClick", "longPress"] as const) {
      expect(dispatch(optional, start, gesture, "skip"), gesture).toEqual({ state: start, effects: [{ kind: "arm", action: null }] });
    }
  });

  it("asks before it starts a finished list over", () => {
    let state = startRun(simple);
    for (let i = 0; i < 3; i += 1) state = dispatch(simple, state, "click").state;
    expect(state.currentId).toBeNull();
    expect(dispatch(simple, state, "click")).toEqual({ state, effects: [{ kind: "arm", action: "restart" }] });
    expect(dispatch(simple, state, "click", "restart").state.currentId).toBe("a");
    expect(dispatch(simple, state, "doubleClick", "restart").effects).toEqual([{ kind: "arm", action: null }]);
  });

  it("2× and swipe down cancel a pending confirmation instead of leaving the app", () => {
    const critical = list(step("a", { kind: "critical" }), step("b"));
    const armed = dispatch(critical, startRun(critical), "click").state;
    for (const gesture of ["doubleClick", "scrollDown", "scrollUp"] as const) {
      const result = dispatch(critical, armed, gesture);
      expect(result.state.awaitingConfirm, gesture).toBe(false);
      expect(result.state.currentId, gesture).toBe("a");
      expect(result.effects, gesture).toEqual([]);
    }
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
    const detailed = list(step("a", { detail: "engine must be cold" }));
    const state = startRun(detailed);
    expect(dispatch(detailed, state, "longPress").effects).toEqual([{ kind: "showDetail", on: true }]);
    expect(dispatch(detailed, state, "longPressRelease").effects)
      .toEqual([{ kind: "showDetail", on: false }]);
  });

  it("a hold on a step without detail opens the help; with a side menu it does nothing (help lives there)", () => {
    expect(dispatch(simple, startRun(simple), "longPress").effects).toEqual([{ kind: "help" }]);
    expect(dispatch(simple, startRun(simple), "longPress", null, true).effects).toEqual([]);
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
