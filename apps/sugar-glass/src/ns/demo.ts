import type { SugarApi } from "./client";
import type { Direction, PumpStatus, Reading, Treatments } from "./model";

/**
 * A believable day for `?demo=1`, no Nightscout needed. Readings sit on the
 * real 5-minute grid, so a new value arrives every five minutes like a
 * sensor. `scene` picks the situation the last hour leads into.
 */
export type DemoScene = "normal" | "low" | "urgent" | "high" | "stale" | "falling";
export const DEMO_SCENES: readonly DemoScene[] = ["normal", "low", "urgent", "high", "stale", "falling"];

/** Minutes before now → mg/dL; interpolated in between. */
const SHAPES: Readonly<Record<DemoScene, ReadonlyArray<readonly [number, number]>>> = {
  normal: [[-260, 128], [-220, 116], [-185, 104], [-160, 112], [-140, 151], [-115, 183], [-95, 171], [-70, 146], [-45, 124], [-25, 113], [-10, 109], [0, 106]],
  low: [[-260, 142], [-220, 151], [-190, 139], [-150, 124], [-110, 116], [-80, 111], [-50, 104], [-30, 102], [-15, 86], [-10, 77], [-5, 67], [0, 59]],
  urgent: [[-260, 118], [-220, 104], [-180, 96], [-140, 98], [-100, 92], [-70, 86], [-45, 79], [-20, 70], [-10, 58], [0, 46]],
  high: [[-260, 134], [-220, 142], [-190, 168], [-160, 205], [-130, 231], [-100, 244], [-70, 238], [-45, 247], [-25, 258], [-10, 266], [0, 272]],
  stale: [[-260, 118], [-220, 131], [-180, 149], [-140, 162], [-100, 155], [-70, 147], [-45, 143], [-24, 141]],
  falling: [[-260, 121], [-220, 133], [-180, 158], [-150, 176], [-120, 181], [-90, 179], [-60, 174], [-35, 172], [-20, 164], [-10, 146], [-5, 127], [0, 107], [5, 87]],
};

function at(shape: ReadonlyArray<readonly [number, number]>, minute: number): number | null {
  const first = shape[0];
  const last = shape[shape.length - 1];
  if (!first || !last || minute < first[0] || minute > last[0]) return null;
  for (let i = 1; i < shape.length; i += 1) {
    const a = shape[i - 1]!;
    const b = shape[i]!;
    if (minute <= b[0]) {
      const f = (minute - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * f;
    }
  }
  return last[1];
}

/** Nightscout's own rule: mg/dL per minute over the last readings. */
export function directionFor(perMinute: number): Direction {
  if (perMinute > 3) return "DoubleUp";
  if (perMinute > 2) return "SingleUp";
  if (perMinute > 1) return "FortyFiveUp";
  if (perMinute >= -1) return "Flat";
  if (perMinute >= -2) return "FortyFiveDown";
  if (perMinute >= -3) return "SingleDown";
  return "DoubleDown";
}

export function demoReadings(scene: DemoScene, now: number, count = 60): Reading[] {
  const shape = SHAPES[scene];
  const step = 5 * 60_000;
  // The newest reading is 1–5 minutes old, on the real grid.
  const newest = Math.floor((now - 60_000) / step) * step + 60_000;
  const out: Reading[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = newest - i * step;
    const minute = (t - now) / 60_000;
    const value = at(shape, minute);
    if (value === null) continue;
    // A little sensor wobble that depends only on the time stamp.
    const wobble = Math.sin(t / 397_000) * 2 + Math.sin(t / 911_000) * 1.5;
    out.push({ at: t, mgdl: Math.round(value + wobble), direction: "NONE" });
  }
  return out.map((reading, index) => {
    const older = out[index + 1];
    const perMinute = older ? (reading.mgdl - older.mgdl) / ((reading.at - older.at) / 60_000) : 0;
    return { ...reading, direction: directionFor(perMinute) };
  });
}

export function demoPump(scene: DemoScene, now: number): PumpStatus {
  return {
    at: now - 2 * 60_000,
    device: "MiniMed 780G (Demo)",
    iob: scene === "high" ? 3.4 : scene === "falling" ? 2.6 : scene === "urgent" ? 0.3 : 1.2,
    reservoir: 87,
    battery: 75,
    uploaderBattery: 58,
    mode: scene === "urgent" ? "safe" : "auto",
    sensorHours: 101,
    sensorState: scene === "stale" ? "LOST_SENSOR_SIGNAL" : "NO_ERROR_MESSAGE",
    calibHours: null,
  };
}

export function demoTreatments(now: number): Treatments {
  return { lastCarbs: { at: now - 142 * 60_000, grams: 45 }, lastBolus: { at: now - 144 * 60_000, units: 4.5 } };
}

export function createDemo(clock: () => number, scene: DemoScene): SugarApi {
  return {
    demo: true,
    readings: async (count) => demoReadings(scene, clock(), count),
    pump: async () => demoPump(scene, clock()),
    treatments: async () => demoTreatments(clock()),
  };
}
