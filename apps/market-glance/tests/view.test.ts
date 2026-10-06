import { describe, expect, it } from "vitest";
import { BODY_ROWS, LINE_WIDTH, PAGE_SIZE, glassesView, modeLabel, positionLines, type FeedStatus } from "../src/glasses/view";
import { demoPositions, type Position } from "../src/markets/model";

const labels = { mode: "LIVE", title: "POSITIONS", empty: "No open positions", controls: "Tap: refresh" };
function pos(over: Partial<Position> = {}): Position {
  return { provider: "polymarket", title: "Rain tomorrow?", outcome: "YES", quantity: 1, currentValue: 1, pnl: 1, price: 0.5, ...over };
}
const many = Array.from({ length: 6 }, (_, i) => pos({ title: `Market ${i}` }));

describe("glasses view", () => {
  it("shows mode in the header and controls in the footer", () => {
    const view = glassesView(demoPositions(), 0, labels);
    expect(view.header).toBe("MARKET GLANCE  LIVE");
    expect(view.footer).toBe("Tap: refresh");
  });
  it("regression: the body never exceeds the rows the container can show", () => {
    // Four positions used to produce 10 rows in a 7-row container, clipping the last P/L lines.
    expect(glassesView(many, 0, labels).body.length).toBeLessThanOrEqual(BODY_ROWS);
    expect(PAGE_SIZE).toBeGreaterThanOrEqual(1);
  });
  it("marks only the first visible row as selected and follows the cursor", () => {
    const body = glassesView(many, 2, labels).body;
    expect(body[2]).toBe("> P Market 2");
    expect(body.filter((line) => line.startsWith(">"))).toHaveLength(1);
  });
  it("still shows the last position when the cursor sits on it", () => {
    const body = glassesView(many, many.length - 1, labels).body;
    expect(body).toEqual(["POSITIONS", "", "> P Market 5", "  YES 50c  +$1.00"]);
  });
  it("shows the empty message when there are no positions", () => {
    expect(glassesView([], 0, labels).body).toEqual(["POSITIONS", "", "No open positions"]);
  });
  it("tags providers K and P", () => {
    expect(positionLines(pos({ provider: "kalshi" }), false)[0]).toBe("  K Rain tomorrow?");
    expect(positionLines(pos(), true)[0]).toBe("> P Rain tomorrow?");
  });
  it("prints outcome, price in cents and signed P/L", () => {
    expect(positionLines(pos({ outcome: "NO", price: 0.54, pnl: -0.6 }), false)[1]).toBe("  NO 54c  -$0.60");
  });
  it("regression: a long outcome no longer pushes price and P/L off the display", () => {
    const [title, detail] = positionLines(pos({ title: "T".repeat(80), outcome: "Manchester United to win by two or more goals", price: 0.33, pnl: 12.5 }), true);
    expect(title.length).toBeLessThanOrEqual(LINE_WIDTH);
    expect(detail.length).toBeLessThanOrEqual(LINE_WIDTH);
    expect(detail.endsWith(" 33c  +$12.50")).toBe(true);
  });
  it("regression: an unknown provider is tagged ? and a missing price shows a marker", () => {
    expect(positionLines(pos({ provider: "binance", price: null, pnl: null }), false)).toEqual(["  ? Rain tomorrow?", "  YES –  –"]);
  });
});

describe("header mode", () => {
  const words = { live: "LIVE", demo: "DEMO", stale: "STALE" };
  const now = Date.UTC(2026, 0, 1, 12);
  const live = (over: Partial<FeedStatus> = {}): FeedStatus => ({ source: "live", updatedAt: now - 1000, failed: false, errors: [], ...over });
  it("shows LIVE only for fresh live data", () => expect(modeLabel(live(), now, words)).toBe("LIVE"));
  it("regression: old data is no longer labelled LIVE", () => expect(modeLabel(live({ updatedAt: now - 180_000 }), now, words)).toBe("STALE 3m"));
  it("regression: a failed refresh turns the label stale immediately", () => expect(modeLabel(live({ failed: true }), now, words)).toBe("STALE 1s"));
  it("keeps demo data labelled DEMO", () => expect(modeLabel(live({ source: "demo", failed: true }), now, words)).toBe("DEMO"));
  it("names providers that failed in a partial response", () => {
    expect(modeLabel(live({ errors: [{ provider: "polymarket", message: "HTTP 500" }] }), now, words)).toBe("LIVE  P ERR");
  });
  it("fits the header within the line width in the longest case", () => {
    const longest = `MARKET GLANCE  ${modeLabel(live({ updatedAt: now - 3_600_000 * 99, errors: [{ provider: "polymarket", message: "" }, { provider: "kalshi", message: "" }, { provider: "x", message: "" }] }), now, { ...words, stale: "DESACTUALIZADO" })}`;
    expect(longest.length).toBeLessThanOrEqual(LINE_WIDTH);
  });
});
