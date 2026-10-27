import { describe, expect, it } from "vitest";
import { formatShares, roleOf, RoleTally } from "../src/audio/roles";

describe("speaker role shares", () => {
  it("normalizes the SDK values and treats anything else as missing", () => {
    expect(roleOf("self")).toBe("self");
    expect(roleOf("OTHER")).toBe("other");
    expect(roleOf("unknown")).toBe("unknown");
    expect(roleOf(undefined)).toBe("missing");
    expect(roleOf(2)).toBe("missing");
    expect(roleOf("speaker")).toBe("missing");
  });

  it("weights shares by audio bytes, not by frame count", () => {
    const tally = new RoleTally();
    tally.add("self", 3000);
    tally.add("other", 500);
    tally.add("other", 500);
    tally.add("unknown", 1000);
    const shares = tally.shares();
    expect(shares.percent).toEqual({ self: 60, other: 20, unknown: 20, missing: 0 });
    expect(shares.frames).toEqual({ self: 1, other: 2, unknown: 1, missing: 0 });
    expect(shares.totalFrames).toBe(4);
    expect(formatShares(shares)).toBe("self 60% · other 20% · unknown 20%");
  });

  it("says so when no frame came", () => {
    const shares = new RoleTally().shares();
    expect(shares.percent).toEqual({ self: 0, other: 0, unknown: 0, missing: 0 });
    expect(formatShares(shares)).toBe("no frames");
  });

  it("lists a role that was seen even at 0 %", () => {
    const tally = new RoleTally();
    tally.add("self", 100_000);
    tally.add(undefined, 100);
    expect(formatShares(tally.shares())).toBe("self 100% · missing 0%");
  });
});
