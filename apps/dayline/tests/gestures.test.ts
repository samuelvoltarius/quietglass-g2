import { describe, expect, it } from "vitest";
import { EVENT_CLICK, EVENT_DOUBLE_CLICK, EVENT_LONG_PRESS_RELEASE, EVENT_SCROLL_BOTTOM, EVENT_SCROLL_TOP, SOURCE_GLASSES_LEFT, SOURCE_RING, gestureFromCode, gestureFromEvent, sourceFromCode } from "../src/input/gestures";

describe("gestures", () => {
  it("maps scroll codes and inverts them on request", () => {
    expect(gestureFromCode(EVENT_SCROLL_TOP)).toBe("scrollUp");
    expect(gestureFromCode(EVENT_SCROLL_BOTTOM)).toBe("scrollDown");
    expect(gestureFromCode(EVENT_SCROLL_TOP, { invertScroll: true })).toBe("scrollDown");
  });
  it("maps the remaining codes and rejects unknown ones", () => {
    expect([EVENT_CLICK, EVENT_DOUBLE_CLICK, EVENT_LONG_PRESS_RELEASE].map((code) => gestureFromCode(code))).toEqual(["click", "doubleClick", "longPressRelease"]);
    expect(gestureFromCode(42)).toBeNull();
    expect(sourceFromCode(SOURCE_GLASSES_LEFT)).toBe("glassesLeft");
    expect(sourceFromCode(undefined)).toBe("unknown");
  });
  it("reads a proto3 tap with no eventType as a click", () => {
    expect(gestureFromEvent({ sysEvent: { eventSource: 1 } })).toEqual({ gesture: "click", source: "glassesRight" });
  });
  it("reads snake_case and string fields", () => {
    expect(gestureFromEvent({ textEvent: { event_type: "3", event_source: String(SOURCE_RING) } })).toEqual({ gesture: "doubleClick", source: "ring" });
  });
  it("ignores events without a gesture payload", () => {
    expect(gestureFromEvent(undefined)).toBeNull();
    expect(gestureFromEvent({ audioEvent: {} })).toBeNull();
    expect(gestureFromEvent({ textEvent: { eventType: 99 } })).toBeNull();
  });
});
