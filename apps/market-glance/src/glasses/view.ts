import type { Locale } from "../i18n";
import { cents, money, providerTag, shorten, type Position } from "../markets/model";
import { feedLabel, feedWord, totals, usd, type FeedStatus } from "../cockpit/model";
import { t } from "../text";
import { footer, ROW_WIDTH } from "./footer";
import type { TextView } from "./page";

/**
 * What the text pages of the glasses show (QUS v1): the start page and the
 * position list. The portfolio and each position are the cockpit image
 * (src/cockpit), not text. Every page is a header `Mode · ● live`, a body of
 * at most five rows and ONE footer line.
 */

/** Rows a list shows at most (QUS 1.3). */
export const VISIBLE_ROWS = 5;
/** Roughly the characters that fit across the 576 px display (proportional font). */
export const LINE_WIDTH = ROW_WIDTH;

export type StartRow =
  | { readonly kind: "overview" }
  | { readonly kind: "positions"; readonly count: number };

/** The selectable rows: at most three entries, here the overview and the position list. */
export function startRows(positions: readonly Position[]): StartRow[] {
  return [{ kind: "overview" }, { kind: "positions", count: positions.length }];
}

/** `Market Glance · ● live`: the mode, the state as a dot or a word. */
export function headerLine(locale: Locale, title: string, status: FeedStatus, now: number): string {
  return `${title} · ${feedLabel(feedWord(status, now), locale)}`;
}

/** The window of `rows` around the cursor: where it starts. */
export function windowStart(total: number, cursor: number, rows: number): number {
  return Math.max(0, Math.min(cursor - Math.floor(rows / 2), total - rows));
}

export function startView(positions: readonly Position[], cursor: number, status: FeedStatus, now: number, locale: Locale): TextView {
  const rows = startRows(positions);
  const at = Math.min(Math.max(0, cursor), rows.length - 1);
  const total = totals(positions);
  const body = rows.map((row, index) => {
    const mark = index === at ? "● " : "  ";
    return mark + (row.kind === "overview"
      ? `${t(locale, "startOverview")} · ${positions.length === 0 ? "–" : usd(total.value)}`
      : `${t(locale, "startPositions")} · ${row.count}`);
  });
  if (status.source === "demo") body.push(t(locale, "demoHint"));
  return { header: headerLine(locale, t(locale, "title"), status, now), body, footer: footer(locale, { tap: t(locale, "open"), swipe: t(locale, "pick") }, "exit") };
}

/** One list row: cursor dot, provider tag, title, price and P/L (price and P/L never truncate). */
export function positionRow(position: Position, selected: boolean): string {
  const tail = ` ${cents(position.price)} ${money(position.pnl)}`;
  const head = `${selected ? "● " : "  "}${providerTag(position.provider)} `;
  return head + shorten(position.title, Math.max(4, LINE_WIDTH - head.length - tail.length)) + tail;
}

export function listView(positions: readonly Position[], cursor: number, status: FeedStatus, now: number, locale: Locale): TextView {
  const header = headerLine(locale, t(locale, "startPositions"), status, now);
  if (positions.length === 0) return { header, body: [t(locale, "empty")], footer: footer(locale, {}, "back") };
  const at = Math.min(Math.max(0, cursor), positions.length - 1);
  const first = windowStart(positions.length, at, VISIBLE_ROWS);
  const body = positions.slice(first, first + VISIBLE_ROWS).map((position, index) => positionRow(position, first + index === at));
  return { header, body, footer: footer(locale, { tap: t(locale, "open"), swipe: t(locale, "pick") }, "back") };
}
