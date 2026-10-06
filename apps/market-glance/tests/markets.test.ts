import { describe, expect, it } from "vitest";
import { cents, demoPositions, money, parsePositions, shorten } from "../src/markets/model";

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
  it("turns missing, NaN and infinite numbers into 0", () => {
    const [p] = parsePositions([{ title: "A", quantity: "abc", currentValue: null, pnl: Infinity, price: undefined }]);
    expect(p).toMatchObject({ quantity: 0, currentValue: 0, pnl: 0, price: 0 });
  });
  it("keeps negative P/L as a number", () => {
    expect(parsePositions([{ title: "A", pnl: "-3.5" }])[0]?.pnl).toBe(-3.5);
  });
  it("defaults unknown providers to polymarket and a missing outcome to empty", () => {
    const [p] = parsePositions([{ title: "A", provider: "binance", outcome: 1 }]);
    expect(p?.provider).toBe("polymarket");
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
