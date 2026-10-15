import type { Action } from "../protocol/schema";
import type { SourceStatus } from "../monitor/dashboard";
import type { Locale } from "../i18n";
import { describeIssue, t } from "../messages";
import { LINE_WIDTH, fit, type StatusView } from "./view";
import { armedFooter, footer } from "./footer";

/**
 * The menu screen (Hold on the overview): the actions the sources offer,
 * then "refresh" and "Hilfe" (with the side menu on, the help lives there instead).
 *
 * Separate from the status screen on purpose. Monitoring is something you
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
 * opens the menu instead of reaching the app (step log of 15.10.2026), so the actions list carries
 * "refresh" and "Hilfe" again and a hold opens the actions.
 */
export const SIDE_MENU = false;

/** The fixed entries after the actions. */
export type MenuExtra = "reload" | "help";
export const MENU_EXTRAS: readonly MenuExtra[] = SIDE_MENU ? ["reload"] : ["reload", "help"];

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
  readonly maxRows?: number;
  /** Language of everything the app itself says; English when omitted. */
  readonly locale?: Locale;
}

const DEFAULT_ROWS = 7;

export function buildActionsView(
  actions: readonly AvailableAction[],
  options: ActionsViewOptions,
): StatusView {
  const locale = options.locale ?? "en";
  const total = actions.length + MENU_EXTRAS.length;
  const rows = Math.max(1, options.maxRows ?? DEFAULT_ROWS);
  const cursor = clamp(options.cursor, 0, total - 1);
  const start = clamp(cursor - Math.floor(rows / 2), 0, Math.max(0, total - rows));

  const body: string[] = [];
  for (let index = start; index < Math.min(total, start + rows); index += 1) {
    const selected = index === cursor;
    const prefix = selected ? "> " : "  ";
    const entry = actions[index];
    if (entry) {
      const confirming = options.pendingId === entry.action.id && selected;
      const mark = entry.action.confirm ? "! " : "  ";
      const label = entry.sourceName + " " + entry.action.label;
      const head = prefix + mark + (confirming ? t(locale, "g.confirm") : "");
      body.push(head + fit(label, LINE_WIDTH - head.length));
    } else {
      body.push(prefix + "  " + t(locale, MENU_EXTRAS[index - actions.length] === "help" ? "g.helpEntry" : "g.reload"));
    }
  }

  return { header: headerFor(options), body, footer: footerFor(actions, cursor, options) };
}

function headerFor(options: ActionsViewOptions): string {
  const locale = options.locale ?? "en";
  if (options.busy) return "STATUS · " + t(locale, "g.running");
  if (options.result) return "STATUS · " + t(locale, options.result.ok ? "g.done" : "g.actionFailed");
  return t(locale, "g.actions");
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
  return footer(locale, { tap: t(locale, current ? "g.w.pick" : "g.w.open"), swipe: t(locale, "g.w.list") }, "back");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
