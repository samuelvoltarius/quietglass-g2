import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { DEFAULT_SETTINGS, type PostureSettings } from "../posture/monitor";
import type { Vec3 } from "../imu/vector";

/**
 * Everything PostureLens stores stays in the Even app's per-app storage on the
 * phone: the calibrated upright direction and the thresholds. No posture
 * history is written anywhere — the tally lives in memory for the session and
 * is gone when the app closes.
 */

export interface PostureData {
  readonly settings: PostureSettings;
  /** Calibrated upright direction, so calibration survives a restart. */
  readonly reference: Vec3 | null;
  readonly showAngleWhenGood: boolean;
  readonly invertScroll: boolean;
}

const KEY = "aignerlabs.posturelens.v1";

export const EMPTY_DATA: PostureData = {
  settings: DEFAULT_SETTINGS,
  reference: null,
  showAngleWhenGood: false,
  invertScroll: false,
};

export async function save(bridge: EvenAppBridge, data: PostureData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

export async function load(bridge: EvenAppBridge): Promise<PostureData> {
  return parseData(await bridge.getLocalStorage(KEY));
}

export function setSettings(data: PostureData, patch: Partial<PostureSettings>): PostureData {
  return { ...data, settings: { ...data.settings, ...patch } };
}

/** Tolerates partial or corrupted storage rather than losing the calibration. */
export function parseData(raw: string): PostureData {
  if (!raw) return EMPTY_DATA;
  try {
    const value = JSON.parse(raw) as Partial<PostureData>;
    return {
      settings: mergeSettings(value.settings),
      reference: readVector(value.reference),
      showAngleWhenGood: typeof value.showAngleWhenGood === "boolean"
        ? value.showAngleWhenGood
        : EMPTY_DATA.showAngleWhenGood,
      invertScroll: typeof value.invertScroll === "boolean"
        ? value.invertScroll
        : EMPTY_DATA.invertScroll,
    };
  } catch {
    return EMPTY_DATA;
  }
}

function readVector(value: unknown): Vec3 | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const x = numberOr(v["x"], null);
  const y = numberOr(v["y"], null);
  const z = numberOr(v["z"], null);
  if (x === null || y === null || z === null) return null;
  // A zero vector carries no direction and would make every angle undefined.
  if (x === 0 && y === 0 && z === 0) return null;
  return { x, y, z };
}

function mergeSettings(value: Partial<PostureSettings> | undefined): PostureSettings {
  if (!value || typeof value !== "object") return DEFAULT_SETTINGS;
  return {
    warnAngle: clamp(numberOr(value.warnAngle, DEFAULT_SETTINGS.warnAngle) ?? DEFAULT_SETTINGS.warnAngle, 5, 80),
    sustainSeconds: clamp(numberOr(value.sustainSeconds, DEFAULT_SETTINGS.sustainSeconds) ?? DEFAULT_SETTINGS.sustainSeconds, 5, 900),
    snoozeSeconds: clamp(numberOr(value.snoozeSeconds, DEFAULT_SETTINGS.snoozeSeconds) ?? DEFAULT_SETTINGS.snoozeSeconds, 30, 3600),
    smoothing: clamp(numberOr(value.smoothing, DEFAULT_SETTINGS.smoothing) ?? DEFAULT_SETTINGS.smoothing, 0.01, 1),
  };
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
