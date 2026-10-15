import type { Locale } from "../i18n";
import { t } from "../messages";
import type { SttStatus } from "../stt/provider";
import { AUTO, primaryCode } from "../text/languages";
import { companionConfigured, translationEnabled, usesMockStt, type BabelData } from "../storage/persist";

/**
 * Übersicht (0.5.0): every helper Babel has, how it is triggered and whether
 * it is on right now. One source for the glasses help screen, the phone
 * table and the compact header line, so the three never disagree.
 */

export type HelperId =
  | "captions" | "translation" | "speakers" | "insights" | "replies"
  | "own" | "wordFinder" | "transcript" | "summary" | "memory";

/** Babel's own memory as last seen (probe, search, store). */
export type MemoryStatus = "unknown" | "ok" | "unavailable" | "unauthorized";

/** Boolean settings a helper row can switch. */
export type HelperToggle = "speakers" | "insights" | "replySuggestions" | "translateOwn" | "keepTranscript" | "autoSummary" | "memory";

export interface OverviewInput {
  readonly data: BabelData;
  readonly listening: boolean;
  readonly sttStatus: SttStatus;
  readonly memory: MemoryStatus;
}

export interface HelperRow {
  readonly id: HelperId;
  /** Doing its job now (or will, as soon as captions run). */
  readonly on: boolean;
  /** The setting that switches it, if any. */
  readonly toggle?: HelperToggle;
  /** Status key (`g.ovs.*`) with its variables. */
  readonly status: string;
  readonly vars?: Record<string, string>;
}

export const HELPER_IDS: readonly HelperId[] = [
  "captions", "translation", "speakers", "insights", "replies", "own", "wordFinder", "transcript", "summary", "memory",
];

/** "RU→DE", "?→DE" with automatic detection; null without translation. */
export function languagePair(data: BabelData): string | null {
  if (!translationEnabled(data)) return null;
  const code = (value: string): string => (value === AUTO ? "?" : primaryCode(value).toUpperCase());
  return code(data.sourceLanguage) + "→" + code(data.targetLanguage);
}

export function helperRows(input: OverviewInput): HelperRow[] {
  const { data } = input;
  const llm = companionConfigured(data) || usesMockStt(data);
  const translating = translationEnabled(data);
  const pair = languagePair(data);
  const needsLlm = (on: boolean): string => (!llm ? "g.ovs.noLlm" : on ? "g.ovs.on" : "g.ovs.off");
  const memoryStatus = !companionConfigured(data) ? "g.ovs.noLlm"
    : !data.memory ? "g.ovs.off"
    : input.memory === "ok" ? "g.ovs.connected"
    : input.memory === "unavailable" ? "g.ovs.unavailable"
    : input.memory === "unauthorized" ? "g.ovs.unauthorized"
    : "g.ovs.on";
  const captions = usesMockStt(data) ? "g.ovs.demo"
    : !input.listening ? "g.ovs.off"
    : input.sttStatus === "ready" ? "g.ovs.live"
    : "g.ovs.connecting";
  return [
    { id: "captions", on: input.listening, status: captions },
    { id: "translation", on: translating, status: translating ? "g.ovs.pair" : "g.ovs.off", ...(pair ? { vars: { pair } } : {}) },
    { id: "speakers", on: data.speakers, toggle: "speakers", status: data.speakers ? "g.ovs.on" : "g.ovs.off" },
    { id: "insights", on: llm && data.insights, toggle: "insights", status: needsLlm(data.insights) },
    { id: "replies", on: llm && data.replySuggestions, toggle: "replySuggestions", status: needsLlm(data.replySuggestions) },
    {
      id: "own", on: translating && data.translateOwn, toggle: "translateOwn",
      status: !translating ? "g.ovs.noTarget" : data.translateOwn ? "g.ovs.on" : "g.ovs.swipeOnly",
    },
    { id: "wordFinder", on: llm, status: llm ? "g.ovs.on" : "g.ovs.noLlm" },
    { id: "transcript", on: true, toggle: "keepTranscript", status: data.keepTranscript ? "g.ovs.kept" : "g.ovs.session" },
    { id: "summary", on: llm && data.autoSummary, toggle: "autoSummary", status: needsLlm(data.autoSummary) },
    { id: "memory", on: companionConfigured(data) && data.memory && input.memory !== "unavailable" && input.memory !== "unauthorized", toggle: "memory", status: memoryStatus },
  ];
}

/** One help row for the glasses: "Antwort-Vorschläge: automatisch · an". */
export function helpLine(row: HelperRow, locale: Locale): string {
  return t(locale, "g.hlp." + row.id) + ": " + t(locale, "g.trg." + row.id) + " · " + t(locale, row.status, row.vars ?? {});
}

/** The compact live state for the glasses header (what is active, nothing else). */
export interface ActiveHelpers {
  readonly pair?: string | null;
  readonly speakers?: boolean;
  readonly replies?: boolean;
  readonly own?: boolean;
  readonly info?: boolean;
  readonly memory?: boolean;
}

export function activeHelpers(input: OverviewInput): ActiveHelpers {
  const rows = new Map(helperRows(input).map((row) => [row.id, row.on] as const));
  return {
    pair: languagePair(input.data),
    speakers: rows.get("speakers") ?? false,
    replies: rows.get("replies") ?? false,
    own: rows.get("own") ?? false,
    info: rows.get("insights") ?? false,
    memory: rows.get("memory") ?? false,
  };
}
