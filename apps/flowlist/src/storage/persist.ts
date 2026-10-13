import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { Checklist } from "../checklist/model";
import type { RunState, StepStatus } from "../checklist/run";
import { SAMPLE_IDS, sampleChecklists } from "../checklist/sample";
import type { Locale } from "../i18n";

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

const KEY = "quietglass.flowlist.v1";

export const DEFAULT_SETTINGS: FlowListSettings = {
  showNext: true,
  lineWidth: 56,
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

/** True while at least one example list is missing — the phone then offers to add them back. */
export function samplesMissing(data: FlowListData): boolean {
  return SAMPLE_IDS.some((id) => !data.lists.some((l) => l.id === id));
}

/** Adds the example lists that are missing, in `locale`; existing lists stay untouched. */
export function addSamples(data: FlowListData, locale: Locale): FlowListData {
  let next = data;
  for (const sample of sampleChecklists(locale)) {
    if (!next.lists.some((l) => l.id === sample.id)) next = upsertList(next, sample);
  }
  return next;
}

export function setSettings(data: FlowListData, patch: Partial<FlowListSettings>): FlowListData {
  return { ...data, settings: { ...data.settings, ...patch } };
}

export async function save(bridge: EvenAppBridge, data: FlowListData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

/**
 * On a first run the example checklists are installed in the device language,
 * so the glasses show something usable immediately and the format is learnable
 * by example. They are written back on save like any other list and can be
 * removed.
 */
export async function load(bridge: EvenAppBridge, locale: Locale = "en"): Promise<FlowListData> {
  const raw = await bridge.getLocalStorage(KEY);
  if (raw) return parseData(raw);
  return firstRunData(locale);
}

export function firstRunData(locale: Locale): FlowListData {
  const lists = sampleChecklists(locale);
  return { lists, activeId: lists[0]?.id ?? null, settings: DEFAULT_SETTINGS };
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
    // 46 was the factory default before 0.2.3 (the display holds about 56), so
    // a stored 46 is taken as "never touched" and moves to the new default.
    lineWidth: typeof value.lineWidth === "number" && Number.isFinite(value.lineWidth)
      ? (value.lineWidth === 46 ? DEFAULT_SETTINGS.lineWidth : value.lineWidth)
      : DEFAULT_SETTINGS.lineWidth,
    invertScroll: typeof value.invertScroll === "boolean"
      ? value.invertScroll
      : DEFAULT_SETTINGS.invertScroll,
  };
}

/**
 * The open run, kept apart from the lists. The Even app unloads FlowList when
 * the phone has been locked for a while; on the next start the run continues
 * at the same step instead of starting over at step 1.
 */
export const RUN_KEY = "quietglass.flowlist.run.v1";
/** A run left alone this long is stale; the next start begins fresh. */
export const RUN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface SavedRun {
  readonly state: RunState;
  readonly savedAt: number;
}

export async function saveRun(bridge: EvenAppBridge, state: RunState, now = Date.now()): Promise<void> {
  const saved: SavedRun = { state, savedAt: now };
  await bridge.setLocalStorage(RUN_KEY, JSON.stringify(saved));
}

export async function loadRun(bridge: EvenAppBridge): Promise<string> {
  return (await bridge.getLocalStorage(RUN_KEY).catch(() => "")) ?? "";
}

/**
 * The saved run if it still fits `list`: same list, every step it names still
 * exists, and not older than RUN_MAX_AGE_MS. Anything else means a fresh run.
 */
export function restoreRun(raw: string, list: Checklist, now = Date.now()): RunState | null {
  if (!raw || list.steps.length === 0) return null;
  try {
    const value = JSON.parse(raw) as Partial<SavedRun>;
    const state = value.state as Partial<RunState> | undefined;
    if (!state || typeof value.savedAt !== "number" || now - value.savedAt > RUN_MAX_AGE_MS || now < value.savedAt - 60_000) return null;
    if (state.listId !== list.id) return null;
    const ids = new Set(list.steps.map((s) => s.id));
    const currentId = state.currentId === null ? null : typeof state.currentId === "string" && ids.has(state.currentId) ? state.currentId : undefined;
    if (currentId === undefined) return null;
    const status: Record<string, StepStatus> = {};
    if (state.status && typeof state.status === "object") {
      for (const [id, s] of Object.entries(state.status)) {
        if (ids.has(id) && (s === "pending" || s === "done" || s === "skipped")) status[id] = s;
      }
    }
    const history = Array.isArray(state.history) ? state.history.filter((id): id is string => typeof id === "string" && ids.has(id)) : [];
    const startedAt = typeof state.startedAt === "number" ? state.startedAt : now;
    const finishedAt = typeof state.finishedAt === "number" ? state.finishedAt : null;
    return {
      listId: list.id,
      currentId,
      status,
      history,
      awaitingConfirm: state.awaitingConfirm === true,
      choiceIndex: typeof state.choiceIndex === "number" && state.choiceIndex >= 0 ? Math.floor(state.choiceIndex) : 0,
      startedAt,
      finishedAt: currentId === null ? (finishedAt ?? now) : null,
    };
  } catch {
    return null;
  }
}
