import { describe, expect, it } from "vitest";
import {
  CONFIRM_WINDOW_MS, INITIAL_CONTROL, PAGES, RESULT_MS, cancelControl, controlBusy, controlItems, expireControl, followMode, itemAction,
  moveCursor, pagesFor, startPageFor, stepPage, tapControl, type ControlState,
} from "../src/pages";
import { NO_CONTROL, type Control } from "../src/car/model";
import { createDemo } from "../src/car/demo";

const FULL: Control = { enabled: true, lock: true, unlock: true, preheat: true, preheatMinutes: [10, 15, 20, 25, 30], carOff: true };

describe("pages", () => {
  it("the start page follows the mode", () => {
    expect(startPageFor("driving")).toBe("drive");
    expect(startPageFor("charging")).toBe("charge");
    expect(startPageFor("parked")).toBe("status");
  });

  it("swiping walks the pages and wraps; the control page only when the bridge accepts commands", () => {
    let page = PAGES[0]!;
    const seen = [page];
    for (let i = 0; i < 3; i += 1) { page = stepPage(page, 1); seen.push(page); }
    expect(seen).toEqual(["drive", "charge", "status", "drive"]);
    expect(stepPage("drive", -1)).toBe("status");
    expect(stepPage("status", 1, true)).toBe("control");
    expect(stepPage("control", 1, true)).toBe("drive");
    expect(stepPage("drive", -1, true)).toBe("control");
    expect(pagesFor(false)).not.toContain("control");
    // A control page left over from an older state never traps the user.
    expect(stepPage("control", 1, false)).toBe("charge");
  });

  it("a mode change moves to its page unless the user is busy on the control page", () => {
    expect(followMode("parked", "driving", "status")).toBe("drive");
    expect(followMode("driving", "driving", "status")).toBe("status");
    expect(followMode("parked", "charging", "drive")).toBe("charge");
    expect(followMode(null, "parked", "drive")).toBe("status");
    expect(followMode("parked", "charging", "control", true)).toBe("control");
    expect(followMode("parked", "charging", "control", false)).toBe("charge");
  });
});

describe("control list", () => {
  it("offers exactly lock, unlock, preheat 10/20/30 - only what the bridge accepts; never climate off", () => {
    expect(controlItems(FULL)).toEqual(["lock", "unlock", "preheat10", "preheat20", "preheat30"]);
    expect(controlItems({ ...FULL, unlock: false, preheat: false })).toEqual(["lock"]);
    expect(controlItems({ ...FULL, preheatMinutes: [10, 30] })).toEqual(["lock", "unlock", "preheat10", "preheat30"]);
    expect(controlItems(NO_CONTROL)).toEqual([]);
    expect(controlItems({ ...FULL, enabled: false })).toEqual([]);
    expect(itemAction("preheat20")).toEqual({ action: "preheat", minutes: 20 });
    expect(itemAction("unlock")).toEqual({ action: "unlock", minutes: null });
  });

  const items = controlItems(FULL);

  it("first tap asks the bridge, second tap within 4 s confirms, later it does not", () => {
    expect(tapControl(INITIAL_CONTROL, 0, items)).toEqual({ kind: "arm", item: "lock" });
    const armed: ControlState = { ...INITIAL_CONTROL, armed: { item: "unlock", token: "t1", until: 1_000 + CONFIRM_WINDOW_MS } };
    expect(tapControl(armed, 1_000 + CONFIRM_WINDOW_MS, items)).toEqual({ kind: "confirm", item: "unlock", token: "t1" });
    // Too late: a new tap starts over (asks again), it never sends.
    expect(tapControl({ ...armed, cursor: 1 }, 1_001 + CONFIRM_WINDOW_MS, items)).toEqual({ kind: "arm", item: "unlock" });
    // While a request runs, taps do nothing.
    expect(tapControl({ ...armed, busy: { item: "lock", step: "arm" } }, 1_500, items)).toEqual({ kind: "none" });
    expect(tapControl(INITIAL_CONTROL, 0, [])).toEqual({ kind: "none" });
  });

  it("a swipe in a question cancels it (never confirms, never leaves); otherwise it moves and leaves past the ends", () => {
    const armed: ControlState = { ...INITIAL_CONTROL, cursor: 2, armed: { item: "preheat10", token: "t", until: 5_000 } };
    const moved = moveCursor(armed, 1, items.length, 1_000);
    expect(moved.leave).toBe(0);
    expect(moved.state.armed).toBeNull();
    expect(moved.state.cursor).toBe(2);
    expect(moveCursor(INITIAL_CONTROL, 1, items.length, 0).state.cursor).toBe(1);
    expect(moveCursor(INITIAL_CONTROL, -1, items.length, 0).leave).toBe(-1);
    expect(moveCursor({ ...INITIAL_CONTROL, cursor: 4 }, 1, items.length, 0).leave).toBe(1);
  });

  it("2x cancels an open question; without one it means leave", () => {
    const armed: ControlState = { ...INITIAL_CONTROL, armed: { item: "lock", token: "t", until: 5_000 } };
    expect(cancelControl(armed, 1_000)?.armed).toBeNull();
    expect(cancelControl(INITIAL_CONTROL, 1_000)).toBeNull();
    expect(cancelControl(armed, 6_000)).toBeNull();
  });

  it("an unanswered question lapses into 'not sent'; results go away after a while", () => {
    const armed: ControlState = { ...INITIAL_CONTROL, armed: { item: "lock", token: "t", until: 5_000 } };
    expect(expireControl(armed, 5_000)).toBe(armed);
    const lapsed = expireControl(armed, 5_001);
    expect(lapsed.armed).toBeNull();
    expect(lapsed.result).toEqual({ item: "lock", kind: "lapsed", at: 5_001 });
    expect(expireControl(lapsed, 5_001 + RESULT_MS + 1).result).toBeNull();
    expect(controlBusy(armed, 1_000)).toBe(true);
    expect(controlBusy(INITIAL_CONTROL, 100_000)).toBe(false);
  });

  it("the demo offers no control and never sends", async () => {
    const demo = createDemo(() => 0, "parked");
    expect((await demo.state(null, 0)).control.enabled).toBe(false);
    expect((await demo.arm("lock", null)).ok).toBe(false);
    expect((await demo.confirm("lock", null, "x")).ok).toBe(false);
  });
});
