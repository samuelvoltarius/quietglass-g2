import type { Action } from "../protocol/schema";
import type { SourceStatus } from "../monitor/dashboard";
import type { Locale } from "../i18n";
import { describeIssue, t } from "../messages";
import { LINE_WIDTH, SEPARATOR, fit, type StatusView } from "./view";

/**
 * The actions screen.
 *
 * Separate from the status screen on purpose. Monitoring is something you
 * glance at; triggering something in your house is something you do
 * deliberately. Mixing them would mean a stray tap on a dashboard could unlock
 * a door.
 */

export interface AvailableAction {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly action: Action;
}

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
  /** Action id awaiting a confirming second tap. */
  readonly pendingId: string | null;
  /** Feedback from the last run. */
  readonly result: { readonly label: string; readonly ok: boolean } | null;
  readonly busy: boolean;
  readonly maxRows?: number;
  /** Language of everything the app itself says; English when omitted. */
  readonly locale?: Locale;
}

const DEFAULT_ROWS = 5;

export function buildActionsView(
  actions: readonly AvailableAction[],
  options: ActionsViewOptions,
): StatusView {
  const locale = options.locale ?? "en";
  if (actions.length === 0) {
    return {
      header: t(locale, "g.actions"),
      body: [t(locale, "g.noActions"), t(locale, "g.readOnly")],
      footer: t(locale, "g.holdBack"),
    };
  }

  const rows = Math.max(1, options.maxRows ?? DEFAULT_ROWS);
  const cursor = clamp(options.cursor, 0, actions.length - 1);
  const start = clamp(cursor - Math.floor(rows / 2), 0, Math.max(0, actions.length - rows));
  const window = actions.slice(start, start + rows);

  const body = window.map((entry, index) => {
    const selected = start + index === cursor;
    const confirming = options.pendingId === entry.action.id && selected;
    const prefix = selected ? "> " : "  ";
    const mark = entry.action.confirm ? "! " : "  ";
    const label = entry.sourceName + " " + entry.action.label;
    const head = prefix + mark + (confirming ? t(locale, "g.confirm") : "");
    return head + fit(label, LINE_WIDTH - head.length);
  });

  return {
    header: headerFor(options),
    body,
    footer: footerFor(actions, cursor, options),
  };
}

function headerFor(options: ActionsViewOptions): string {
  const locale = options.locale ?? "en";
  if (options.busy) return t(locale, "g.running");
  if (options.result) return t(locale, options.result.ok ? "g.done" : "g.actionFailed");
  return t(locale, "g.actions");
}

function footerFor(
  actions: readonly AvailableAction[],
  cursor: number,
  options: ActionsViewOptions,
): string {
  const locale = options.locale ?? "en";
  const back = SEPARATOR + t(locale, "g.holdBack");
  if (options.busy) return "";
  if (options.result) {
    // The label can be an error from the source; the way back must stay visible.
    // On success it is the action's own label and stays as the source wrote it.
    const label = options.result.ok ? options.result.label : describeIssue(options.result.label, locale);
    return fit(label, LINE_WIDTH - back.length) + back;
  }

  const current = actions[cursor];
  if (options.pendingId && current?.action.id === options.pendingId) {
    return t(locale, "g.tapAgain") + SEPARATOR + t(locale, "g.swipeCancel");
  }
  return (current?.action.confirm ? t(locale, "g.tapConfirmFirst") : t(locale, "g.tapRun")) + back;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
