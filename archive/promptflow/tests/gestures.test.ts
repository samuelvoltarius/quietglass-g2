import { describe, it, expect } from "vitest";
import {
  EVENT_CLICK, EVENT_DOUBLE_CLICK, EVENT_LONG_PRESS, EVENT_SCROLL_BOTTOM, EVENT_SCROLL_TOP,
  SOURCE_GLASSES_LEFT, SOURCE_GLASSES_RIGHT, SOURCE_RING,
  gestureFromCode, gestureFromEvent, sourceFromCode,
} from "../src/input/gestures";

describe("event code mapping", () => {
  it("maps the documented gesture codes", () => {
    expect(gestureFromCode(EVENT_CLICK)).toBe("click");
    expect(gestureFromCode(EVENT_DOUBLE_CLICK)).toBe("doubleClick");
    expect(gestureFromCode(EVENT_LONG_PRESS)).toBe("longPress");
  });

  it("maps scroll codes and can invert them for real hardware", () => {
    expect(gestureFromCode(EVENT_SCROLL_TOP)).toBe("scrollUp");
    expect(gestureFromCode(EVENT_SCROLL_TOP, { invertScroll: true })).toBe("scrollDown");
    expect(gestureFromCode(EVENT_SCROLL_BOTTOM, { invertScroll: true })).toBe("scrollUp");
  });

  it("returns null for unknown or missing codes", () => {
    expect(gestureFromCode(77)).toBeNull();
    expect(gestureFromCode(undefined)).toBeNull();
  });

  it("distinguishes the R1 ring from the temple pads", () => {
    expect(sourceFromCode(SOURCE_RING)).toBe("ring");
    expect(sourceFromCode(SOURCE_GLASSES_LEFT)).toBe("glassesLeft");
    expect(sourceFromCode(SOURCE_GLASSES_RIGHT)).toBe("glassesRight");
    expect(sourceFromCode(99)).toBe("unknown");
  });
});

describe("reading gestures out of SDK events", () => {
  it("reads a text container event", () => {
    expect(gestureFromEvent({ textEvent: { eventType: EVENT_CLICK, eventSource: SOURCE_RING } }))
      .toEqual({ gesture: "click", source: "ring" });
  });

  it("reads a list container event", () => {
    expect(gestureFromEvent({ listEvent: { eventType: EVENT_DOUBLE_CLICK } }))
      .toEqual({ gesture: "doubleClick", source: "unknown" });
  });

  it("accepts snake_case and string-encoded fields", () => {
    expect(gestureFromEvent({ sysEvent: { event_type: "0", event_source: "2" } }))
      .toEqual({ gesture: "click", source: "ring" });
  });

  it("ignores events that carry no usable gesture", () => {
    expect(gestureFromEvent(null)).toBeNull();
    expect(gestureFromEvent({})).toBeNull();
    expect(gestureFromEvent({ audioEvent: { audioPcm: new Uint8Array(2) } })).toBeNull();
    expect(gestureFromEvent({ textEvent: { eventType: 42 } })).toBeNull();
  });
});

describe("proto3 default-value omission", () => {
  it("reads a tap that arrives with no eventType at all", () => {
    // Verified against the real simulator: a tap produces exactly this, because
    // CLICK_EVENT is 0 and proto3 omits fields holding their default value.
    expect(gestureFromEvent({ sysEvent: { eventSource: 1 } }))
      .toEqual({ gesture: "click", source: "glassesRight" });
  });

  it("reads a tap from a text container with only a container id", () => {
    expect(gestureFromEvent({ textEvent: { containerID: 2 } })?.gesture).toBe("click");
  });

  it("still rejects an event with no container payload", () => {
    expect(gestureFromEvent({ jsonData: { eventSource: 1 } })).toBeNull();
  });

  it("keeps an explicit non-zero code intact", () => {
    expect(gestureFromEvent({ sysEvent: { eventType: 3 } })?.gesture).toBe("doubleClick");
  });
});
