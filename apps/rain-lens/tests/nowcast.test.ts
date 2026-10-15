import { describe, expect, it } from "vitest";
import { isSnowCode, localToEpoch, nowcast, parseSlots, rainTotal, roundMinutes, wetThreshold, type PrecipSlot } from "../src/cockpit/nowcast";

const T0 = Date.UTC(2026, 9, 13, 12, 0);
/** 15-minute slots from T0 with these amounts (mm) and codes. */
const quarter = (amounts: readonly number[], codes: readonly number[] = []): PrecipSlot[] => amounts.map((precipitation, index) => ({
  start: T0 + index * 900_000, minutes: 15, precipitation, weatherCode: codes[index] ?? (precipitation > 0 ? 61 : 3),
  local: `${String(14 + Math.floor((index * 15) / 60)).padStart(2, "0")}:${String((index * 15) % 60).padStart(2, "0")}`,
}));

describe("nowcast", () => {
  it("says it rains now when the current quarter has 0.1 mm or more", () => {
    expect(nowcast(quarter([0.1, 0, 0]), T0 + 5 * 60_000)).toEqual({ kind: "now", snow: false });
    expect(nowcast(quarter([0.3]), T0)).toEqual({ kind: "now", snow: false });
  });
  it("treats a stray 0.05 mm as dry", () => {
    expect(nowcast(quarter([0.05, 0.05, 0.05, 0.05]), T0)).toEqual({ kind: "dry" });
  });
  it("counts the minutes to the first wet quarter, rounded to five", () => {
    // Now 12:07, rain from 12:30 → 23 min → ~25.
    expect(nowcast(quarter([0, 0, 0.4]), T0 + 7 * 60_000)).toEqual({ kind: "soon", snow: false, minutes: 25 });
    // Rain in the next quarter but only 2 minutes away → at least 5.
    expect(nowcast(quarter([0, 0.2]), T0 + 13 * 60_000)).toEqual({ kind: "soon", snow: false, minutes: 5 });
  });
  it("tells far-off rain as dry until the local time it starts", () => {
    const slots = quarter([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5]);
    expect(nowcast(slots, T0)).toEqual({ kind: "dryUntil", snow: false, time: "17:00" });
  });
  it("is dry when nothing falls within the horizon", () => {
    expect(nowcast(quarter([0, 0, 0, 0]), T0)).toEqual({ kind: "dry" });
    expect(nowcast(quarter([0, 0, 0, 2]), T0, 30)).toEqual({ kind: "dry" });
  });
  it("knows snow by the weather code", () => {
    expect(nowcast(quarter([0, 0.3], [3, 73]), T0)).toEqual({ kind: "soon", snow: true, minutes: 15 });
    expect(nowcast(quarter([0.3], [85]), T0)).toEqual({ kind: "now", snow: true });
    expect(isSnowCode(71) && isSnowCode(77) && isSnowCode(86)).toBe(true);
    expect(isSnowCode(61) || isSnowCode(95)).toBe(false);
  });
  it("is unknown without slots or when all of them lie in the past", () => {
    expect(nowcast([], T0)).toEqual({ kind: "unknown" });
    expect(nowcast(quarter([1, 1]), T0 + 3 * 3_600_000)).toEqual({ kind: "unknown" });
  });
  it("works on hourly slots with a matching threshold", () => {
    const hourly: PrecipSlot[] = [0, 0.2, 0.6].map((precipitation, index) => ({ start: T0 + index * 3_600_000, minutes: 60, precipitation, weatherCode: 61, local: `${14 + index}:00` }));
    expect(wetThreshold(15)).toBe(0.1);
    expect(wetThreshold(60)).toBe(0.3);
    expect(nowcast(hourly, T0 + 10 * 60_000)).toEqual({ kind: "dryUntil", snow: false, time: "16:00" });
  });
  it("rounds minutes in steps of five, never below five", () => {
    expect([1, 7, 8, 23, 88].map(roundMinutes)).toEqual([5, 5, 10, 25, 90]);
  });
});

describe("rain total and parsing", () => {
  it("adds the next two hours including the quarter under way", () => {
    expect(rainTotal(quarter([0.2, 0.3, 0, 0, 0, 0, 0, 0, 0, 5]), T0 + 60_000)).toBe(0.5);
  });
  it("turns Open-Meteo local times into instants with the place's offset", () => {
    expect(localToEpoch("2026-10-13T14:00", 7200)).toBe(T0);
    expect(localToEpoch("garbage", 0)).toBeNaN();
  });
  it("parses minutely_15 arrays and skips holes", () => {
    const slots = parseSlots(["2026-10-13T14:00", "2026-10-13T14:15", "2026-10-13T14:30"], [0.2, null, 0], [61, 61], 7200, 15);
    expect(slots).toEqual([
      { start: T0, minutes: 15, precipitation: 0.2, weatherCode: 61, local: "14:00" },
      { start: T0 + 1_800_000, minutes: 15, precipitation: 0, weatherCode: 0, local: "14:30" },
    ]);
    expect(parseSlots(undefined, [], [], 0, 15)).toEqual([]);
  });
});
