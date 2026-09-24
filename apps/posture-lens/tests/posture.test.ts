import { describe, it, expect } from "vitest";
import { angleBetween, magnitude, normalise, sampleFrom, smooth, dot } from "../src/imu/vector";
import {
  addSample, calibrate, createMonitor, DEFAULT_SETTINGS, heldSeconds, reset, uprightShare,
  type PostureSettings,
} from "../src/posture/monitor";

const UPRIGHT = { x: 0, y: 0, z: 1 };
const TILTED_45 = { x: 0, y: 1, z: 1 };
const TILTED_90 = { x: 0, y: 1, z: 0 };

const fast: PostureSettings = {
  ...DEFAULT_SETTINGS,
  smoothing: 1,          // no smoothing, so tests are deterministic
  sustainSeconds: 10,
  snoozeSeconds: 60,
  warnAngle: 25,
};

describe("vector maths", () => {
  it("measures magnitude and normalises", () => {
    expect(magnitude({ x: 3, y: 4, z: 0 })).toBe(5);
    expect(normalise({ x: 3, y: 4, z: 0 })).toEqual({ x: 0.6, y: 0.8, z: 0 });
  });

  it("has no direction for a zero vector", () => {
    expect(normalise({ x: 0, y: 0, z: 0 })).toBeNull();
    expect(angleBetween({ x: 0, y: 0, z: 0 }, UPRIGHT)).toBeNull();
  });

  it("computes the angle between directions", () => {
    expect(angleBetween(UPRIGHT, UPRIGHT)).toBeCloseTo(0, 6);
    expect(angleBetween(UPRIGHT, TILTED_45)).toBeCloseTo(45, 6);
    expect(angleBetween(UPRIGHT, TILTED_90)).toBeCloseTo(90, 6);
    expect(angleBetween(UPRIGHT, { x: 0, y: 0, z: -1 })).toBeCloseTo(180, 6);
  });

  it("is invariant to scale, which is why the unit does not matter", () => {
    const a = angleBetween(UPRIGHT, TILTED_45);
    const b = angleBetween({ x: 0, y: 0, z: 100 }, { x: 0, y: 7, z: 7 });
    expect(b).toBeCloseTo(a!, 6);
  });

  it("does not overflow acos on identical vectors", () => {
    const v = { x: 0.577, y: 0.577, z: 0.577 };
    expect(angleBetween(v, v)).not.toBeNaN();
    expect(dot(v, v)).toBeGreaterThan(0.99);
  });

  it("smooths towards the sample and takes the first one whole", () => {
    expect(smooth(null, UPRIGHT, 0.5)).toEqual(UPRIGHT);
    expect(smooth({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }, 0.5)).toEqual({ x: 0, y: 0, z: 5 });
  });

  it("clamps the smoothing factor", () => {
    expect(smooth({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }, 5)).toEqual({ x: 0, y: 0, z: 10 });
    expect(smooth({ x: 0, y: 0, z: 4 }, { x: 0, y: 0, z: 10 }, -1)).toEqual({ x: 0, y: 0, z: 4 });
  });
});

describe("reading SDK payloads", () => {
  it("reads a full sample", () => {
    expect(sampleFrom({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("treats a missing axis as zero, because proto3 omits defaults", () => {
    expect(sampleFrom({ x: 1 })).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("accepts string-encoded numbers", () => {
    expect(sampleFrom({ x: "1", y: "2.5", z: "0" })).toEqual({ x: 1, y: 2.5, z: 0 });
  });

  it("rejects payloads with no axes at all", () => {
    expect(sampleFrom({})).toBeNull();
    expect(sampleFrom(null)).toBeNull();
    expect(sampleFrom({ foo: 1 })).toBeNull();
  });
});

describe("calibration", () => {
  it("starts uncalibrated and stays so until told otherwise", () => {
    const monitor = addSample(createMonitor(), UPRIGHT, fast, 1000);
    expect(monitor.state).toBe("uncalibrated");
    expect(monitor.angle).toBeNull();
  });

  it("takes the current pose as upright", () => {
    const monitor = calibrate(createMonitor(), TILTED_45, 1000);
    expect(monitor.state).toBe("good");
    expect(monitor.reference).toEqual(TILTED_45);
    expect(monitor.angle).toBe(0);
  });

  it("measures later samples against the calibrated pose, not against gravity", () => {
    // Calibrated while already tilted: that pose is now "upright" for this user.
    let monitor = calibrate(createMonitor(), TILTED_45, 1000);
    monitor = addSample(monitor, TILTED_45, fast, 2000);
    // acos near 1 carries float noise; 1e-6 degrees is exactly upright.
    expect(monitor.angle).toBeCloseTo(0, 4);
    expect(monitor.state).toBe("good");
  });
});

describe("warning behaviour", () => {
  const start = () => calibrate(createMonitor(), UPRIGHT, 0);

  it("does not warn about a brief glance down", () => {
    let m = start();
    m = addSample(m, TILTED_45, fast, 1000);   // leaning starts
    m = addSample(m, TILTED_45, fast, 5000);   // 5s held, threshold is 10s
    expect(m.state).toBe("leaning");
    m = addSample(m, UPRIGHT, fast, 6000);
    expect(m.state).toBe("good");
  });

  it("warns once the lean is held long enough", () => {
    let m = start();
    m = addSample(m, TILTED_45, fast, 1000);
    m = addSample(m, TILTED_45, fast, 12_000);
    expect(m.state).toBe("warned");
    expect(m.lastWarnAt).toBe(12_000);
  });

  it("stays quiet during the snooze window instead of nagging", () => {
    let m = start();
    m = addSample(m, TILTED_45, fast, 1000);
    m = addSample(m, TILTED_45, fast, 12_000);   // warned
    const firstWarn = m.lastWarnAt;

    m = addSample(m, TILTED_45, fast, 30_000);   // still leaning, inside snooze
    expect(m.lastWarnAt).toBe(firstWarn);
  });

  it("clears the lean timer when the user straightens up", () => {
    let m = start();
    m = addSample(m, TILTED_45, fast, 1000);
    expect(m.leaningSince).toBe(1000);
    m = addSample(m, UPRIGHT, fast, 2000);
    expect(m.leaningSince).toBeNull();
  });

  it("respects a custom warn angle", () => {
    const strict: PostureSettings = { ...fast, warnAngle: 10 };
    let m = start();
    m = addSample(m, { x: 0, y: 0.3, z: 1 }, strict, 1000);   // about 17 degrees
    expect(m.state).toBe("leaning");

    const lax: PostureSettings = { ...fast, warnAngle: 40 };
    let n = start();
    n = addSample(n, { x: 0, y: 0.3, z: 1 }, lax, 1000);
    expect(n.state).toBe("good");
  });
});

describe("time accounting", () => {
  it("splits tracked time between upright and leaning", () => {
    let m = calibrate(createMonitor(), UPRIGHT, 0);
    m = addSample(m, UPRIGHT, fast, 10_000);    // 10s upright
    m = addSample(m, TILTED_45, fast, 14_000);  // 4s counted as leaning

    expect(m.goodSeconds).toBeCloseTo(10, 3);
    expect(m.leaningSeconds).toBeCloseTo(4, 3);
    expect(uprightShare(m)).toBeCloseTo(10 / 14, 3);
  });

  it("reports no share before any time is tracked", () => {
    expect(uprightShare(createMonitor())).toBeNull();
  });

  it("reports how long the current lean has been held", () => {
    let m = calibrate(createMonitor(), UPRIGHT, 0);
    m = addSample(m, TILTED_45, fast, 1000);
    expect(heldSeconds(m, 6000)).toBeCloseTo(5, 3);
    expect(heldSeconds(calibrate(createMonitor(), UPRIGHT, 0), 6000)).toBeNull();
  });

  it("keeps the reference but clears the tally on reset", () => {
    let m = calibrate(createMonitor(), UPRIGHT, 0);
    m = addSample(m, TILTED_45, fast, 10_000);
    const cleared = reset(m);
    expect(cleared.reference).toEqual(UPRIGHT);
    expect(cleared.leaningSeconds).toBe(0);
    expect(cleared.state).toBe("good");
  });
});
