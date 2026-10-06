import { cents, money, shorten, type Position } from "../markets/model";
import type { TextView } from "./text";

/** Rows the 214 px body container shows without clipping (same as the sibling apps). */
export const BODY_ROWS = 7;
/** Roughly the characters that fit across the 576 px display (proportional font). */
export const LINE_WIDTH = 46;
/** Title + blank line, then two rows per position. */
export const PAGE_SIZE = Math.floor((BODY_ROWS - 2) / 2);

export interface ViewLabels { readonly mode: string; readonly title: string; readonly empty: string; readonly controls: string; }

export function positionLines(position: Position, selected: boolean): [string, string] {
  const tag = position.provider === "kalshi" ? "K" : "P";
  const tail = ` ${cents(position.price)}  ${money(position.pnl)}`;
  // The outcome is the free-text field, so it gives way; price and P/L never truncate.
  const outcome = shorten(position.outcome, Math.max(1, LINE_WIDTH - 2 - tail.length));
  return [`${selected ? ">" : " "} ${tag} ${shorten(position.title, 38)}`, `  ${outcome}${tail}`];
}

export function glassesView(positions: readonly Position[], cursor: number, labels: ViewLabels): TextView {
  const visible = positions.slice(cursor, cursor + PAGE_SIZE);
  return {
    header: `MARKET GLANCE  ${labels.mode}`,
    body: [labels.title, "", ...(visible.length ? visible.flatMap((position, index) => positionLines(position, index === 0)) : [labels.empty])],
    footer: labels.controls,
  };
}
