import { cents, money, providerTag, shorten, staleAge, type Position, type ProviderError } from "../markets/model";
import { ROW_WIDTH } from "./footer";
import type { TextView } from "./text";

/** Rows the 214 px body container shows without clipping (same as the sibling apps). */
export const BODY_ROWS = 7;
/** Roughly the characters that fit across the 576 px display (proportional font). */
export const LINE_WIDTH = ROW_WIDTH;
/** Title + blank line, then two rows per position. */
export const PAGE_SIZE = Math.floor((BODY_ROWS - 2) / 2);

/** `controls` is the footer under the list; `demoHint` (demo only) takes the blank row under the title. */
export interface ViewLabels { readonly mode: string; readonly title: string; readonly empty: string; readonly controls: string; readonly demoHint?: string; /** Set (no side menu): "Hilfe" is the last list entry, with `helpControls` as its footer. */ readonly help?: string; readonly helpControls?: string; }

export function positionLines(position: Position, selected: boolean): [string, string] {
  const tag = providerTag(position.provider);
  const tail = ` ${cents(position.price)}  ${money(position.pnl)}`;
  // The outcome is the free-text field, so it gives way; price and P/L never truncate.
  const outcome = shorten(position.outcome, Math.max(1, LINE_WIDTH - 2 - tail.length));
  return [`${selected ? ">" : " "} ${tag} ${shorten(position.title, 38)}`, `  ${outcome}${tail}`];
}

/** What the bridge last delivered: `updatedAt` is the data's age reference (ms), `failed` whether the latest refresh failed. */
export interface FeedStatus { readonly source: "live" | "demo"; readonly updatedAt: number; readonly failed: boolean; readonly errors: readonly ProviderError[]; }
export interface ModeWords { readonly live: string; readonly demo: string; readonly stale: string; }

/** Header mode: DEMO, LIVE, or "STALE 3m" once live data is old or the bridge stopped answering; failed providers are appended ("LIVE  K ERR"). */
export function modeLabel(status: FeedStatus, now: number, words: ModeWords): string {
  if (status.source === "demo") return words.demo;
  const age = staleAge(status.updatedAt, now, status.failed);
  const base = age ? `${words.stale} ${age}` : words.live;
  return status.errors.length ? `${base}  ${[...new Set(status.errors.map((error) => providerTag(error.provider)))].join("")} ERR` : base;
}

/**
 * The list is the positions, followed by the Hilfe entry when `labels.help` is
 * set (no side menu); `cursor` indexes that list. The selected entry is the first one shown.
 */
export function glassesView(positions: readonly Position[], cursor: number, labels: ViewLabels): TextView {
  const withHelp = labels.help !== undefined;
  const total = positions.length + (withHelp ? 1 : 0);
  const start = Math.min(Math.max(0, cursor), Math.max(0, total - 1));
  const room = BODY_ROWS - 2;
  const rows: string[] = [];
  for (let i = start; i < total; i += 1) {
    const position = positions[i];
    if (!position && !withHelp) break;
    const entry = position ? positionLines(position, i === start) : [`${i === start ? ">" : " "} ${labels.help}`];
    if (rows.length + entry.length > room) break;
    rows.push(...entry);
  }
  if (positions.length === 0) rows.unshift(labels.empty);
  return {
    header: `MARKET GLANCE · ${labels.mode}`,
    body: [labels.title, labels.demoHint ?? "", ...rows],
    footer: withHelp && start === positions.length ? (labels.helpControls ?? labels.controls) : labels.controls,
  };
}
