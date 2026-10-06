import { when, type AgendaItem } from "./model";

/** Rows the 214 px body container shows without clipping (same container as the sibling apps). */
export const BODY_ROWS = 7;
/** Roughly the characters across the body, which is 472 px wide because the pixel icon takes the left 104 px. */
export const LINE_WIDTH = 38;
/** The date line and a spacer sit above the agenda. */
export const AGENDA_ROWS = BODY_ROWS - 2;

/** First visible index, scrolled so the selected row is never cut off the bottom. */
export function windowStart(length: number, cursor: number, rows: number = AGENDA_ROWS): number {
  return Math.max(0, Math.min(cursor - rows + 1, length - rows));
}

/** Cuts to the line budget with an ellipsis instead of letting the glasses wrap into the next row. */
export function fit(text: string, width: number = LINE_WIDTH): string {
  const chars = Array.from(text);
  return chars.length <= width ? text : chars.slice(0, Math.max(0, width - 1)).join("") + "…";
}

export function agendaLine(item: AgendaItem, selected: boolean, locale: string, now?: Date): string {
  const box = item.kind === "reminder" ? (item.done ? "[x]" : "[ ]") : "   ";
  return fit(`${selected ? ">" : " "} ${when(item.at, locale, now)} ${box} ${item.title}`);
}

export function agendaRows(items: readonly AgendaItem[], cursor: number, locale: string, rows: number = AGENDA_ROWS, now?: Date): string[] {
  const first = windowStart(items.length, cursor, rows);
  return items.slice(first, first + rows).map((item, offset) => agendaLine(item, first + offset === cursor, locale, now));
}

/** Calendar titles come from imported files and bridges; never let them become markup on the phone. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
