import { describe, expect, it } from "vitest";
import {
  addToStats, createStats, csvFileName, fmt2, guideStep, mostChangedAxis, record, recordingDone,
  RATE_WINDOW, sampleRate, startRecording, toCsv, type SensorStats,
} from "../src/imu/diagnostics";
import { buildSensorView, composeSensorView } from "../src/glasses/sensor-view";
import { BODY_COLS, BODY_ROWS, HEADER_COLS, LINE_COLS } from "../src/glasses/fit";
import type { Vec3 } from "../src/imu/vector";

function feed(samples: readonly Vec3[], startAt = 0, stepMs = 100): SensorStats {
  return samples.reduce((stats, sample, i) => addToStats(stats, sample, startAt + i * stepMs), createStats());
}

describe("sensor stats", () => {
  it("keeps the last sample, its magnitude and min/max per axis", () => {
    const stats = feed([{ x: 0, y: 0, z: 1 }, { x: 0.5, y: -2, z: 1 }, { x: -1, y: 0, z: 3 }]);
    expect(stats.count).toBe(3);
    expect(stats.last).toEqual({ x: -1, y: 0, z: 3 });
    expect(stats.lastMagnitude).toBeCloseTo(Math.sqrt(10));
    expect(stats.range).toEqual({ x: { min: -1, max: 0.5 }, y: { min: -2, max: 0 }, z: { min: 1, max: 3 } });
    expect(stats.magnitudeRange?.min).toBeCloseTo(1);
    expect(stats.magnitudeRange?.max).toBeCloseTo(Math.sqrt(10));
  });

  it("starts empty", () => {
    const stats = createStats();
    expect(stats.last).toBeNull();
    expect(stats.range).toBeNull();
    expect(mostChangedAxis(stats)).toBeNull();
  });

  it("names the axis with the most travel, even if it ended where it began", () => {
    // y swings back and forth and ends at 0; z drifts once by 0.5.
    const stats = feed([{ x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 1 }, { x: 0, y: -1, z: 1.5 }, { x: 0, y: 0, z: 1.5 }]);
    expect(stats.travel.y).toBeCloseTo(4);
    expect(mostChangedAxis(stats)).toBe("y");
  });

  it("keeps a still sensor at no axis", () => {
    expect(mostChangedAxis(feed([{ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }]))).toBeNull();
  });

  it("does not change the input stats", () => {
    const before = createStats();
    addToStats(before, { x: 1, y: 1, z: 1 }, 0);
    expect(before.count).toBe(0);
  });
});

describe("sample rate", () => {
  it("measures samples per second over the recent window", () => {
    const stats = feed(Array.from({ length: 11 }, () => ({ x: 0, y: 0, z: 1 })), 1000, 100);
    expect(sampleRate(stats.recent, 2000)).toBeCloseTo(10);
  });

  it("averages over at most RATE_WINDOW samples, so a pace change shows quickly", () => {
    const slow = feed(Array.from({ length: 10 }, () => ({ x: 0, y: 0, z: 1 })), 0, 500);
    const fast = Array.from({ length: RATE_WINDOW }, (_, i) => i).reduce((s, i) => addToStats(s, { x: 0, y: 0, z: 1 }, 5000 + i * 100), slow);
    expect(fast.recent).toHaveLength(RATE_WINDOW);
    expect(sampleRate(fast.recent, 5000 + (RATE_WINDOW - 1) * 100)).toBeCloseTo(10);
  });

  it("is unknown with fewer than two samples or when the sensor went quiet", () => {
    expect(sampleRate([], 0)).toBeNull();
    expect(sampleRate([100], 100)).toBeNull();
    expect(sampleRate([0, 100, 200], 10_000)).toBeNull();
  });
});

describe("number format", () => {
  it("shows two decimals and no negative zero", () => {
    expect(fmt2(1)).toBe("1.00");
    expect(fmt2(-0.004)).toBe("0.00");
    expect(fmt2(-9.8066)).toBe("-9.81");
    expect(fmt2(null)).toBe("--");
    expect(fmt2(Number.NaN)).toBe("--");
  });
});

describe("recording", () => {
  it("stores samples with their time since start and stops after 20 s", () => {
    let rec = startRecording(1000);
    rec = record(rec, { x: 1, y: 2, z: 3 }, 1000);
    rec = record(rec, { x: 4, y: 5, z: 6 }, 1250);
    rec = record(rec, { x: 7, y: 8, z: 9 }, 21_000);
    expect(rec.samples).toEqual([{ t: 0, x: 1, y: 2, z: 3 }, { t: 250, x: 4, y: 5, z: 6 }]);
    expect(recordingDone(rec, 20_999)).toBe(false);
    expect(recordingDone(rec, 21_000)).toBe(true);
  });

  it("walks through the five guided steps", () => {
    expect(guideStep(0)).toBe(0);
    expect(guideStep(2_999)).toBe(0);
    expect(guideStep(3_000)).toBe(1);
    expect(guideStep(7_500)).toBe(2);
    expect(guideStep(12_000)).toBe(3);
    expect(guideStep(19_999)).toBe(4);
    expect(guideStep(60_000)).toBe(4);
  });

  it("writes CSV with a header, the step and full precision", () => {
    let rec = startRecording(Date.UTC(2026, 9, 13, 10, 0, 0));
    rec = record(rec, { x: 0.123456, y: -9.81, z: 0 }, rec.startedAt + 10);
    rec = record(rec, { x: 3, y: 4, z: 0 }, rec.startedAt + 4000);
    const lines = toCsv(rec, 300).trimEnd().split("\n");
    expect(lines[0]).toMatch(/^# PostureLens IMU recording; pace=300 \(SDK ImuReportPace, unit unknown\); started=2026-10-13T10:00:00.000Z$/);
    expect(lines[1]).toBe("t_ms,step,x,y,z,magnitude");
    expect(lines[2]).toBe("10,1,0.123456,-9.81,0,9.810777");
    expect(lines[3]).toBe("4000,2,3,4,0,5");
    expect(lines).toHaveLength(4);
  });

  it("names the file after the start time only", () => {
    expect(csvFileName(startRecording(Date.UTC(2026, 9, 13, 10, 5, 7)))).toBe("posturelens-imu-2026-10-13T10-05-07.csv");
  });
});

describe("sensor view on the glasses", () => {
  const big = feed([{ x: -1234.56, y: 9876.54, z: -0.01 }, { x: 1234.56, y: -9876.54, z: 0.02 }]);

  for (const locale of ["de", "en"] as const) {
    it(`fits the ${locale} text budget, recording or not`, () => {
      const views = [
        composeSensorView(createStats(), { locale, pace: 1000, recording: null }, 0),
        composeSensorView(big, { locale, pace: 1000, recording: null }, 100),
        ...[0, 3_000, 7_000, 11_000, 15_000].map((at) => composeSensorView(big, { locale, pace: 1000, recording: startRecording(0) }, at)),
      ];
      for (const view of views) {
        expect(view.header.length, view.header).toBeLessThanOrEqual(HEADER_COLS);
        expect(view.footer.length, view.footer).toBeLessThanOrEqual(LINE_COLS);
        expect(view.body.length).toBeLessThanOrEqual(BODY_ROWS);
        for (const line of view.body) expect(line.length, line).toBeLessThanOrEqual(BODY_COLS);
      }
    });
  }

  it("shows x / y / z with two decimals, min/max, rate and the moving axis", () => {
    const stats = feed([{ x: 0, y: 0, z: 1 }, { x: 0, y: 0.5, z: 1 }, { x: 0.01, y: -0.25, z: 0.98 }], 0, 100);
    const view = buildSensorView(stats, { locale: "de", pace: 100, recording: null }, 200);
    expect(view.header).toBe("POSTURE · Sensor · P100 · 10.0 Hz · |v| 1.01");
    expect(view.body).toHaveLength(3);
    expect(view.body[1]).toBe("y  -0.25  min  -0.25 max   0.50 ●");
    expect(view.body[0]).not.toContain("●");
    expect(view.footer).toBe("Tippen = Min/Max neu · 2× = zurück");
  });

  it("guides the recording in the footer", () => {
    const view = buildSensorView(createStats(), { locale: "de", pace: 500, recording: startRecording(0) }, 4_000);
    expect(view.footer).toBe("● 16 s · 2) Kopf nach links drehen · 2× = zurück");
  });
});
