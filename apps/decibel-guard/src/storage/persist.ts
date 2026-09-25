import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { DEFAULT_DOSE, type DoseSettings } from "../noise/dose";

/**
 * DecibelGuard stores thresholds and the calibration offset — nothing else.
 *
 * Deliberately **no audio and no level history** are written. A record of how
 * loud it was around someone, minute by minute, is a record of where they were
 * and what they were doing. The dose exists in memory for the session only.
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
