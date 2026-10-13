import { describe, expect, it } from "vitest";
import { lifecycleFromEvent } from "../src/lifecycle";

describe("lifecycleFromEvent", () => {
  it("maps the system events 4-7", () => {
    expect(lifecycleFromEvent({ sysEvent: { eventType: 4 } })).toBe("foreground");
    expect(lifecycleFromEvent({ sysEvent: { eventType: 5 } })).toBe("background");
    expect(lifecycleFromEvent({ sysEvent: { eventType: 6 } })).toBe("exit");
    expect(lifecycleFromEvent({ sysEvent: { eventType: 7 } })).toBe("exit");
    expect(lifecycleFromEvent({ sysEvent: { event_type: "5" } })).toBe("background");
  });

  it("ignores gestures and other payloads", () => {
    expect(lifecycleFromEvent({ sysEvent: { eventSource: 1 } })).toBeNull();
    expect(lifecycleFromEvent({ sysEvent: { eventType: 3 } })).toBeNull();
    expect(lifecycleFromEvent({ textEvent: { eventType: 5 } })).toBeNull();
    expect(lifecycleFromEvent(null)).toBeNull();
    expect(lifecycleFromEvent("x")).toBeNull();
  });
});
