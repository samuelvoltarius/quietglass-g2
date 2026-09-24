import type { Action } from "../protocol/schema";
import type { SourceStatus } from "../monitor/dashboard";
import type { StatusView } from "./view";

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
}

const DEFAULT_ROWS = 5;

export function buildActionsView(
  actions: readonly AvailableAction[],
  options: ActionsViewOptions,
): StatusView {
  if (actions.length === 0) {
    return {
      header: "Actions",
      body: ["No source offers any.", "Sources are read-only by default."],
      footer: "hold = back",
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
    return prefix + mark + (confirming ? "CONFIRM: " + label : label);
  });

  return {
    header: headerFor(options),
    body,
    footer: footerFor(actions, cursor, options),
  };
}

function headerFor(options: ActionsViewOptions): string {
  if (options.busy) return "Running…";
  if (options.result) return options.result.ok ? "Done" : "Failed";
  return "Actions";
}

function footerFor(
  actions: readonly AvailableAction[],
  cursor: number,
  options: ActionsViewOptions,
): string {
  if (options.busy) return "";
  if (options.result) return options.result.label + "  ·  hold = back";

  const current = actions[cursor];
  if (options.pendingId && current?.action.id === options.pendingId) {
    return "tap again = run  ·  swipe = cancel";
  }
  return current?.action.confirm
    ? "tap = confirm first  ·  hold = back"
    : "tap = run  ·  hold = back";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
