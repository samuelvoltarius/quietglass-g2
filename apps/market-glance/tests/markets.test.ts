import { describe, expect, it } from "vitest";
import { MISSING, STALE_AFTER_MS, ageLabel, cents, demoPositions, money, parseErrors, parsePositions, parseTimestamp, providerTag, shorten, staleAge } from "../src/markets/model";

describe("markets", () => { it("normalizes positions", () => expect(parsePositions({ positions: [{ provider: "kalshi", title: "Test", quantity: "2" }] })[0]?.quantity).toBe(2)); it("formats losses", () => expect(money(-1.2)).toBe("-$1.20")); it("shortens titles", () => expect(shorten("abcdefgh", 6)).toBe("abc...")); });

describe("parsePositions", () => {
  it("accepts a bare array as well as a { positions } envelope", () => {
    expect(parsePositions([{ title: "A" }])).toHaveLength(1);
    expect(parsePositions({ positions: [{ title: "A" }] })).toHaveLength(1);
  });
  it("rejects a response without a positions array", () => {
    expect(() => parsePositions({})).toThrow();
    expect(() => parsePositions(null)).toThrow();
    expect(() => parsePositions("nope")).toThrow();
  });
  it("drops rows without a string title instead of rendering 'undefined'", () => {
    expect(parsePositions([{ title: 42 }, null, "x", { title: "kept" }]).map((p) => p.title)).toEqual(["kept"]);
  });
  it("turns missing quantities into 0 but keeps a missing price or P/L as null", () => {
    const [p] = parsePositions([{ title: "A", quantity: "abc", currentValue: null, pnl: Infinity, price: undefined }]);
    expect(p).toMatchObject({ quantity: 0, currentValue: 0, pnl: null, price: null });
  });
  it("regression: an unparseable price is null (shown as a missing marker), not 0c", () => {
    for (const price of ["n/a", "", null, true, Number.NaN]) expect(parsePositions([{ title: "A", price }])[0]?.price).toBeNull();
    expect(parsePositions([{ title: "A", price: "0" }])[0]?.price).toBe(0);
  });
  it("keeps realized P/L only when the bridge sends it", () => {
    expect(parsePositions([{ title: "A", realizedPnl: "1.5" }])[0]?.realizedPnl).toBe(1.5);
    expect(parsePositions([{ title: "A" }])[0]).not.toHaveProperty("realizedPnl");
  });
  it("keeps negative P/L as a number", () => {
    expect(parsePositions([{ title: "A", pnl: "-3.5" }])[0]?.pnl).toBe(-3.5);
  });
  it("regression: provider matching ignores case and whitespace", () => {
    expect(parsePositions([{ title: "A", provider: "Kalshi" }, { title: "B", provider: " POLYMARKET " }]).map((p) => providerTag(p.provider))).toEqual(["K", "P"]);
  });
  it("regression: unknown or missing providers stay unknown instead of becoming Polymarket", () => {
    const [p, q] = parsePositions([{ title: "A", provider: "Binance", outcome: 1 }, { title: "B" }]);
    expect(p?.provider).toBe("binance");
    expect(providerTag(p?.provider ?? "")).toBe("?");
    expect(q?.provider).toBe("");
    expect(providerTag(q?.provider ?? "")).toBe("?");
    expect(p?.outcome).toBe("");
  });
  it("ships demo data that parses cleanly", () => {
    expect(parsePositions(demoPositions())).toEqual(demoPositions());
  });
});

describe("money", () => {
  it("signs gains and zero as positive", () => {
    expect(money(2.5)).toBe("+$2.50");
    expect(money(0)).toBe("+$0.00");
    expect(money(-0)).toBe("+$0.00");
  });
  it("rounds to cents", () => {
    expect(money(1234.567)).toBe("+$1234.57");
    expect(money(-0.016)).toBe("-$0.02");
  });
  it("regression: a loss that rounds to zero is not shown as -$0.00", () => {
    expect(money(-0.004)).toBe("+$0.00");
    expect(money(-0.0049)).toBe("+$0.00");
  });
});

describe("cents", () => {
  it("shows a probability price as whole cents", () => {
    expect(cents(0.65)).toBe("65c");
    expect(cents(0.005)).toBe("1c");
    expect(cents(0)).toBe("0c");
    expect(cents(1)).toBe("100c");
  });
  it("shows a missing marker instead of 0c / +$0.00 for unknown values", () => {
    expect(cents(null)).toBe(MISSING);
    expect(money(null)).toBe(MISSING);
  });
});

describe("shorten", () => {
  it("leaves text that fits untouched", () => {
    expect(shorten("abc", 3)).toBe("abc");
    expect(shorten("", 5)).toBe("");
  });
  it("never exceeds the requested length", () => {
    const long = "x".repeat(100);
    for (const length of [1, 2, 3, 4, 10, 44]) expect(Array.from(shorten(long, length)).length).toBeLessThanOrEqual(length);
  });
  it("regression: a limit of 3 or less no longer returns a longer string", () => {
    expect(shorten("abcdef", 2)).toBe("ab");
    expect(shorten("abcdef", 0)).toBe("");
  });
  it("regression: does not split an emoji into a lone surrogate", () => {
    const out = shorten("Will \u{1F680} launch go well tonight", 9);
    expect(out).toBe("Will \u{1F680}...");
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("bridge metadata", () => {
  it("parses updatedAt into ms and rejects junk", () => {
    expect(parseTimestamp("2026-01-01T00:00:00Z")).toBe(Date.UTC(2026, 0, 1));
    expect(parseTimestamp("yesterday")).toBeNull();
    expect(parseTimestamp(123)).toBeNull();
  });
  it("reads per-provider errors and skips malformed ones", () => {
    expect(parseErrors([{ provider: "Polymarket", message: "HTTP 500" }, { provider: "kalshi" }, null])).toEqual([{ provider: "polymarket", message: "HTTP 500" }]);
    expect(parseErrors(undefined)).toEqual([]);
  });
});

describe("staleness", () => {
  const now = Date.UTC(2026, 0, 1, 12);
  it("formats ages compactly", () => {
    expect(ageLabel(42_000)).toBe("42s");
    expect(ageLabel(180_000)).toBe("3m");
    expect(ageLabel(7_200_000)).toBe("2h");
    expect(ageLabel(-5)).toBe("0s");
  });
  it("is fresh within the threshold and stale beyond it", () => {
    expect(staleAge(now - STALE_AFTER_MS, now, false)).toBeNull();
    expect(staleAge(now - 180_000, now, false)).toBe("3m");
  });
  it("is stale right away when the last refresh failed", () => expect(staleAge(now - 5_000, now, true)).toBe("5s"));
  it("treats a timestamp from the future as age 0", () => expect(staleAge(now + 60_000, now, false)).toBeNull());
});
