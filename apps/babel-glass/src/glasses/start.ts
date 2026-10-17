import type { Locale } from "../i18n";
import { t } from "../messages";
import { customerListRow, orderCustomers, type CustomerEntry, type CustomerListState } from "../companion/customers";
import { talkModeKey, type TalkMode } from "../companion/talkmode";

/**
 * 1.0.0: the start screen (captions stopped). Exactly three entries, the
 * customers of the proxy's list under "Gespräch", and one hint row at the
 * bottom while no voice is trained. Swipe moves the cursor, a tap starts.
 */
export type StartRow =
  | { readonly kind: "mode"; readonly mode: TalkMode }
  /** A customer of the list: starts "Gespräch" with that customer. */
  | { readonly kind: "customer"; readonly entry: CustomerEntry };

/** The three entries in the order they are shown. */
export const START_MODES: readonly TalkMode[] = ["translate", "learn", "client"];

/** The selectable rows: the three modes, then (only when a list was loaded) the customers under "Gespräch". */
export function startRows(list: CustomerListState, now: Date): StartRow[] {
  const customers = list.state === "ready" ? orderCustomers(list.entries, now) : [];
  return START_MODES.flatMap((mode): StartRow[] => [
    { kind: "mode", mode },
    ...(mode === "client" ? customers.map((entry): StartRow => ({ kind: "customer", entry })) : []),
  ]);
}

function fit(row: string, width: number): string {
  const chars = [...row];
  return chars.length <= width ? row : chars.slice(0, width - 1).join("") + "…";
}

/**
 * The start screen as glasses rows: "> " marks the cursor, customers are indented under "Gespräch",
 * the voice hint (when `voiceHint`) is the last row and is never selectable. Scrolled so the cursor stays visible.
 */
export function startBody(
  rows: readonly StartRow[], cursor: number, now: Date, locale: Locale, width: number, visible: number, voiceHint: boolean,
): string[] {
  const label = (row: StartRow): string => row.kind === "mode"
    ? t(locale, talkModeKey(row.mode))
    : "  " + customerListRow(row.entry, now, locale, width - 4);
  const room = voiceHint ? visible - 1 : visible;
  const at = Math.min(Math.max(0, cursor), rows.length - 1);
  const start = Math.max(0, Math.min(at - room + 1, rows.length - room));
  const first = Math.max(0, Math.min(start, at));
  const body = rows.slice(first, first + room).map((row, i) => (first + i === at ? "> " : "  ") + fit(label(row), width - 2));
  return voiceHint ? [...body, t(locale, "g.start.voiceHint")] : body;
}
