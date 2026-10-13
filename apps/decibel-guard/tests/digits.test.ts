import { describe, expect, it } from "vitest";
import { pixel } from "../src/glasses/bitmap";
import { LEVEL_IMAGE, drawLevel, fitScale, levelKey, levelLabel, textColumns } from "../src/glasses/digits";
import { METER, drawMeter, meterKey, meterY } from "../src/glasses/gauge";
import { PEAK_FALL_DB_PER_S, PEAK_HOLD_MS, updatePeak } from "../src/glasses/peak";

/** Rows (top, bottom) that contain lit pixels. */
function litRows(bitmap: ReturnType<typeof drawLevel>): [number, number] {
  let top = -1, bottom = -1;
  for (let y = 0; y < bitmap.height; y++) {
    let lit = false;
    for (let x = 0; x < bitmap.width; x++) if (pixel(bitmap, x, y) > 0) { lit = true; break; }
    if (lit) { if (top < 0) top = y; bottom = y; }
  }
  return [top, bottom];
}

describe("level digits", () => {
  it("words the label, marking an estimate", () => {
    expect(levelLabel(72.4, true)).toBe("72 dB");
    expect(levelLabel(72.4, false)).toBe("~72 dB");
    expect(levelLabel(null, true)).toBe("-- dB");
    expect(levelLabel(Number.NaN, false)).toBe("-- dB");
    expect(levelLabel(-4, true)).toBe("0 dB");
  });

  it("is about 60 px tall and fits its image container", () => {
    expect(LEVEL_IMAGE.width).toBeLessThanOrEqual(288);
    expect(LEVEL_IMAGE.height).toBeLessThanOrEqual(144);
    const [top, bottom] = litRows(drawLevel({ listening: true, db: 72, calibrated: true }));
    expect(bottom - top + 1).toBe(56);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThan(LEVEL_IMAGE.height);
  });

  it("shrinks the type instead of overflowing, even for '~100 dB'", () => {
    for (const label of ["72 dB", "~72 dB", "~100 dB", "-- dB"]) {
      const scale = fitScale(label, LEVEL_IMAGE.width - 8);
      expect(textColumns(label) * scale).toBeLessThanOrEqual(LEVEL_IMAGE.width - 8);
    }
    expect(fitScale("72 dB", LEVEL_IMAGE.width - 8)).toBe(8);
  });

  it("draws different numbers differently and equal numbers identically", () => {
    const a = drawLevel({ listening: true, db: 72, calibrated: true }).pixels;
    const b = drawLevel({ listening: true, db: 73, calibrated: true }).pixels;
    expect(Array.from(a)).not.toEqual(Array.from(b));
    expect(Array.from(a)).toEqual(Array.from(drawLevel({ listening: true, db: 72, calibrated: true }).pixels));
  });

  it("dims the placeholder while not measuring, and keys it once", () => {
    const idle = drawLevel({ listening: false, db: 80, calibrated: true });
    expect(Math.max(...idle.pixels)).toBeLessThan(15);
    expect(levelKey({ listening: false, db: 80, calibrated: true })).toBe(levelKey({ listening: false, db: null, calibrated: false }));
    expect(levelKey({ listening: true, db: 72, calibrated: true })).not.toBe(levelKey({ listening: true, db: 73, calibrated: true }));
  });
});

describe("peak hold", () => {
  it("rises at once and holds still for a while", () => {
    const p1 = updatePeak(null, 80, 1000)!;
    expect(p1.db).toBe(80);
    const p2 = updatePeak(p1, 60, 1000 + PEAK_HOLD_MS - 1)!;
    expect(p2.db).toBe(80);
    expect(updatePeak(p2, 85, 4000)!.db).toBe(85);
  });

  it("then falls slowly, never below the present level", () => {
    const p1 = updatePeak(null, 80, 0)!;
    const p2 = updatePeak(p1, 50, PEAK_HOLD_MS + 2000)!;
    expect(p2.db).toBeCloseTo(80 - 2 * PEAK_FALL_DB_PER_S, 5);
    // The fall continues from the new height, not from the start again.
    const p3 = updatePeak(p2, 50, PEAK_HOLD_MS + 4000)!;
    expect(p3.db).toBeCloseTo(80 - 4 * PEAK_FALL_DB_PER_S, 5);
    expect(updatePeak(p1, 78, PEAK_HOLD_MS + 60_000)!.db).toBe(78);
    expect(updatePeak(p1, null, 99)).toBe(p1);
  });

  it("is a line on the meter that changes the picture only when it moves", () => {
    const base = { listening: true, level: 60, criterionDb: 85 } as const;
    expect(meterKey({ ...base, peak: 75 })).not.toBe(meterKey({ ...base, peak: 78 }));
    expect(meterKey({ ...base, peak: 75 })).toBe(meterKey({ ...base, peak: 75 }));
    const without = drawMeter({ ...base, peak: null });
    const withPeak = drawMeter({ ...base, peak: 75 });
    const y = meterY(75);
    expect(pixel(withPeak, 27, y)).toBe(15);
    expect(pixel(without, 27, y)).toBe(0);
    expect([withPeak.width, withPeak.height]).toEqual([METER.width, METER.height]);
  });
});
