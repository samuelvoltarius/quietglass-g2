import type { Locale } from "./i18n";
import { t } from "./messages";
import { footer } from "./footer";
import { fit, rideStopName, type StopView } from "./glasses/view";

/**
 * The start page of the glasses (QUS v1): at most three big entries, a header
 * `NEXTSTOP · ● live`, ONE footer line. No menu, no help page.
 */

export type StartRow = "board" | "goals";

/** The entries, in order. Both are always there; a running guide or ride is not on this page (it is the page). */
export function startRows(): readonly StartRow[] {
  return ["board", "goals"];
}

export type LiveWord = "live" | "waiting" | "demo" | "offline";

/** `live` once the position is known, `waiting` before, `demo` in the demo, `offline` when the board cannot be loaded. */
export function liveWord(options: { demo: boolean; hasPosition: boolean; failed: boolean }): LiveWord {
  if (options.demo) return "demo";
  if (options.failed) return "offline";
  return options.hasPosition ? "live" : "waiting";
}

export function headerLine(locale: Locale, word: LiveWord): string {
  const state = word === "live" ? t(locale, "s.live")
    : word === "demo" ? t(locale, "s.demo")
      : word === "offline" ? t(locale, "s.offline") : t(locale, "s.waiting");
  return `${t(locale, "s.title")} · ${state}`;
}

export interface StartOptions {
  readonly locale: Locale;
  readonly word: LiveWord;
  /** The stop the board would show, named after the first entry. */
  readonly stopName: string | null;
}

export function startLabel(row: StartRow, options: StartOptions): string {
  if (row === "goals") return t(options.locale, "s.goals");
  const base = t(options.locale, "s.board");
  return options.stopName ? `${base} · ${rideStopName(options.stopName, 28)}` : base;
}

export function startView(cursor: number, options: StartOptions): StopView {
  const { locale } = options;
  const rows = startRows();
  const at = Math.min(Math.max(0, cursor), rows.length - 1);
  const body = rows.map((row, index) => fit(`${index === at ? "● " : "  "}${startLabel(row, options)}`, 46));
  if (options.word === "demo") body.push("", t(locale, "s.demoHint"));
  return {
    header: headerLine(locale, options.word),
    body,
    footer: footer(locale, { tap: t(locale, "q.open"), swipe: t(locale, "q.select"), hold: t(locale, "q.goal") }, "exit"),
  };
}
