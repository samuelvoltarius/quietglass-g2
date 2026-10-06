import { describe, expect, it } from "vitest";
import { EVENT_CLICK, EVENT_DOUBLE_CLICK, EVENT_LONG_PRESS, EVENT_LONG_PRESS_RELEASE, EVENT_SCROLL_BOTTOM, EVENT_SCROLL_TOP, SOURCE_RING, gestureFromCode, gestureFromEvent, sourceFromCode } from "../src/input/gestures";

describe("gestures", () => {
  it("maps push-to-talk codes", () => {
    expect(gestureFromCode(EVENT_LONG_PRESS)).toBe("longPress");
    expect(gestureFromCode(EVENT_LONG_PRESS_RELEASE)).toBe("longPressRelease");
    expect(gestureFromCode(EVENT_DOUBLE_CLICK)).toBe("doubleClick");
  });
  it("inverts scroll only when asked", () => {
    expect(gestureFromCode(EVENT_SCROLL_TOP)).toBe("scrollUp");
    expect(gestureFromCode(EVENT_SCROLL_BOTTOM, { invertScroll: true })).toBe("scrollUp");
  });
  it("treats a sysEvent without eventType as a tap", () => { expect(gestureFromEvent({ sysEvent: { eventSource: 1 } })).toEqual({ gesture: "click", source: "glassesRight" }); });
  it("reads string-encoded codes", () => { expect(gestureFromEvent({ textEvent: { eventType: String(EVENT_CLICK), eventSource: String(SOURCE_RING) } })).toEqual({ gesture: "click", source: "ring" }); });
  it("ignores audio frames and junk", () => {
    expect(gestureFromEvent({ audioEvent: { audioPcm: new Uint8Array(4) } })).toBeNull();
    expect(gestureFromEvent(null)).toBeNull();
    expect(gestureFromEvent({ textEvent: { eventType: 42 } })).toBeNull();
    expect(sourceFromCode(undefined)).toBe("unknown");
  });
});
