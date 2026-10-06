import { describe, expect, it } from "vitest";
import { collect, kalshiPosition, kalshiPrice } from "../examples/market-bridge.mjs";

// Shapes follow docs.kalshi.com: GET /portfolio/positions (market_positions) and GET /markets (FixedPointDollars strings).
const market = { ticker: "TEMP-80", title: "Temp above 80?", yes_bid_dollars: "0.6000", no_bid_dollars: "0.3800", last_price_dollars: "0.6100" };

describe("Kalshi mapping in the example bridge", () => {
  it("regression: price is the current market price, not cost basis / quantity", () => {
    const position = kalshiPosition({ ticker: "TEMP-80", position_fp: "10.00", market_exposure_dollars: "4.0000", realized_pnl_dollars: "1.2500" }, market);
    expect(position).toMatchObject({ provider: "kalshi", title: "Temp above 80?", outcome: "YES", quantity: 10, price: 0.6, realizedPnl: 1.25 });
    // Open P/L = 10 × 0.60 − 4.00 cost basis; realized P/L is kept separately.
    expect(position.currentValue).toBeCloseTo(6);
    expect(position.pnl).toBeCloseTo(2);
  });
  it("prices a NO position from the NO bid", () => {
    const position = kalshiPosition({ ticker: "TEMP-80", position_fp: "-5", market_exposure_dollars: "2.5000" }, market);
    expect(position).toMatchObject({ outcome: "NO", quantity: 5, price: 0.38 });
    expect(position.pnl).toBeCloseTo(-0.6);
  });
  it("falls back to the last trade when the book is empty, and to null without any price", () => {
    expect(kalshiPrice({ yes_bid_dollars: "0.0000", last_price_dollars: "0.2500" }, "YES")).toBe(0.25);
    expect(kalshiPrice({ no_bid_dollars: "0.0000", last_price_dollars: "0.2500" }, "NO")).toBe(0.75);
    expect(kalshiPrice({ yes_bid_dollars: "0.0000", last_price_dollars: "0.0000" }, "YES")).toBeNull();
    const unpriced = kalshiPosition({ ticker: "X", position_fp: "3", market_exposure_dollars: "1" }, undefined);
    expect(unpriced).toMatchObject({ title: "X", price: null, pnl: null });
  });
  it("regression: a closed position (quantity 0) is dropped instead of shown as YES", () => {
    expect(kalshiPosition({ ticker: "X", position_fp: "0.00", realized_pnl_dollars: "3" }, market)).toBeNull();
    expect(kalshiPosition({ ticker: "X" }, market)).toBeNull();
  });
});

describe("provider aggregation", () => {
  const ok = { name: "kalshi", load: async () => [{ provider: "kalshi", title: "K" }] };
  const broken = { name: "polymarket", load: async () => { throw new Error("Polymarket HTTP 500"); } };
  it("regression: a Polymarket failure keeps the Kalshi positions and reports the error", async () => {
    expect(await collect([broken, ok])).toEqual({ positions: [{ provider: "kalshi", title: "K" }], errors: [{ provider: "polymarket", message: "Polymarket HTTP 500" }], failed: false });
  });
  it("fails only when every configured provider failed", async () => {
    expect((await collect([broken])).failed).toBe(true);
    expect((await collect([])).failed).toBe(false);
  });
});
