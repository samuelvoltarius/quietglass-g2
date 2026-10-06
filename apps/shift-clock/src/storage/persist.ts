import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { ClockState, CsvFormat, TimeEntry } from "../tracking/clock";
import type { Locale } from "../i18n";
import { defaultProject } from "../messages";

/**
 * Everything ShiftClock stores stays in the Even app's per-app storage on the
 * phone. There is no network code and no account.
 */

export interface ClockData {
  readonly projects: readonly string[];
  readonly entries: readonly TimeEntry[];
  /**
   * The open entry, persisted so a running clock survives the app closing or
   * the glasses disconnecting. Losing tracked time to a dropped connection
   * would make the app untrustworthy.
   */
  readonly open: ClockState;
  readonly invertScroll: boolean;
  /** Optional hours per day, marked on the day bar. Null: no target. */
  readonly dailyTargetHours: number | null;
  /** Export format the user chose. Null: follow the app language. */
  readonly csvFormat: CsvFormat | null;
}

/** A target outside this range is a typo, not a working day. */
export const MAX_TARGET_HOURS = 16;

const KEY = "quietglass.shiftclock.v1";

export const EMPTY_DATA: ClockData = {
  projects: [],
  entries: [],
  open: { project: null, startedAt: null },
  invertScroll: false,
  dailyTargetHours: null,
  csvFormat: null,
};

export async function save(bridge: EvenAppBridge, data: ClockData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

/**
 * On a first run (nothing stored yet) one project is ready — "Arbeit" or
 * "Work" — so the very first tap on the glasses starts the clock.
 */
export async function load(bridge: EvenAppBridge, locale: Locale = "en"): Promise<ClockData> {
  const raw = await bridge.getLocalStorage(KEY);
  return raw ? parseData(raw) : firstRunData(locale);
}

export function firstRunData(locale: Locale): ClockData {
  return addProject(EMPTY_DATA, defaultProject(locale));
}

export function addProject(data: ClockData, project: string): ClockData {
  const trimmed = project.trim();
  if (!trimmed || data.projects.includes(trimmed)) return data;
  return { ...data, projects: [...data.projects, trimmed] };
}

export function removeProject(data: ClockData, project: string): ClockData {
  return { ...data, projects: data.projects.filter((p) => p !== project) };
}

/** Tolerates partial or corrupted storage rather than losing recorded time. */
export function parseData(raw: string): ClockData {
  if (!raw) return EMPTY_DATA;
  try {
    const value = JSON.parse(raw) as Partial<ClockData>;

    const projects = Array.isArray(value.projects)
      ? value.projects.filter((p): p is string => typeof p === "string" && p.trim() !== "")
      : [];

    const entries: TimeEntry[] = [];
    if (Array.isArray(value.entries)) {
      for (const candidate of value.entries) {
        const e = candidate as Partial<TimeEntry>;
        if (typeof e?.id !== "string" || typeof e.project !== "string") continue;
        if (typeof e.startedAt !== "number" || typeof e.endedAt !== "number") continue;
        // An entry that ends before it starts is corrupt, not merely odd.
        if (e.endedAt < e.startedAt) continue;
        entries.push({ id: e.id, project: e.project, startedAt: e.startedAt, endedAt: e.endedAt });
      }
    }

    return {
      projects,
      entries,
      open: readOpen(value.open),
      invertScroll: typeof value.invertScroll === "boolean" ? value.invertScroll : false,
      dailyTargetHours: readTarget(value.dailyTargetHours),
      csvFormat: value.csvFormat === "excel-de" || value.csvFormat === "standard" ? value.csvFormat : null,
    };
  } catch {
    return EMPTY_DATA;
  }
}

/** Hours in (0, 16], rounded to quarter hours; anything else means "no target". */
export function readTarget(value: unknown): number | null {
  const hours = typeof value === "string" ? Number(value.trim().replace(",", ".")) : value;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours > MAX_TARGET_HOURS) return null;
  const rounded = Math.round(hours * 4) / 4;
  return rounded > 0 ? rounded : null;
}

function readOpen(value: ClockState | undefined): ClockState {
  if (!value || typeof value !== "object") return EMPTY_DATA.open;
  const project = typeof value.project === "string" && value.project ? value.project : null;
  const startedAt = typeof value.startedAt === "number" && Number.isFinite(value.startedAt)
    ? value.startedAt
    : null;
  // Both or neither: a half-open entry has no meaningful duration.
  if (project === null || startedAt === null) return EMPTY_DATA.open;
  return { project, startedAt };
}
