import { describe, it, expect } from "vitest";
import { buildView, formatAngle, formatDuration } from "../src/glasses/view";
import { addSample, calibrate, createMonitor, DEFAULT_SETTINGS, type PostureSettings } from "../src/posture/monitor";
import { parseData, EMPTY_DATA } from "../src/storage/persist";

const UPRIGHT = { x: 0, y: 0, z: 1 };
const TILTED = { x: 0, y: 1, z: 1 };

const fast: PostureSettings = {
  ...DEFAULT_SETTINGS, smoothing: 1, sustainSeconds: 10, snoozeSeconds: 60, warnAngle: 25,
};

describe("uncalibrated", () => {
  it("asks the user to set their upright pose", () => {
    const view = buildView(createMonitor(), fast);
    expect(view.body.join(" ")).toContain("Sit the way you want to sit");
    expect(view.footer).toContain("calibrate");
  });
});

describe("good posture stays out of the way", () => {
  it("shows no header and no body at all", () => {
    const m = calibrate(createMonitor(), UPRIGHT, 0);
    const view = buildView(m, fast, {}, 1000);
    expect(view.header).toBe("");
    expect(view.body).toEqual([]);
  });

  it("shows the angle only when explicitly asked", () => {
    let m = calibrate(createMonitor(), UPRIGHT, 0);
    m = addSample(m, UPRIGHT, fast, 1000);
    expect(buildView(m, fast, { showAngleWhenGood: true }, 2000).body).toHaveLength(1);
  });

  it("reports the upright share once time has been tracked", () => {
    let m = calibrate(createMonitor(), UPRIGHT, 0);
    m = addSample(m, UPRIGHT, fast, 10_000);
    expect(buildView(m, fast, {}, 10_000).footer).toContain("100% upright");
  });
});

describe("leaning", () => {
  it("shows the angle and counts down to the warning", () => {
    let m = calibrate(createMonitor(), UPRIGHT, 0);
    m = addSample(m, TILTED, fast, 1000);
    const view = buildView(m, fast, {}, 4000);
    expect(view.body[0]).toContain("45°");
    expect(view.footer).toContain("to warning");
  });
});

describe("warned", () => {
  it("becomes unmissable and says what to do", () => {
    let m = calibrate(createMonitor(), UPRIGHT, 0);
    m = addSample(m, TILTED, fast, 1000);
    m = addSample(m, TILTED, fast, 12_000);

    const view = buildView(m, fast, {}, 12_000);
    expect(view.header).toBe("HEAD FORWARD");
    expect(view.footer).toContain("straighten up");
    expect(view.body.join(" ")).toContain("held");
  });
});

describe("formatting", () => {
  it("rounds the angle and marks it unknown when absent", () => {
    expect(formatAngle(24.6)).toBe("25° forward");
    expect(formatAngle(null)).toBe("--");
  });

  it("formats short and long durations readably", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(95)).toBe("1m 35s");
    expect(formatDuration(-5)).toBe("0s");
  });
});

describe("storage", () => {
  it("falls back cleanly on corrupt data", () => {
    expect(parseData("{broken")).toEqual(EMPTY_DATA);
    expect(parseData("")).toEqual(EMPTY_DATA);
  });

  it("restores a stored calibration", () => {
    const parsed = parseData(JSON.stringify({ reference: { x: 0, y: 0, z: 1 } }));
    expect(parsed.reference).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("rejects a zero reference vector, which has no direction", () => {
    expect(parseData(JSON.stringify({ reference: { x: 0, y: 0, z: 0 } })).reference).toBeNull();
  });

  it("rejects an incomplete reference vector", () => {
    expect(parseData(JSON.stringify({ reference: { x: 1, y: 2 } })).reference).toBeNull();
  });

  it("clamps out-of-range thresholds instead of trusting them", () => {
    const parsed = parseData(JSON.stringify({
      settings: { warnAngle: 999, sustainSeconds: 0, smoothing: 50 },
    }));
    expect(parsed.settings.warnAngle).toBe(80);
    expect(parsed.settings.sustainSeconds).toBe(5);
    expect(parsed.settings.smoothing).toBe(1);
  });
});
