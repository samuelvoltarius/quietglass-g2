import type { Checklist } from "../checklist/model";
import { isFinished, positionOf, type RunState } from "../checklist/run";
import { counts } from "../cockpit/model";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { footer } from "./footer";
import type { FlowView } from "./view";

/**
 * The text pages besides the run (QUS v1): the start page with at most three
 * entries and the task list of at most five rows. The overview is the cockpit
 * image (src/cockpit), not text.
 *
 * Every page is the same three parts: a header `Modus · ● live`, a body, and
 * ONE footer line with the gestures that do something. `headline` stays empty
 * (only the run page draws a big step picture).
 */

/** Rows a list shows at most (QUS 1.3). */
export const VISIBLE_ROWS = 5;
/** Characters that fit across the 576 px display in its proportional font. */
export const LINE_WIDTH = 56;

export type StartRow = { readonly kind: "run" } | { readonly kind: "cockpit" } | { readonly kind: "tasks" };

/** The entries of the start page: always the same three, or none while there is no list. */
export function startRows(list: Checklist): StartRow[] {
  if (list.steps.length === 0) return [];
  return [{ kind: "run" }, { kind: "cockpit" }, { kind: "tasks" }];
}

/** Shortens text to `width`, marking the cut. */
export function fit(text: string, width: number = LINE_WIDTH): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, Math.max(0, width)) : text.slice(0, width - 1).trimEnd() + "…";
}

/** `Aufgaben · ● live` (QUS 1.1): the mode, a dot while live. FlowList lives on the phone, so it is always live. */
export function headerLine(locale: Locale, title: string): string {
  return `${title} · ● ${t(locale, "g.live")}`;
}

function startLabel(row: StartRow, list: Checklist, state: RunState, locale: Locale): string {
  const c = counts(list, state);
  switch (row.kind) {
    case "run": {
      const where = isFinished(state) ? t(locale, "g.runDone") : `${positionOf(list, state)}/${list.steps.length}`;
      return `${t(locale, "g.start.run")} · ${where}`;
    }
    case "cockpit":
      return `${t(locale, "g.start.cockpit")} · ${c.finished || c.open === 0 ? t(locale, "g.cockpitDone") : t(locale, "g.cockpitOpen", { n: c.open })}`;
    case "tasks":
      return `${t(locale, "g.start.tasks")} · ${list.steps.length}`;
  }
}

/** The start page: three big entries, the cursor is a dot. */
export function startView(list: Checklist, state: RunState, cursor: number, locale: Locale): FlowView {
  const header = headerLine(locale, t(locale, "g.title"));
  const rows = startRows(list);
  if (rows.length === 0) {
    return { header, headline: "", body: [t(locale, "g.empty.1"), t(locale, "g.empty.2")], footer: footer(locale, {}, "exit") };
  }
  const at = Math.min(Math.max(0, cursor), rows.length - 1);
  return {
    header,
    headline: "",
    body: rows.map((row, index) => fit((index === at ? "● " : "  ") + startLabel(row, list, state, locale))),
    footer: footer(locale, { tap: t(locale, "g.v.open"), swipe: t(locale, "g.v.pick") }, "exit"),
  };
}

/** The window of `total` rows around the cursor: where it starts. */
export function windowStart(total: number, cursor: number, rows: number): number {
  return Math.max(0, Math.min(cursor - Math.floor(rows / 2), total - rows));
}

/** The task list: the steps, five rows at most. `●` marks the cursor, `→` the step to do now, `—` a step that is finished. */
export function tasksView(list: Checklist, state: RunState, cursor: number, locale: Locale): FlowView {
  const header = headerLine(locale, t(locale, "g.s.tasks"));
  if (list.steps.length === 0) {
    return { header, headline: "", body: [t(locale, "g.empty.1"), t(locale, "g.empty.2")], footer: footer(locale, {}, "back") };
  }
  const at = Math.min(Math.max(0, cursor), list.steps.length - 1);
  const first = windowStart(list.steps.length, at, VISIBLE_ROWS);
  const body = list.steps.slice(first, first + VISIBLE_ROWS).map((step, index) => {
    const status = state.status[step.id];
    const mark = status === "done" || status === "skipped" ? "— " : step.id === state.currentId ? "→ " : "  ";
    return fit((first + index === at ? "● " : "  ") + mark + step.text);
  });
  return {
    header,
    headline: "",
    body,
    footer: footer(locale, { tap: t(locale, "g.v.run"), ...(list.steps.length > 1 ? { swipe: t(locale, "g.v.scroll") } : {}) }, "back"),
  };
}
