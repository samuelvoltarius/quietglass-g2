import type { NavView } from "./view";
import { clip, LINE_WIDTH } from "./view";
import type { FoundPlace } from "../geocode/photon";
import type { Destination, NavData } from "../storage/persist";
import type { TravelMode } from "../routing/provider";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";

/**
 * The glasses pages before navigation: the destination list and speaking a
 * destination. Both are plain text pages (header, body, footer), so moving
 * the cursor or a new recording phase is a text update, never a rebuild.
 */

/** Destinations visible at once on the list. */
export const VISIBLE_ITEMS = 5;

export interface ListItem {
  readonly place: Destination;
  /** Spoken on the glasses and not saved: shown as "recent". */
  readonly recent: boolean;
}

/** Saved places first, then the recent ones. */
export function listItems(data: NavData): ListItem[] {
  return [
    ...data.places.map((place) => ({ place, recent: false })),
    ...data.recent.map((place) => ({ place, recent: true })),
  ];
}

/** Rows of the list: every destination, then the travel-mode row. */
export function rowCount(data: NavData): number {
  return listItems(data).length + 1;
}

/** Where the cursor starts: on the active destination, else the first row. */
export function cursorFor(data: NavData): number {
  const index = listItems(data).findIndex((item) => item.place.id === data.destinationId);
  return index >= 0 ? index : 0;
}

export function clampCursor(data: NavData, cursor: number): number {
  return Math.max(0, Math.min(rowCount(data) - 1, cursor));
}

const MODES: readonly TravelMode[] = ["driving", "cycling", "walking"];

/** Car → bike → on foot → car. */
export function nextMode(mode: TravelMode): TravelMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length] ?? "walking";
}

function t(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  return tr(messages, locale, key, vars);
}

/** "→" marks the cursor, "●" the active destination, "○" the others. */
function row(selected: boolean, mark: string, text: string): string {
  return clip((selected ? "→ " : "    ") + mark + text, LINE_WIDTH);
}

/**
 * The destination list: at most VISIBLE_ITEMS destinations around the cursor,
 * an empty line, and the travel mode (tap on it switches).
 */
export function listView(data: NavData, cursor: number, locale: Locale): NavView {
  const items = listItems(data);
  const modeRow = items.length;
  const body: string[] = [];
  if (items.length === 0) {
    body.push(t(locale, "l.empty1"), t(locale, "l.empty2"), t(locale, "l.empty3"));
  } else {
    const anchor = Math.min(cursor, items.length - 1);
    const first = Math.max(0, Math.min(anchor - Math.floor(VISIBLE_ITEMS / 2), items.length - VISIBLE_ITEMS));
    for (const [offset, item] of items.slice(first, first + VISIBLE_ITEMS).entries()) {
      const index = first + offset;
      const active = item.place.id === data.destinationId;
      const label = item.recent ? `${item.place.label} · ${t(locale, "l.recent")}` : item.place.label;
      body.push(row(index === cursor, active ? "● " : "○ ", label));
    }
  }
  body.push("");
  body.push(row(cursor === modeRow, "", t(locale, "l.mode", { mode: t(locale, "mode." + data.mode) })));
  const header = items.length > VISIBLE_ITEMS && cursor < items.length
    ? t(locale, "l.headerCount", { n: cursor + 1, total: items.length })
    : t(locale, "l.header");
  return { header, body, footer: t(locale, "l.footer") };
}

export type VoiceState =
  | { readonly phase: "recording" }
  | { readonly phase: "working"; readonly heard?: string }
  | { readonly phase: "results"; readonly heard: string; readonly results: readonly FoundPlace[]; readonly selected: number; readonly saved: boolean }
  | { readonly phase: "error"; readonly key: string; readonly vars?: Readonly<Record<string, string>> };

/** Speaking a destination: recording, working, up to three hits, or what went wrong. */
export function voiceView(state: VoiceState, locale: Locale): NavView {
  const header = t(locale, "v.header");
  switch (state.phase) {
    case "recording":
      return { header, body: [t(locale, "v.recording"), "", t(locale, "v.recordingHint")], footer: t(locale, "v.recordingFooter") };
    case "working":
      return {
        header,
        body: [state.heard ? t(locale, "v.searching", { text: clip(state.heard, 28) }) : t(locale, "v.working")],
        footer: "",
      };
    case "results": {
      const body: string[] = [];
      for (const [index, place] of state.results.entries()) {
        body.push(row(index === state.selected, "", place.label));
        if (place.detail) body.push(clip("      " + place.detail, LINE_WIDTH));
      }
      return {
        header: clip(t(locale, "v.heard", { text: state.heard }), LINE_WIDTH),
        body,
        footer: t(locale, state.saved ? "v.savedFooter" : "v.resultsFooter"),
      };
    }
    case "error":
      return {
        header,
        body: [t(locale, state.key, state.vars ?? {}), "", t(locale, state.key + "Hint", state.vars ?? {})],
        footer: t(locale, "v.errorFooter"),
      };
  }
}
