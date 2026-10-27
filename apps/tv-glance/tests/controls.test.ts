import { afterEach, describe, expect, it, vi } from "vitest";
import { createPowerArm, createVolumeStepper, POWER_ARM_MS, VOLUME_MAX_BURST, VOLUME_SETTLE_MS } from "../src/tv/controls";
import { EVENT_SCROLL_BOTTOM, EVENT_SCROLL_TOP, gestureFromEvent, resetGestureDedupe } from "../src/input/gestures";

afterEach(() => { vi.useRealTimers(); });

describe("volume swipes are debounced into one burst", () => {
  it("three quick swipes up send +3 once, after the settle time", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const stepper = createVolumeStepper((steps) => sent.push(steps));
    stepper.step(1);
    vi.advanceTimersByTime(100);
    stepper.step(1);
    vi.advanceTimersByTime(100);
    stepper.step(1);
    expect(stepper.pending()).toBe(3);
    vi.advanceTimersByTime(VOLUME_SETTLE_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([3]);
    expect(stepper.pending()).toBe(0);
  });

  it("up and down cancel out and send nothing; a pause starts a new burst", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const stepper = createVolumeStepper((steps) => sent.push(steps));
    stepper.step(1);
    stepper.step(-1);
    vi.advanceTimersByTime(VOLUME_SETTLE_MS + 10);
    expect(sent).toEqual([]);
    stepper.step(-1);
    vi.advanceTimersByTime(VOLUME_SETTLE_MS + 10);
    stepper.step(-1);
    vi.advanceTimersByTime(VOLUME_SETTLE_MS + 10);
    expect(sent).toEqual([-1, -1]);
  });

  it("a long series is capped so the TV is never blasted", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const stepper = createVolumeStepper((steps) => sent.push(steps));
    for (let i = 0; i < 20; i += 1) stepper.step(1);
    vi.advanceTimersByTime(VOLUME_SETTLE_MS + 10);
    expect(sent).toEqual([VOLUME_MAX_BURST]);
  });

  it("cancel drops what is waiting", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const stepper = createVolumeStepper((steps) => sent.push(steps));
    stepper.step(1);
    stepper.cancel();
    vi.advanceTimersByTime(VOLUME_SETTLE_MS + 10);
    expect(sent).toEqual([]);
  });

  it("the gesture layer already folds the 5-10 scroll events of one physical swipe into one", () => {
    resetGestureDedupe();
    const events = Array.from({ length: 6 }, () => gestureFromEvent({ sysEvent: { eventType: EVENT_SCROLL_TOP, eventSource: 1 } }));
    expect(events.filter(Boolean).map((e) => e!.gesture)).toEqual(["scrollUp"]);
    resetGestureDedupe();
    expect(gestureFromEvent({ sysEvent: { eventType: EVENT_SCROLL_BOTTOM, eventSource: 1 } })?.gesture).toBe("scrollDown");
    resetGestureDedupe();
    expect(gestureFromEvent({ sysEvent: { eventType: EVENT_SCROLL_BOTTOM, eventSource: 1 } }, { invertScroll: true })?.gesture).toBe("scrollUp");
  });
});

describe("switching off needs a second tap within 4 s", () => {
  it("first tap arms, second tap in time confirms", () => {
    const arm = createPowerArm();
    expect(arm.tap(1_000)).toBe(false);
    expect(arm.armed(1_000 + POWER_ARM_MS)).toBe(true);
    expect(arm.tap(1_000 + 3_000)).toBe(true);
    expect(arm.armed(1_000 + 3_001)).toBe(false);
  });

  it("a second tap after the window only arms again", () => {
    const arm = createPowerArm();
    arm.tap(0);
    expect(arm.armed(POWER_ARM_MS + 1)).toBe(false);
    expect(arm.tap(POWER_ARM_MS + 1)).toBe(false);
    expect(arm.tap(POWER_ARM_MS + 500)).toBe(true);
  });

  it("disarm cancels", () => {
    const arm = createPowerArm();
    arm.tap(0);
    arm.disarm();
    expect(arm.tap(100)).toBe(false);
  });
});
