import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { PrompterMode } from "../prompter/engine";
import { SAMPLE_SCRIPT_SOURCE, SAMPLE_SCRIPT_TITLE } from "../script/sample";

/**
 * Everything PromptFlow stores lives in the Even app's per-app storage on the
 * phone. Nothing leaves the device: the app has no network code at all.
 */

export interface StoredScript {
  readonly id: string;
  readonly title: string;
  /** Raw Markdown or plain text, exactly as the user pasted it. */
  readonly source: string;
  readonly updatedAt: number;
}

export interface PromptFlowSettings {
  readonly mode: PrompterMode;
  readonly wpm: number;
  readonly visibleLines: number;
  readonly showCursor: boolean;
  /**
   * Real hardware reports swipes inverted; the simulator does not. Exposed as
   * a setting so the user can correct it without a rebuild.
   */
  readonly invertScroll: boolean;
  /** Characters per display line; tuned by the user for their font size. */
  readonly lineWidth: number;
}

export interface PromptFlowData {
  readonly scripts: readonly StoredScript[];
  readonly activeId: string | null;
  readonly settings: PromptFlowSettings;
}

const KEY = "quietglass.promptflow.v1";

export const DEFAULT_SETTINGS: PromptFlowSettings = {
  mode: "speech",
  wpm: 130,
  visibleLines: 5,
  showCursor: false,
  invertScroll: false,
  lineWidth: 46,
};

export const EMPTY_DATA: PromptFlowData = {
  scripts: [],
  activeId: null,
  settings: DEFAULT_SETTINGS,
};

export function activeScript(data: PromptFlowData): StoredScript | null {
  if (!data.activeId) return data.scripts[0] ?? null;
  return data.scripts.find((s) => s.id === data.activeId) ?? data.scripts[0] ?? null;
}

export function nextScriptId(data: PromptFlowData): string {
  let n = data.scripts.length + 1;
  const taken = new Set(data.scripts.map((s) => s.id));
  while (taken.has(`s${n}`)) n++;
  return `s${n}`;
}

export function upsertScript(data: PromptFlowData, script: StoredScript): PromptFlowData {
  const index = data.scripts.findIndex((s) => s.id === script.id);
  const scripts = index === -1
    ? [...data.scripts, script]
    : [...data.scripts.slice(0, index), script, ...data.scripts.slice(index + 1)];
  return { ...data, scripts, activeId: data.activeId ?? script.id };
}

export function removeScript(data: PromptFlowData, id: string): PromptFlowData {
  const scripts = data.scripts.filter((s) => s.id !== id);
  const activeId = data.activeId === id ? (scripts[0]?.id ?? null) : data.activeId;
  return { ...data, scripts, activeId };
}

export function setSettings(data: PromptFlowData, patch: Partial<PromptFlowSettings>): PromptFlowData {
  return { ...data, settings: { ...data.settings, ...patch } };
}

export async function save(bridge: EvenAppBridge, data: PromptFlowData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

/**
 * On a first run the sample script is installed, so the glasses show something
 * readable immediately and the script format is learnable by example. It is
 * saved like any other script and can be removed.
 */
export async function load(bridge: EvenAppBridge): Promise<PromptFlowData> {
  const raw = await bridge.getLocalStorage(KEY);
  if (raw) return parseData(raw);
  return {
    scripts: [{
      id: "sample",
      title: SAMPLE_SCRIPT_TITLE,
      source: SAMPLE_SCRIPT_SOURCE,
      updatedAt: 0,
    }],
    activeId: "sample",
    settings: DEFAULT_SETTINGS,
  };
}

/** Tolerates partial or corrupted storage rather than starting from nothing. */
export function parseData(raw: string): PromptFlowData {
  if (!raw) return EMPTY_DATA;
  try {
    const value = JSON.parse(raw) as Partial<PromptFlowData>;
    const scripts: StoredScript[] = [];
    if (Array.isArray(value.scripts)) {
      for (const candidate of value.scripts) {
        const s = candidate as Partial<StoredScript>;
        if (typeof s?.id !== "string" || typeof s?.source !== "string") continue;
        scripts.push({
          id: s.id,
          title: typeof s.title === "string" ? s.title : "",
          source: s.source,
          updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
        });
      }
    }
    const activeId = typeof value.activeId === "string" && scripts.some((s) => s.id === value.activeId)
      ? value.activeId
      : (scripts[0]?.id ?? null);

    return { scripts, activeId, settings: mergeSettings(value.settings) };
  } catch {
    return EMPTY_DATA;
  }
}

function mergeSettings(value: Partial<PromptFlowSettings> | undefined): PromptFlowSettings {
  if (!value || typeof value !== "object") return DEFAULT_SETTINGS;
  return {
    mode: isMode(value.mode) ? value.mode : DEFAULT_SETTINGS.mode,
    wpm: numberOr(value.wpm, DEFAULT_SETTINGS.wpm),
    visibleLines: numberOr(value.visibleLines, DEFAULT_SETTINGS.visibleLines),
    showCursor: typeof value.showCursor === "boolean" ? value.showCursor : DEFAULT_SETTINGS.showCursor,
    invertScroll: typeof value.invertScroll === "boolean" ? value.invertScroll : DEFAULT_SETTINGS.invertScroll,
    lineWidth: numberOr(value.lineWidth, DEFAULT_SETTINGS.lineWidth),
  };
}

function isMode(value: unknown): value is PrompterMode {
  return value === "presenter" || value === "speech" || value === "video" || value === "notes";
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
