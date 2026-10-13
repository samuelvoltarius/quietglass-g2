import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { DEFAULT_DOSE, type DoseSettings, type DoseState } from "../noise/dose";

/**
 * DecibelGuard stores thresholds and the calibration offset — nothing else.
 *
 * Deliberately **no audio and no level history** are written. A record of how
 * loud it was around someone, minute by minute, is a record of where they were
 * and what they were doing. Only today's running total (one number, see
 * `saveDose`) is kept until midnight, so a restart does not wipe it.
 */

export interface NoiseData {
  readonly dose: DoseSettings;
  /**
   * dB to add to a dBFS reading to approximate SPL. Zero means uncalibrated,
   * and the display marks readings as such.
   */
  readonly calibrationOffset: number;
  /** EMA factor for the displayed level. */
  readonly smoothing: number;
  readonly invertScroll: boolean;
}

const KEY = "quietglass.decibelguard.v1";

export const EMPTY_DATA: NoiseData = {
  dose: DEFAULT_DOSE,
  calibrationOffset: 0,
  smoothing: 0.2,
  invertScroll: false,
};

export function isCalibrated(data: NoiseData): boolean {
  return data.calibrationOffset !== 0;
}

/**
 * Offset used until the user calibrates, so the app is useful straight after
 * install instead of showing negative dBFS and never accruing a dose.
 *
 * 120 dB corresponds to a typical MEMS microphone sensitivity of -26 dBFS at
 * 94 dB SPL. It is an assumption, not a measurement: the G2 microphone's real
 * sensitivity is unpublished. Every reading taken with it is labelled as an
 * estimate on the glasses and on the phone. Erring high is deliberate — for
 * hearing, a warning that comes early is better than one that comes late.
 */
export const ESTIMATED_OFFSET = 120;

/** The offset actually applied to readings: the user's calibration, or the estimate. */
export function effectiveOffset(data: NoiseData): number {
  return isCalibrated(data) ? data.calibrationOffset : ESTIMATED_OFFSET;
}

export async function save(bridge: EvenAppBridge, data: NoiseData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

export async function load(bridge: EvenAppBridge): Promise<NoiseData> {
  return parseData(await bridge.getLocalStorage(KEY));
}

export function setDose(data: NoiseData, patch: Partial<DoseSettings>): NoiseData {
  return { ...data, dose: { ...data.dose, ...patch } };
}

export function parseData(raw: string): NoiseData {
  if (!raw) return EMPTY_DATA;
  try {
    const value = JSON.parse(raw) as Partial<NoiseData>;
    return {
      dose: mergeDose(value.dose),
      calibrationOffset: clamp(numberOr(value.calibrationOffset, 0), 0, 200),
      smoothing: clamp(numberOr(value.smoothing, EMPTY_DATA.smoothing), 0.01, 1),
      invertScroll: typeof value.invertScroll === "boolean" ? value.invertScroll : false,
    };
  } catch {
    return EMPTY_DATA;
  }
}

function mergeDose(value: Partial<DoseSettings> | undefined): DoseSettings {
  if (!value || typeof value !== "object") return DEFAULT_DOSE;
  return {
    criterionDb: clamp(numberOr(value.criterionDb, DEFAULT_DOSE.criterionDb), 70, 100),
    criterionHours: clamp(numberOr(value.criterionHours, DEFAULT_DOSE.criterionHours), 1, 24),
    // Only the two rules actually in use; an arbitrary value here would
    // silently change what "a full dose" means.
    exchangeRateDb: value.exchangeRateDb === 5 ? 5 : 3,
    thresholdDb: clamp(numberOr(value.thresholdDb, DEFAULT_DOSE.thresholdDb), 40, 90),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Today's dose so far: one running total plus the local date, nothing about
 * when or where it was loud. The Even app unloads DecibelGuard after the
 * phone was locked for a while; without this the "x % of today's limit"
 * would silently start again at 0. A new day starts at 0.
 */
export const DOSE_KEY = "quietglass.decibelguard.today.v1";

export function dayKey(now: number): string {
  const d = new Date(now);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

export async function saveDose(bridge: EvenAppBridge, dose: DoseState, now = Date.now()): Promise<void> {
  await bridge.setLocalStorage(DOSE_KEY, JSON.stringify({
    day: dayKey(now),
    fraction: dose.fraction,
    measuredSeconds: Math.round(dose.measuredSeconds),
    peakDb: dose.peakDb,
  }));
}

export async function loadDoseRaw(bridge: EvenAppBridge): Promise<string> {
  return (await bridge.getLocalStorage(DOSE_KEY).catch(() => "")) ?? "";
}

/** The stored dose if it is from today (local time), else null. */
export function parseDose(raw: string, now = Date.now()): DoseState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { day?: unknown; fraction?: unknown; measuredSeconds?: unknown; peakDb?: unknown };
    if (v.day !== dayKey(now)) return null;
    const fraction = numberOr(v.fraction, -1);
    if (fraction < 0) return null;
    return {
      fraction,
      measuredSeconds: Math.max(0, numberOr(v.measuredSeconds, 0)),
      peakDb: typeof v.peakDb === "number" && Number.isFinite(v.peakDb) ? v.peakDb : null,
      startedAt: null,
    };
  } catch {
    return null;
  }
}
