import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { clampBpm, DEFAULT_SETTINGS, type MetronomeSettings, type TimeSignature } from "../metronome/engine";
import type { PracticeSession } from "../practice/log";
import { isCsvFormat, type CsvFormat } from "../csv";

/**
 * Everything Cadence stores stays in the Even app's per-app storage on the
 * phone: the tempo settings, the user's practice items and the session log.
 * There is no network code.
 */

export interface CadenceData {
  readonly settings: MetronomeSettings;
  /** The user's own list of things they practise. */
  readonly items: readonly string[];
  /** Which item is selected; empty means no item is being tracked. */
  readonly activeItem: string;
  readonly sessions: readonly PracticeSession[];
  readonly invertScroll: boolean;
  /** CSV format picked on the phone; absent means the default for the app language. */
  readonly csvFormat?: CsvFormat;
}

const KEY = "quietglass.cadence.v1";

export const EMPTY_DATA: CadenceData = {
  settings: DEFAULT_SETTINGS,
  items: [],
  activeItem: "",
  sessions: [],
  invertScroll: false,
};

export async function save(bridge: EvenAppBridge, data: CadenceData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

export async function load(bridge: EvenAppBridge): Promise<CadenceData> {
  return parseData(await bridge.getLocalStorage(KEY));
}

export function setSettings(data: CadenceData, patch: Partial<MetronomeSettings>): CadenceData {
  return { ...data, settings: { ...data.settings, ...patch } };
}

export function addItem(data: CadenceData, item: string): CadenceData {
  const trimmed = item.trim();
  if (!trimmed || data.items.includes(trimmed)) return data;
  return { ...data, items: [...data.items, trimmed], activeItem: data.activeItem || trimmed };
}

export function removeItem(data: CadenceData, item: string): CadenceData {
  const items = data.items.filter((i) => i !== item);
  return {
    ...data,
    items,
    activeItem: data.activeItem === item ? (items[0] ?? "") : data.activeItem,
  };
}

/** Tolerates partial or corrupted storage rather than losing the practice log. */
export function parseData(raw: string): CadenceData {
  if (!raw) return EMPTY_DATA;
  try {
    const value = JSON.parse(raw) as Partial<CadenceData>;

    const items = Array.isArray(value.items)
      ? value.items.filter((i): i is string => typeof i === "string" && i.trim() !== "")
      : [];

    const sessions: PracticeSession[] = [];
    if (Array.isArray(value.sessions)) {
      for (const candidate of value.sessions) {
        const s = candidate as Partial<PracticeSession>;
        if (typeof s?.id !== "string") continue;
        if (typeof s.startedAt !== "number" || typeof s.endedAt !== "number") continue;
        sessions.push({
          id: s.id,
          item: typeof s.item === "string" ? s.item : "",
          bpm: clampBpm(typeof s.bpm === "number" ? s.bpm : DEFAULT_SETTINGS.bpm),
          startedAt: s.startedAt,
          endedAt: s.endedAt,
        });
      }
    }

    const activeItem = typeof value.activeItem === "string" ? value.activeItem : "";

    return {
      settings: mergeSettings(value.settings),
      items,
      activeItem: items.includes(activeItem) ? activeItem : (items[0] ?? ""),
      sessions,
      invertScroll: typeof value.invertScroll === "boolean" ? value.invertScroll : false,
      ...(isCsvFormat(value.csvFormat) ? { csvFormat: value.csvFormat } : {}),
    };
  } catch {
    return EMPTY_DATA;
  }
}

function mergeSettings(value: Partial<MetronomeSettings> | undefined): MetronomeSettings {
  if (!value || typeof value !== "object") return DEFAULT_SETTINGS;
  return {
    bpm: clampBpm(typeof value.bpm === "number" ? value.bpm : DEFAULT_SETTINGS.bpm),
    signature: readSignature(value.signature),
    mark: value.mark === "bar" ? "bar" : "beat",
  };
}

function readSignature(value: TimeSignature | undefined): TimeSignature {
  if (!value || typeof value !== "object") return DEFAULT_SETTINGS.signature;
  const beats = typeof value.beats === "number" && Number.isFinite(value.beats)
    ? Math.min(16, Math.max(1, Math.round(value.beats)))
    : DEFAULT_SETTINGS.signature.beats;
  const unit = value.unit === 2 || value.unit === 4 || value.unit === 8 || value.unit === 16
    ? value.unit
    : DEFAULT_SETTINGS.signature.unit;
  return { beats, unit };
}

/**
 * The running beat and the open practice session, kept apart from the data.
 * The Even app unloads Cadence after the phone was locked for a while; the
 * next start picks the beat and the session up again.
 */
export const RUN_KEY = "quietglass.cadence.run.v1";
/** Longer away than this and the session is closed at the last sign of life. */
export const RUN_RESUME_MS = 30 * 60 * 1000;

export interface SavedRun {
  readonly running: boolean;
  readonly startedAt: number | null;
  readonly beatsBefore: number;
  readonly sessionStartedAt: number | null;
  readonly savedAt: number;
}

export async function saveRun(bridge: EvenAppBridge, run: SavedRun): Promise<void> {
  await bridge.setLocalStorage(RUN_KEY, JSON.stringify(run));
}

export async function loadRunRaw(bridge: EvenAppBridge): Promise<string> {
  return (await bridge.getLocalStorage(RUN_KEY).catch(() => "")) ?? "";
}

export function parseRun(raw: string): SavedRun | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SavedRun>;
    if (typeof v.savedAt !== "number" || !Number.isFinite(v.savedAt)) return null;
    const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
    const startedAt = num(v.startedAt);
    const running = v.running === true && startedAt !== null;
    return {
      running,
      startedAt: running ? startedAt : null,
      beatsBefore: Math.max(0, num(v.beatsBefore) ?? 0),
      sessionStartedAt: num(v.sessionStartedAt),
      savedAt: v.savedAt,
    };
  } catch {
    return null;
  }
}
