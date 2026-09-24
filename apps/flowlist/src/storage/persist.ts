import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { Checklist } from "../checklist/model";
import { SAMPLE_CHECKLIST } from "../checklist/sample";

/**
 * Everything FlowList stores lives in the Even app's per-app storage on the
 * phone. The app has no network code; checklists are shared by exporting a
 * pack file, never by uploading.
 */

export interface FlowListSettings {
  readonly showNext: boolean;
  readonly lineWidth: number;
  /**
   * Real hardware reports swipes inverted relative to the simulator. Exposed
   * as a setting so a user can correct it without a rebuild.
   */
  readonly invertScroll: boolean;
}

export interface FlowListData {
  readonly lists: readonly Checklist[];
  readonly activeId: string | null;
  readonly settings: FlowListSettings;
}

const KEY = "aignerlabs.flowlist.v1";

export const DEFAULT_SETTINGS: FlowListSettings = {
  showNext: true,
  lineWidth: 46,
  invertScroll: false,
};

export const EMPTY_DATA: FlowListData = {
  lists: [],
  activeId: null,
  settings: DEFAULT_SETTINGS,
};

export function activeList(data: FlowListData): Checklist | null {
  if (!data.activeId) return data.lists[0] ?? null;
  return data.lists.find((l) => l.id === data.activeId) ?? data.lists[0] ?? null;
}

export function nextListId(data: FlowListData): string {
  let n = data.lists.length + 1;
  const taken = new Set(data.lists.map((l) => l.id));
  while (taken.has("l" + n)) n++;
  return "l" + n;
}

export function upsertList(data: FlowListData, list: Checklist): FlowListData {
  const index = data.lists.findIndex((l) => l.id === list.id);
  const lists = index === -1
    ? [...data.lists, list]
    : [...data.lists.slice(0, index), list, ...data.lists.slice(index + 1)];
  return { ...data, lists, activeId: data.activeId ?? list.id };
}

export function removeList(data: FlowListData, id: string): FlowListData {
  const lists = data.lists.filter((l) => l.id !== id);
  const activeId = data.activeId === id ? (lists[0]?.id ?? null) : data.activeId;
  return { ...data, lists, activeId };
}

export function setSettings(data: FlowListData, patch: Partial<FlowListSettings>): FlowListData {
  return { ...data, settings: { ...data.settings, ...patch } };
}

export async function save(bridge: EvenAppBridge, data: FlowListData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

/**
 * On a first run the sample checklist is installed, so the glasses show
 * something usable immediately and the pack format is learnable by example.
 * It is written back on save like any other list and can be removed.
 */
export async function load(bridge: EvenAppBridge): Promise<FlowListData> {
  const raw = await bridge.getLocalStorage(KEY);
  if (raw) return parseData(raw);
  return { lists: [SAMPLE_CHECKLIST], activeId: SAMPLE_CHECKLIST.id, settings: DEFAULT_SETTINGS };
}

/** Tolerates partial or corrupted storage rather than discarding everything. */
export function parseData(raw: string): FlowListData {
  if (!raw) return EMPTY_DATA;
  try {
    const value = JSON.parse(raw) as Partial<FlowListData>;
    const lists: Checklist[] = [];

    if (Array.isArray(value.lists)) {
      for (const candidate of value.lists) {
        const l = candidate as Partial<Checklist>;
        if (typeof l?.id !== "string" || !Array.isArray(l.steps)) continue;
        lists.push({
          id: l.id,
          title: typeof l.title === "string" ? l.title : "Untitled checklist",
          steps: l.steps,
          ...(typeof l.description === "string" ? { description: l.description } : {}),
        });
      }
    }

    const activeId = typeof value.activeId === "string" && lists.some((l) => l.id === value.activeId)
      ? value.activeId
      : (lists[0]?.id ?? null);

    return { lists, activeId, settings: mergeSettings(value.settings) };
  } catch {
    return EMPTY_DATA;
  }
}

function mergeSettings(value: Partial<FlowListSettings> | undefined): FlowListSettings {
  if (!value || typeof value !== "object") return DEFAULT_SETTINGS;
  return {
    showNext: typeof value.showNext === "boolean" ? value.showNext : DEFAULT_SETTINGS.showNext,
    lineWidth: typeof value.lineWidth === "number" && Number.isFinite(value.lineWidth)
      ? value.lineWidth
      : DEFAULT_SETTINGS.lineWidth,
    invertScroll: typeof value.invertScroll === "boolean"
      ? value.invertScroll
      : DEFAULT_SETTINGS.invertScroll,
  };
}
