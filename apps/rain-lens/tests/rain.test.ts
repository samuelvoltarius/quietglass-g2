import { describe, expect, it } from "vitest";
import { parseOpenMeteo, rainBar, rainSummary } from "../src/rain/model";
describe("rain model", () => {
  it("parses aligned 15-minute values", () => { expect(parseOpenMeteo({ minutely_15: { time: ["2026-10-03T10:00"], precipitation: [1.25] } }).points[0]?.mm).toBe(1.25); });
  it("caps the bar", () => { expect(rainBar(99)).toBe("############"); });
  it("describes dry weather", () => { expect(rainSummary([{ time: "2026-10-03T10:00", mm: 0 }])).toContain("Trocken"); });
});
