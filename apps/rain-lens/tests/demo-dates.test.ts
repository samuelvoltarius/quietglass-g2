// A zone east of UTC makes local midnight differ from the UTC date.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = "Europe/Vienna";
import { describe, expect, it } from "vitest";
import { dayName, demoWeather } from "../src/rain/model";

describe("demo forecast days", () => {
  it("starts on the local date just after midnight", () => {
    // Regression: dates came from toISOString(), so 00:30 in Vienna was still "yesterday".
    const demo = demoWeather(new Date(2026, 9, 4, 0, 30));
    expect(demo.daily.map((day) => day.date)).toEqual(["2026-10-04", "2026-10-05", "2026-10-06"]);
  });

  it("starts on the local date just before midnight", () => {
    const demo = demoWeather(new Date(2026, 9, 3, 23, 30));
    expect(demo.daily[0]?.date).toBe("2026-10-03");
    expect(dayName(demo.daily[0]!.date, "en")).toBe("Sat");
  });

  it("crosses a month end", () => {
    expect(demoWeather(new Date(2026, 9, 31, 8)).daily.map((day) => day.date)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
  });
});
