import { describe, expect, it } from "vitest";
import { isFinalExit, lifecycleFromEvent } from "../src/lifecycle";
import { gestureFromEvent, resetGestureDedupe } from "../src/input/gestures";

describe("lifecycle events", () => {
  it("names the four system steps", () => {
    expect(lifecycleFromEvent({ sysEvent: { eventType: 4 } })).toBe("foregroundEnter");
    expect(lifecycleFromEvent({ sysEvent: { eventType: 5 } })).toBe("foregroundExit");
    expect(lifecycleFromEvent({ sysEvent: { eventType: 6 } })).toBe("abnormalExit");
    expect(lifecycleFromEvent({ sysEvent: { eventType: "7" } })).toBe("systemExit");
  });

  it("ignores gestures and other payloads", () => {
    expect(lifecycleFromEvent({ sysEvent: { eventSource: 1 } })).toBeNull();
    expect(lifecycleFromEvent({ sysEvent: { eventType: 3 } })).toBeNull();
    expect(lifecycleFromEvent({ textEvent: { eventType: 4 } })).toBeNull();
    expect(lifecycleFromEvent(null)).toBeNull();
  });

  it("a system step is never read as a tap", () => {
    resetGestureDedupe();
    for (const eventType of [4, 5, 6, 7]) expect(gestureFromEvent({ sysEvent: { eventType } })).toBeNull();
  });

  it("only 6 and 7 are final", () => {
    expect(isFinalExit("abnormalExit")).toBe(true);
    expect(isFinalExit("systemExit")).toBe(true);
    expect(isFinalExit("foregroundExit")).toBe(false);
    expect(isFinalExit(null)).toBe(false);
  });
});
