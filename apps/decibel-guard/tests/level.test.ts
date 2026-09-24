import { describe, it, expect } from "vitest";
import { levelFromPcm, MIN_DBFS, SILENT, smoothDb, toApproxSpl, toDbfs } from "../src/audio/level";
import {
  accumulate, createDose, DEFAULT_DOSE, doseFraction, doseLevel, formatDuration,
  permittedSeconds, remainingSeconds, resetDose, type DoseSettings,
} from "../src/noise/dose";

/** Builds a little-endian s16 PCM buffer from sample values. */
function pcm(...samples: number[]): Uint8Array {
  const buffer = new Uint8Array(samples.length * 2);
  samples.forEach((sample, i) => {
    const value = sample < 0 ? sample + 0x10000 : sample;
    buffer[i * 2] = value & 0xff;
    buffer[i * 2 + 1] = (value >> 8) & 0xff;
  });
  return buffer;
}

describe("PCM level", () => {
  it("reports silence for an empty buffer", () => {
    expect(levelFromPcm(new Uint8Array(0))).toEqual(SILENT);
  });

  it("reports silence for all-zero samples", () => {
    const reading = levelFromPcm(pcm(0, 0, 0, 0));
    expect(reading.rms).toBe(0);
    expect(reading.dbfs).toBe(MIN_DBFS);
  });

  it("decodes little-endian signed samples", () => {
    // Full negative scale: rms should be 1.0.
    const reading = levelFromPcm(pcm(-32768, -32768));
    expect(reading.rms).toBeCloseTo(1, 5);
    expect(reading.dbfs).toBeCloseTo(0, 3);
  });

  it("computes rms across mixed samples", () => {
    // Half scale square wave: rms = 0.5 → about -6 dBFS.
    const reading = levelFromPcm(pcm(16384, -16384, 16384, -16384));
    expect(reading.rms).toBeCloseTo(0.5, 5);
    expect(reading.dbfs).toBeCloseTo(-6.02, 1);
  });

  it("tracks the peak separately from the average", () => {
    const reading = levelFromPcm(pcm(0, 0, 0, 32767));
    expect(reading.peak).toBeCloseTo(1, 3);
    expect(reading.rms).toBeLessThan(0.6);
  });

  it("ignores a trailing odd byte rather than misreading it", () => {
    const odd = new Uint8Array([0x00, 0x40, 0x7f]);
    expect(levelFromPcm(odd).samples).toBe(1);
  });

  it("counts the samples it used", () => {
    expect(levelFromPcm(pcm(1, 2, 3, 4)).samples).toBe(4);
  });
});

describe("decibel conversion", () => {
  it("floors at the minimum instead of returning -Infinity", () => {
    expect(toDbfs(0)).toBe(MIN_DBFS);
    expect(Number.isFinite(toDbfs(0))).toBe(true);
  });

  it("gives 0 dBFS at full scale and -20 at a tenth", () => {
    expect(toDbfs(1)).toBeCloseTo(0, 6);
    expect(toDbfs(0.1)).toBeCloseTo(-20, 6);
  });

  it("applies the calibration offset linearly", () => {
    expect(toApproxSpl(-30, 120)).toBe(90);
  });

  it("smooths toward the sample and takes the first whole", () => {
    expect(smoothDb(null, -40, 0.5)).toBe(-40);
    expect(smoothDb(-40, -20, 0.5)).toBe(-30);
  });

  it("clamps the smoothing factor", () => {
    expect(smoothDb(-40, -20, 9)).toBe(-20);
    expect(smoothDb(-40, -20, -1)).toBe(-40);
  });
});

describe("permitted exposure", () => {
  it("allows the full reference time at the criterion level", () => {
    expect(permittedSeconds(85, DEFAULT_DOSE)).toBeCloseTo(8 * 3600, 3);
  });

  it("halves the time for each exchange-rate step", () => {
    expect(permittedSeconds(88, DEFAULT_DOSE)).toBeCloseTo(4 * 3600, 3);
    expect(permittedSeconds(91, DEFAULT_DOSE)).toBeCloseTo(2 * 3600, 3);
  });

  it("allows longer below the criterion", () => {
    expect(permittedSeconds(82, DEFAULT_DOSE)).toBeCloseTo(16 * 3600, 3);
  });

  it("honours a 5 dB exchange rate", () => {
    const osha: DoseSettings = { ...DEFAULT_DOSE, exchangeRateDb: 5 };
    expect(permittedSeconds(90, osha)).toBeCloseTo(4 * 3600, 3);
  });
});

describe("dose accumulation", () => {
  it("ignores sound below the threshold entirely", () => {
    expect(doseFraction(60, 3600, DEFAULT_DOSE)).toBe(0);
  });

  it("counts a full day at the criterion level as exactly one dose", () => {
    expect(doseFraction(85, 8 * 3600, DEFAULT_DOSE)).toBeCloseTo(1, 6);
  });

  it("counts loud exposure faster", () => {
    // 91 dB permits 2 hours, so 2 hours there is also a full dose.
    expect(doseFraction(91, 2 * 3600, DEFAULT_DOSE)).toBeCloseTo(1, 6);
  });

  it("ignores a non-positive duration", () => {
    expect(doseFraction(100, 0, DEFAULT_DOSE)).toBe(0);
    expect(doseFraction(100, -5, DEFAULT_DOSE)).toBe(0);
  });

  it("accumulates across blocks and records the peak", () => {
    let dose = createDose();
    dose = accumulate(dose, 85, 4 * 3600, DEFAULT_DOSE, 1000);
    dose = accumulate(dose, 88, 1 * 3600, DEFAULT_DOSE, 2000);

    expect(dose.fraction).toBeCloseTo(0.5 + 0.25, 6);
    expect(dose.peakDb).toBe(88);
    expect(dose.measuredSeconds).toBe(5 * 3600);
    expect(dose.startedAt).toBe(1000);
  });

  it("counts quiet time as measured but not as dose", () => {
    const dose = accumulate(createDose(), 50, 3600, DEFAULT_DOSE, 0);
    expect(dose.measuredSeconds).toBe(3600);
    expect(dose.fraction).toBe(0);
  });

  it("clears on reset", () => {
    const dose = accumulate(createDose(), 90, 600, DEFAULT_DOSE, 0);
    expect(resetDose()).toEqual(createDose());
    expect(dose.fraction).toBeGreaterThan(0);
  });
});

describe("dose bands", () => {
  it("warns at half the limit, not only once it is passed", () => {
    expect(doseLevel({ ...createDose(), fraction: 0 })).toBe("quiet");
    expect(doseLevel({ ...createDose(), fraction: 0.2 })).toBe("accumulating");
    expect(doseLevel({ ...createDose(), fraction: 0.5 })).toBe("high");
    expect(doseLevel({ ...createDose(), fraction: 1 })).toBe("exceeded");
  });
});

describe("remaining exposure", () => {
  it("reports how long is left at the current level", () => {
    const dose = { ...createDose(), fraction: 0.5 };
    expect(remainingSeconds(dose, 85, DEFAULT_DOSE)).toBeCloseTo(4 * 3600, 3);
  });

  it("reports nothing below the threshold, where nothing accrues", () => {
    expect(remainingSeconds(createDose(), 50, DEFAULT_DOSE)).toBeNull();
  });

  it("reports zero once the dose is full", () => {
    expect(remainingSeconds({ ...createDose(), fraction: 1.5 }, 85, DEFAULT_DOSE)).toBe(0);
  });
});

describe("formatting", () => {
  it("scales the unit to the length", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(600)).toBe("10m");
    expect(formatDuration(7200)).toBe("2h 0m");
  });
});
