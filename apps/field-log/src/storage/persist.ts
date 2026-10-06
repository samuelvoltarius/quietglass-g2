import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { Inspection, Severity } from "../log/entries";
import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * Inspections live in the Even app's per-app storage on the phone.
 *
 * Photos are stored as data URIs inside the inspection, which is why the log
 * is bounded and the phone app warns before a very large report: per-app
 * storage is not a filesystem.
 */

export interface FieldLogData {
  readonly inspections: readonly Inspection[];
  /** Currently open inspection, or null. */
  readonly activeId: string | null;
  /** Speech server; empty uses the mock. */
  readonly sttUrl: string;
  readonly sttToken?: string;
  readonly language: string;
  /** Severity applied to the next entry. */
  readonly severity: Severity;
  readonly invertScroll: boolean;
  /** The user's own quick notes; empty means the defaults in the app language. */
  readonly quickNotes: readonly string[];
}

const KEY = "quietglass.fieldlog.v1";

export const EMPTY_DATA: FieldLogData = {
  inspections: [],
  activeId: null,
  sttUrl: "",
  language: "auto",
  severity: "note",
  invertScroll: false,
  quickNotes: [],
};

/** No speech server set up: dictation is unavailable and quick notes are used. */
export function usesMockStt(data: FieldLogData): boolean {
  return data.sttUrl.trim() === "";
}

export function hasSpeechServer(data: FieldLogData): boolean {
  return !usesMockStt(data);
}

export function activeInspection(data: FieldLogData): Inspection | null {
  if (!data.activeId) return null;
  return data.inspections.find((i) => i.id === data.activeId) ?? null;
}

export function upsertInspection(data: FieldLogData, inspection: Inspection): FieldLogData {
  const index = data.inspections.findIndex((i) => i.id === inspection.id);
  const inspections = index === -1
    ? [...data.inspections, inspection]
    : [...data.inspections.slice(0, index), inspection, ...data.inspections.slice(index + 1)];
  return { ...data, inspections };
}

export function removeInspection(data: FieldLogData, id: string): FieldLogData {
  return {
    ...data,
    inspections: data.inspections.filter((i) => i.id !== id),
    activeId: data.activeId === id ? null : data.activeId,
  };
}

export function nextInspectionId(data: FieldLogData): string {
  let n = data.inspections.length + 1;
  const taken = new Set(data.inspections.map((i) => i.id));
  while (taken.has("i" + n)) n++;
  return "i" + n;
}

/** Rough stored size, so the phone app can warn before storage fills up. */
export function approximateBytes(data: FieldLogData): number {
  let total = 0;
  for (const inspection of data.inspections) {
    for (const entry of inspection.entries) {
      total += entry.text.length;
      total += entry.attachment?.size ?? 0;
    }
  }
  return total;
}

export async function save(bridge: EvenAppBridge, data: FieldLogData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

export async function load(bridge: EvenAppBridge): Promise<FieldLogData> {
  return parseData(await bridge.getLocalStorage(KEY));
}

export function validateWsUrl(url: string, locale: Locale = "en"): { valid: boolean; errors: string[] } {
  const trimmed = url.trim();
  if (!trimmed) return { valid: true, errors: [] };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return { valid: false, errors: [t(locale, "v.scheme")] };
    }
    return { valid: true, errors: [] };
  } catch {
    return { valid: false, errors: [t(locale, "v.invalid")] };
  }
}

export function parseData(raw: string): FieldLogData {
  if (!raw) return EMPTY_DATA;
  try {
    const value = JSON.parse(raw) as Partial<FieldLogData>;

    const inspections: Inspection[] = [];
    if (Array.isArray(value.inspections)) {
      for (const candidate of value.inspections) {
        const i = candidate as Partial<Inspection>;
        if (typeof i?.id !== "string" || typeof i.startedAt !== "number") continue;
        inspections.push({
          id: i.id,
          title: typeof i.title === "string" ? i.title : "Inspection",
          startedAt: i.startedAt,
          finishedAt: typeof i.finishedAt === "number" ? i.finishedAt : null,
          entries: Array.isArray(i.entries) ? i.entries : [],
          section: typeof i.section === "string" ? i.section : "",
        });
      }
    }

    const activeId = typeof value.activeId === "string"
      && inspections.some((i) => i.id === value.activeId)
      ? value.activeId
      : null;

    const sttUrl = typeof value.sttUrl === "string" && validateWsUrl(value.sttUrl).valid
      ? value.sttUrl.trim()
      : "";

    return {
      inspections,
      activeId,
      sttUrl,
      ...(typeof value.sttToken === "string" && value.sttToken ? { sttToken: value.sttToken } : {}),
      language: typeof value.language === "string" && value.language ? value.language : "auto",
      severity: isSeverity(value.severity) ? value.severity : "note",
      invertScroll: typeof value.invertScroll === "boolean" ? value.invertScroll : false,
      quickNotes: Array.isArray(value.quickNotes)
        ? value.quickNotes.filter((note): note is string => typeof note === "string" && note.trim() !== "")
        : [],
    };
  } catch {
    return EMPTY_DATA;
  }
}

function isSeverity(value: unknown): value is Severity {
  return value === "note" || value === "minor" || value === "major";
}

export function maskSecret(secret: string | undefined, locale: Locale = "en"): string {
  return secret ? t(locale, "v.secretSet", { n: secret.length }) : t(locale, "v.secretNone");
}
