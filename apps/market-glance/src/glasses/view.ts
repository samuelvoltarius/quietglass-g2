import { cents, money, providerTag, shorten, staleAge, type Position, type ProviderError } from "../markets/model";
import type { TextView } from "./text";

/** Rows the 214 px body container shows without clipping (same as the sibling apps). */
export const BODY_ROWS = 7;
/** Roughly the characters that fit across the 576 px display (proportional font). */
export const LINE_WIDTH = 46;
/** Title + blank line, then two rows per position. */
export const PAGE_SIZE = Math.floor((BODY_ROWS - 2) / 2);

export interface ViewLabels { readonly mode: string; readonly title: string; readonly empty: string; readonly controls: string; }

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

export function glassesView(positions: readonly Position[], cursor: number, labels: ViewLabels): TextView {
  const visible = positions.slice(cursor, cursor + PAGE_SIZE);
  return {
    header: `MARKET GLANCE  ${labels.mode}`,
    body: [labels.title, "", ...(visible.length ? visible.flatMap((position, index) => positionLines(position, index === 0)) : [labels.empty])],
    footer: labels.controls,
  };
}
