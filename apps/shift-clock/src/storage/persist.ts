import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { ClockState, TimeEntry } from "../tracking/clock";

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
}

const KEY = "quietglass.shiftclock.v1";

export const EMPTY_DATA: ClockData = {
  projects: [],
  entries: [],
  open: { project: null, startedAt: null },
  invertScroll: false,
};

export async function save(bridge: EvenAppBridge, data: ClockData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

export async function load(bridge: EvenAppBridge): Promise<ClockData> {
  return parseData(await bridge.getLocalStorage(KEY));
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
    };
  } catch {
    return EMPTY_DATA;
  }
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
