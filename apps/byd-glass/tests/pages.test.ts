import { describe, expect, it } from "vitest";
import { deriveRaw } from "../src/car/derive";
import { demoTelemetry } from "../src/car/demo";
import { parseState } from "../src/car/model";
import {
  ARM_MS, CONFIRM_MS, CONTROL_ITEMS, INITIAL_CONTROL, PAGES, TEMP_MAX, TEMP_MIN, cancelConfirm, controlBusy, expireConfirm, followMode,
  moveCursor, startPageFor, stepPage, tapControl, type ControlState, type TapResult,
} from "../src/pages";
import type { CarState } from "../src/car/model";

const car = (scene: "parked" | "drive" | "charge") => parseState({
  ...deriveRaw(demoTelemetry(scene, 1_000), 1, {}),
  rev: 1,
  control: { enabled: true, lock: true, unlock: true, climate_temp: true },
});
const ALL = { enabled: true, lock: true, unlock: true };
const at = (item: string, extra: Partial<ControlState> = {}): ControlState => ({ ...INITIAL_CONTROL, cursor: CONTROL_ITEMS.indexOf(item as never), ...extra });

describe("pages", () => {
  it("the start page follows the mode", () => {
    expect(startPageFor("driving")).toBe("drive");
    expect(startPageFor("charging")).toBe("charge");
    expect(startPageFor("parked")).toBe("status");
  });

  it("swiping walks all pages and wraps", () => {
    let page = PAGES[0]!;
    const seen = [page];
    for (let i = 0; i < PAGES.length; i += 1) { page = stepPage(page, 1); seen.push(page); }
    expect(seen).toEqual(["drive", "charge", "status", "control", "drive"]);
    expect(stepPage("drive", -1)).toBe("control");
  });

  it("a mode change moves to its page, but not away from a busy control page", () => {
    expect(followMode("parked", "driving", "status", false)).toBe("drive");
    expect(followMode("driving", "driving", "status", false)).toBe("status");
    expect(followMode("parked", "charging", "control", true)).toBe("control");
    expect(followMode("parked", "charging", "control", false)).toBe("charge");
    expect(followMode(null, "parked", "drive", false)).toBe("status");
  });
});

const on = (c: CarState): CarState => ({ ...c, carOn: true });

/** Taps through the flow at the given times; returns every result. */
function taps(start: ControlState, times: number[], c: CarState | null = car("parked")): TapResult[] {
  const out: TapResult[] = [];
  let s = start;
  for (const now of times) { const r = tapControl(s, now, c, ALL); out.push(r); s = r.state; }
  return out;
}

describe("control list", () => {
  it("lists exactly the four commands, lock and unlock first (temperature is chosen inside climate on)", () => {
    expect(CONTROL_ITEMS).toEqual(["lock", "unlock", "climate_on", "climate_off"]);
  });

  it("swipes move the cursor and leave at either end", () => {
    let r = moveCursor(INITIAL_CONTROL, -1);
    expect(r.leave).toBe(-1);
    r = moveCursor(at("climate_off"), 1);
    expect(r.leave).toBe(1);
    r = moveCursor(INITIAL_CONTROL, 1);
    expect(r).toEqual({ state: { ...INITIAL_CONTROL, cursor: 1 }, leave: 0 });
  });

  for (const item of ["lock", "unlock", "climate_off"] as const) {
    it(`${item}: question, pause, final confirmation – only then one send`, () => {
      const [first, second, early, third, after] = taps(at(item), [0, 1_000, 1_500, 2_000 + ARM_MS, 2_100 + ARM_MS]);
      expect(first).toMatchObject({ kind: "asked", state: { confirm: { item, step: "first" } } });
      expect(second).toMatchObject({ kind: "asked", state: { confirm: { item, step: "final", armedAt: 1_000 + ARM_MS } } });
      // A tap inside the pause does nothing at all.
      expect(early!.kind).toBe("none");
      expect(early!.state.confirm?.step).toBe("final");
      expect(third).toMatchObject({ kind: "send", action: item, value: null });
      expect(third!.state.confirm).toBeNull();
      // The next tap starts over instead of sending again.
      expect(after!.kind).toBe("asked");
    });
  }

  it("never sends with fewer than both confirmations, however fast the taps come", () => {
    for (const item of CONTROL_ITEMS) {
      const results = taps(at(item), [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
      expect(results.some((r) => r.kind === "send")).toBe(false);
    }
  });

  it("climate on: temperature step first, swipe ±1 °C, then two confirmations with that temperature", () => {
    const opened = tapControl(at("climate_on", { temp: 21 }), 0, car("parked"), ALL);
    expect(opened).toMatchObject({ kind: "asked", state: { confirm: { item: "climate_on", step: "temp" } } });
    // Swipe up = warmer, down = cooler; the cursor and page stay.
    let m = moveCursor(opened.state, -1, 100);
    m = moveCursor(m.state, -1, 200);
    expect(m.leave).toBe(0);
    expect(m.state.temp).toBe(23);
    m = moveCursor(m.state, 1, 300);
    expect(m.state.temp).toBe(22);
    const results = taps(m.state, [400, 500, 500 + ARM_MS]);
    expect(results.map((r) => r.kind)).toEqual(["asked", "asked", "send"]);
    expect(results[2]).toMatchObject({ action: "climate_on", value: 22 });
  });

  it("the temperature stays within 16–28 °C", () => {
    let s = tapControl(at("climate_on", { temp: 27 }), 0, car("parked"), ALL).state;
    for (let i = 0; i < 5; i += 1) s = moveCursor(s, -1, i).state;
    expect(s.temp).toBe(TEMP_MAX);
    for (let i = 0; i < 20; i += 1) s = moveCursor(s, 1, 10 + i).state;
    expect(s.temp).toBe(TEMP_MIN);
  });

  it("a swipe on a question cancels it (QIS v1) and neither leaves nor confirms", () => {
    for (const step of [0, 1]) {
      const asked = taps(at("lock"), [0, 100]).at(step)!.state;
      expect(asked.confirm).not.toBeNull();
      const r = moveCursor(asked, 1, 200);
      expect(r.leave).toBe(0);
      expect(r.state.confirm).toBeNull();
      // After the cancel a tap starts at the first question again; nothing was sent.
      expect(tapControl(r.state, 300, car("parked"), ALL)).toMatchObject({ kind: "asked", state: { confirm: { step: "first" } } });
    }
  });

  it("double tap cancels at every step; without a question it means leave", () => {
    const steps = taps(at("climate_on"), [0, 100, 200]);
    for (const r of steps) {
      const cancelled = cancelConfirm(r.state, 300);
      expect(cancelled?.confirm).toBeNull();
      // After cancelling, a tap starts at the beginning again.
      expect(tapControl(cancelled!, 400, car("parked"), ALL).state.confirm?.step).toBe("temp");
    }
    expect(cancelConfirm(INITIAL_CONTROL, 100)).toBeNull();
  });

  it("a step that runs out closes; a late tap starts over instead of sending", () => {
    const [, final] = taps(at("lock"), [0, 1_000]);
    const late = 1_000 + CONFIRM_MS + 1;
    expect(tapControl(final!.state, late, car("parked"), ALL)).toMatchObject({ kind: "asked", state: { confirm: { step: "first" } } });
    expect(expireConfirm(final!.state, late).confirm).toBeNull();
  });

  it("car on: every item is blocked, nothing is asked or sent", () => {
    for (const item of CONTROL_ITEMS) {
      const results = taps(at(item), [0, 100, 200 + ARM_MS, 300 + ARM_MS], on(car("parked")));
      for (const r of results) expect(r).toMatchObject({ kind: "blocked", reason: "car_on" });
    }
  });

  it("car switched on mid-flow: the final tap is refused and the question closes", () => {
    const [, final] = taps(at("unlock"), [0, 100]);
    expect(final!.state.confirm?.step).toBe("final");
    expect(tapControl(final!.state, 100 + ARM_MS, on(car("parked")), ALL)).toMatchObject({ kind: "blocked", reason: "car_on", state: { confirm: null } });
    expect(expireConfirm(final!.state, 200, on(car("parked"))).confirm).toBeNull();
  });

  it("unlock is refused while driving and when the bridge does not allow it", () => {
    expect(tapControl(at("unlock"), 0, car("drive"), ALL)).toMatchObject({ kind: "blocked", reason: "notParked" });
    expect(tapControl(at("unlock"), 0, car("parked"), { ...ALL, unlock: false })).toMatchObject({ kind: "blocked", reason: "notSetUp" });
    expect(tapControl(at("lock"), 0, car("parked"), { ...ALL, lock: false })).toMatchObject({ kind: "blocked", reason: "notSetUp" });
    expect(tapControl(at("climate_on"), 0, car("parked"), { ...ALL, enabled: false })).toMatchObject({ kind: "blocked", reason: "readOnly" });
    expect(tapControl(at("climate_on"), 0, null, ALL)).toMatchObject({ kind: "blocked", reason: "noData" });
  });

  it("parses car_on from the bridge; anything but true is off", () => {
    expect(parseState({ mode: "parked", car_on: true }).carOn).toBe(true);
    expect(parseState({ mode: "parked", car_on: "true" }).carOn).toBe(false);
    expect(parseState({ mode: "parked" }).carOn).toBe(false);
  });

  it("the control page counts as busy right after a tap", () => {
    const touched = tapControl(at("lock"), 10_000, car("parked"), ALL);
    const cancelled = cancelConfirm(touched.state, 10_000)!;
    expect(controlBusy(cancelled, 20_000)).toBe(true);
    expect(controlBusy(cancelled, 50_000)).toBe(false);
  });
});
