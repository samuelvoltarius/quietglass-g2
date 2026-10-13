import { describe, expect, it } from "vitest";
import { delta, parseDeviceStatus, parseEntries, parseTreatments, toDirection } from "../src/ns/model";
import { alerts, DEFAULT_LIMITS, normaliseLimits } from "../src/ns/alerts";
import { glucose, insulin, parseGlucose, signedDelta, toMmol } from "../src/ns/units";
import { buildUrl } from "../src/ns/client";
import { demoReadings } from "../src/ns/demo";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const min = (m: number): number => NOW - m * 60_000;

describe("Nightscout entries", () => {
  it("keeps sgv readings newest first, drops duplicates, error codes and other types", () => {
    const list = parseEntries([
      { type: "sgv", sgv: 110, date: min(10), direction: "Flat" },
      { type: "sgv", sgv: 120, date: min(5), direction: "fortyfiveup" },
      { type: "sgv", sgv: 120, date: min(5) },
      { type: "mbg", mbg: 99, date: min(1) },
      { type: "sgv", sgv: 5, date: min(2) },
      { sgv: "131", dateString: new Date(min(0)).toISOString(), trend: 2 },
    ]);
    expect(list.map((r) => r.mgdl)).toEqual([131, 120, 110]);
    expect(list.map((r) => r.direction)).toEqual(["SingleUp", "FortyFiveUp", "Flat"]);
  });

  it("delta is scaled to five minutes and needs a reading 2.5-15 min before", () => {
    const list = parseEntries([{ sgv: 100, date: min(0) }, { sgv: 90, date: min(10) }]);
    expect(delta(list)).toBe(5);
    expect(delta(parseEntries([{ sgv: 100, date: min(0) }, { sgv: 90, date: min(20) }]))).toBeNull();
    expect(delta(parseEntries([{ sgv: 100, date: min(0) }]))).toBeNull();
  });

  it("unknown directions become NONE", () => {
    expect(toDirection("NOT COMPUTABLE")).toBe("NONE");
    expect(toDirection(undefined, 7)).toBe("DoubleDown");
  });
});

describe("devicestatus from the CareLink bridge", () => {
  it("reads IOB, reservoir, batteries and sensor time, newest document first", () => {
    const pump = parseDeviceStatus([
      { created_at: new Date(min(30)).toISOString(), pump: { reservoir: 10 } },
      {
        created_at: new Date(min(3)).toISOString(), device: "MiniMed 780G",
        uploader: { battery: 64 },
        pump: { battery: { percent: 75 }, reservoir: 87.5, iob: { bolusiob: 1.25 } },
        connect: { sensorState: "NO_ERROR_MESSAGE", sensorDurationHours: 101, therapyAlgorithmState: { autoModeShieldState: "AUTO_BASAL" } },
      },
    ]);
    expect(pump).toMatchObject({ device: "MiniMed 780G", iob: 1.25, reservoir: 87.5, battery: 75, uploaderBattery: 64, sensorHours: 101, mode: "auto", sensorState: "NO_ERROR_MESSAGE" });
    expect(pump?.at).toBe(min(3));
  });

  it("SmartGuard safe basal and an unreported mode", () => {
    expect(parseDeviceStatus([{ created_at: "2026-10-13T11:00:00Z", pump: {}, connect: { therapyAlgorithmState: { autoModeShieldState: "SAFE_BASAL" } } }])?.mode).toBe("safe");
    expect(parseDeviceStatus([{ created_at: "2026-10-13T11:00:00Z", pump: { reservoir: 3 } }])?.mode).toBeNull();
    expect(parseDeviceStatus([])).toBeNull();
    expect(parseDeviceStatus("nope")).toBeNull();
  });

  it("treatments: newest meal and newest bolus", () => {
    const t = parseTreatments([
      { created_at: new Date(min(300)).toISOString(), carbs: 20 },
      { created_at: new Date(min(120)).toISOString(), carbs: 45, insulin: 4.5 },
      { created_at: new Date(min(60)).toISOString(), insulin: 1 },
      { created_at: new Date(min(30)).toISOString(), eventType: "Note" },
    ]);
    expect(t.lastCarbs).toEqual({ at: min(120), grams: 45 });
    expect(t.lastBolus).toEqual({ at: min(60), units: 1 });
  });
});

describe("alerts", () => {
  const read = (mgdl: number, m = 2, direction = "Flat", prev?: number) => parseEntries([
    { sgv: mgdl, date: min(m), direction },
    ...(prev !== undefined ? [{ sgv: prev, date: min(m + 5) }] : []),
  ]);
  it("urgent low, low, high, in range", () => {
    expect(alerts(read(50), DEFAULT_LIMITS, NOW).map((a) => a.kind)).toEqual(["urgentLow"]);
    expect(alerts(read(65), DEFAULT_LIMITS, NOW).map((a) => a.kind)).toEqual(["low"]);
    expect(alerts(read(260), DEFAULT_LIMITS, NOW).map((a) => a.kind)).toEqual(["high"]);
    expect(alerts(read(120), DEFAULT_LIMITS, NOW)).toEqual([]);
  });
  it("older than 15 minutes: only 'stale', never judged as low", () => {
    expect(alerts(read(50, 16), DEFAULT_LIMITS, NOW)).toEqual([{ kind: "stale", critical: true }]);
  });
  it("falling fast by arrow or by delta", () => {
    expect(alerts(read(120, 2, "DoubleDown"), DEFAULT_LIMITS, NOW).map((a) => a.kind)).toEqual(["fallingFast"]);
    expect(alerts(read(100, 2, "Flat", 118), DEFAULT_LIMITS, NOW).map((a) => a.kind)).toEqual(["fallingFast"]);
    expect(alerts(read(66, 2, "SingleDown", 90), DEFAULT_LIMITS, NOW).map((a) => a.kind)).toEqual(["low", "fallingFast"]);
  });
  it("no readings at all", () => {
    expect(alerts([], DEFAULT_LIMITS, NOW)).toEqual([{ kind: "noData", critical: false }]);
  });
  it("limits are kept sane", () => {
    expect(normaliseLimits({ urgentLow: 10, low: 40, targetLow: 150, targetHigh: 120, high: 999, staleMinutes: 1 }))
      .toEqual({ urgentLow: 40, low: 50, targetLow: 140, targetHigh: 150, high: 400, staleMinutes: 6 });
  });
});

describe("units", () => {
  it("mg/dL and mmol/L with the right decimal sign", () => {
    expect(glucose(106, "mgdl", "de")).toBe("106");
    expect(glucose(106, "mmol", "de")).toBe("5,9");
    expect(glucose(106, "mmol", "en")).toBe("5.9");
    expect(toMmol(180)).toBe(10);
    expect(signedDelta(-12, "mgdl", "de")).toBe("-12");
    expect(signedDelta(9, "mmol", "de")).toBe("+0,5");
    expect(signedDelta(0, "mgdl", "en")).toBe("±0");
    expect(parseGlucose("3,9", "mmol")).toBe(70);
    expect(parseGlucose("abc", "mgdl")).toBeNull();
    expect(insulin(1.25, "de")).toBe("1,3 E");
    expect(insulin(0.35, "en")).toBe("0.35 U");
  });
});

describe("requests", () => {
  it("the token goes into the query, never a header", () => {
    expect(buildUrl("https://ns.example/", "/api/v1/entries/sgv.json", { count: "48" }, "abc-123"))
      .toBe("https://ns.example/api/v1/entries/sgv.json?count=48&token=abc-123");
    expect(buildUrl("https://ns.example", "/api/v1/status.json", {})).toBe("https://ns.example/api/v1/status.json");
  });
});

describe("demo", () => {
  it("readings every five minutes, newest 1-5 minutes old", () => {
    const list = demoReadings("normal", NOW, 40);
    expect(list.length).toBeGreaterThan(30);
    expect(NOW - list[0]!.at).toBeGreaterThanOrEqual(0);
    expect(NOW - list[0]!.at).toBeLessThanOrEqual(5 * 60_000);
    expect(list[0]!.at - list[1]!.at).toBe(5 * 60_000);
    expect(demoReadings("low", NOW)[0]!.mgdl).toBeLessThan(70);
    expect(demoReadings("high", NOW)[0]!.mgdl).toBeGreaterThan(250);
    expect(NOW - demoReadings("stale", NOW)[0]!.at).toBeGreaterThan(15 * 60_000);
    for (const offset of [0, 60_000, 120_000, 180_000, 240_000]) {
      const low = demoReadings("low", NOW + offset);
      expect(alerts(low, DEFAULT_LIMITS, NOW + offset).map((a) => a.kind)).toContain("low");
      expect(["FortyFiveDown", "SingleDown", "DoubleDown"]).toContain(low[0]!.direction);
      const fall = demoReadings("falling", NOW + offset);
      expect(alerts(fall, DEFAULT_LIMITS, NOW + offset).map((a) => a.kind)).toContain("fallingFast");
    }
  });
});
