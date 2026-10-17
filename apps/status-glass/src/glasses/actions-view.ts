import type { Action } from "../protocol/schema";
import type { SourceStatus } from "../monitor/dashboard";
import type { Locale } from "../i18n";
import { describeIssue, t } from "../messages";
import { LINE_WIDTH, VISIBLE_ROWS, fit, headerLine, windowStart, type LiveWord, type StatusView } from "./view";
import { armedFooter, footer } from "./footer";

/**
 * The actions page (start page entry "Aktionen"): what the sources offer.
 *
 * Separate from the status pages on purpose. Monitoring is something you
 * glance at; triggering something in your house is something you do
 * deliberately. Every action is armed first (tap), and only a second single
 * tap within four seconds runs it; swipe, 2x or the timeout cancel (QIS v1).
 */

export interface AvailableAction {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly action: Action;
}

/**
 * The glasses' side menu (QIS v1.2). Off: its clicks never reach the app on the real glasses and a hold
 * opens the menu instead of reaching the app (step log of 15.10.2026), so the pages carry no `menuObject`.
 */
export const SIDE_MENU = false;

/** How long an armed action waits for its confirming tap. */
export const ARM_MS = 4000;

/** Every action offered by every configured source, source order preserved. */
export function availableActions(sources: readonly SourceStatus[]): AvailableAction[] {
  const list: AvailableAction[] = [];
  for (const source of sources) {
    for (const action of source.report?.actions ?? []) {
      list.push({ sourceId: source.id, sourceName: source.name, action });
    }
  }
  return list;
}

export interface ActionsViewOptions {
  readonly cursor: number;
  /** Action id armed and waiting for a confirming second tap. */
  readonly pendingId: string | null;
  /** Feedback from the last run. */
  readonly result: { readonly label: string; readonly ok: boolean } | null;
  readonly busy: boolean;
  readonly word?: LiveWord;
  /** Language of everything the app itself says; English when omitted. */
  readonly locale?: Locale;
}

export function buildActionsView(
  actions: readonly AvailableAction[],
  options: ActionsViewOptions,
): StatusView {
  const locale = options.locale ?? "en";
  const header = headerFor(options);
  if (actions.length === 0) {
    return { header, body: [t(locale, "g.noActions")], footer: footer(locale, {}, "back") };
  }
  const cursor = clamp(options.cursor, 0, actions.length - 1);
  const start = windowStart(actions.length, cursor, VISIBLE_ROWS);

  const body: string[] = [];
  for (let index = start; index < Math.min(actions.length, start + VISIBLE_ROWS); index += 1) {
    const entry = actions[index]!;
    const selected = index === cursor;
    const confirming = options.pendingId === entry.action.id && selected;
    const mark = entry.action.confirm ? "! " : "";
    const head = (selected ? "● " : "  ") + mark + (confirming ? t(locale, "g.confirm") : "");
    body.push(head + fit(entry.sourceName + " " + entry.action.label, LINE_WIDTH - head.length));
  }

  return { header, body, footer: footerFor(actions, cursor, options) };
}

function headerFor(options: ActionsViewOptions): string {
  const locale = options.locale ?? "en";
  const title = t(locale, "g.start.actions");
  if (options.busy) return `${title} · ${t(locale, "g.running")}`;
  if (options.result) return `${title} · ${t(locale, options.result.ok ? "g.done" : "g.actionFailed")}`;
  return headerLine(locale, title, options.word ?? "live");
}

function footerFor(
  actions: readonly AvailableAction[],
  cursor: number,
  options: ActionsViewOptions,
): string {
  const locale = options.locale ?? "en";
  if (options.busy) return "";
  if (options.result) {
    // The label can be an error from the source; the way back must stay visible.
    // On success it is the action's own label and stays as the source wrote it.
    const label = options.result.ok ? options.result.label : describeIssue(options.result.label, locale);
    const tail = footer(locale, {}, "back");
    return fit(label, LINE_WIDTH - tail.length - 3) + " · " + tail;
  }

  const current = actions[cursor];
  if (current && options.pendingId === current.action.id) return armedFooter(locale, t(locale, "g.w.run"));
  // Every action is armed first: one stray tap never switches anything.
  return footer(locale, { tap: t(locale, "g.w.pick"), swipe: t(locale, "g.w.list") }, "back");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
