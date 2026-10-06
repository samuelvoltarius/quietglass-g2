import { describe, expect, it } from "vitest";
import { EVENT_DOUBLE_CLICK, EVENT_SCROLL_BOTTOM, EVENT_SCROLL_TOP, SOURCE_RING, gestureFromCode, gestureFromEvent } from "../src/input/gestures";

describe("gestures", () => {
  it("maps scroll codes and can invert them", () => {
    expect(gestureFromCode(EVENT_SCROLL_BOTTOM)).toBe("scrollDown");
    expect(gestureFromCode(EVENT_SCROLL_TOP, { invertScroll: true })).toBe("scrollDown");
  });
  it("treats a container event without eventType as a click (proto3 default)", () => {
    expect(gestureFromEvent({ sysEvent: { eventSource: 1 } })).toEqual({ gesture: "click", source: "glassesRight" });
  });
  it("reads string codes and ignores unknown or empty events", () => {
    expect(gestureFromEvent({ textEvent: { eventType: String(EVENT_DOUBLE_CLICK), eventSource: SOURCE_RING } })).toEqual({ gesture: "doubleClick", source: "ring" });
    expect(gestureFromEvent({ textEvent: { eventType: 77 } })).toBeNull();
    expect(gestureFromEvent(null)).toBeNull();
    expect(gestureFromEvent({ other: {} })).toBeNull();
  });
});
