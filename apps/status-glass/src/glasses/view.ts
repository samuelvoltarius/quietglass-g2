import type { Locale } from "../i18n";
import { describeIssue, t } from "../messages";
import { armedFooter, footer } from "./footer";
import { describeMetric } from "./host";
import {
  isStale, sourceState, type Problem, type SourceStatus,
} from "../monitor/dashboard";

/**
 * What the text pages of the glasses show (QUS v1): the start page, the
 * problem list and the action list. Status and host pages are the cockpit
 * image (src/cockpit), not text.
 *
 * Every page is the same three parts: a header `Title · ● live`, a body of at
 * most five rows, and ONE footer line with the gestures that do something.
 */
export interface StatusView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

/** Rows a list shows at most (QUS 1.3). */
export const VISIBLE_ROWS = 5;

/**
 * Roughly the characters that fit across the 576 px display in its
 * proportional font. Source names, metric labels and error texts all come
 * from the sources themselves and can be any length; an uncut row wraps, and
 * wrapped rows push the rest of the list off the body.
 */
export const LINE_WIDTH = 56;

/** Shortens text to `width`, marking the cut. */
export function fit(text: string, width: number = LINE_WIDTH): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, Math.max(0, width)) : text.slice(0, width - 1) + "…";
}

/** A source that cannot be reached, or has been silent for too long. */
export function isOffline(source: SourceStatus, now: number): boolean {
  return source.error !== null || source.report === null || isStale(source, now);
}

export type LiveWord = "live" | "offline" | "demo";

/** `live` while at least one source answers, `offline` when none does, `demo` for the sample data. */
export function liveWord(sources: readonly SourceStatus[], now: number, demo: boolean): LiveWord {
  if (demo) return "demo";
  return sources.some((source) => !isOffline(source, now)) ? "live" : "offline";
}

/** `Status · ● live` (QUS 1.1): the mode, a dot while live, the state as a word otherwise. */
export function headerLine(locale: Locale, title: string, word: LiveWord): string {
  const state = word === "live" ? "● " + t(locale, "g.live") : word === "demo" ? t(locale, "g.demoWord") : t(locale, "g.offlineWord");
  return `${title} · ${state}`;
}

// ---- start page ---------------------------------------------------------------

export type StartRow =
  /** The overview of every server (the cockpit's first page). */
  | { readonly kind: "all" }
  /** One server, listed under the overview when there are two or more. */
  | { readonly kind: "host"; readonly id: string; readonly name: string }
  | { readonly kind: "problems"; readonly count: number }
  | { readonly kind: "actions"; readonly count: number };

/**
 * The selectable rows. At most three entries - the overview, the problem list
 * (only while something is wrong) and the actions (only when a source offers
 * any) - and the servers indented under the overview when there are two or more.
 * No source at all: nothing to select.
 */
export function startRows(sources: readonly SourceStatus[], problemCount: number, actionCount: number): StartRow[] {
  if (sources.length === 0) return [];
  return [
    { kind: "all" },
    ...(sources.length >= 2 ? sources.map((source): StartRow => ({ kind: "host", id: source.id, name: source.name })) : []),
    ...(problemCount > 0 ? [{ kind: "problems", count: problemCount } as const] : []),
    ...(actionCount > 0 ? [{ kind: "actions", count: actionCount } as const] : []),
  ];
}

const STATE_KEYS = { ok: "g.stateOk", warn: "g.stateWarn", critical: "g.stateCritical", unknown: "g.stateOffline" } as const;

/** The state of one source as a word. */
export function stateWord(source: SourceStatus, now: number, locale: Locale): string {
  return t(locale, isOffline(source, now) ? "g.stateOffline" : STATE_KEYS[sourceState(source, now)]);
}

function startLabel(row: StartRow, sources: readonly SourceStatus[], now: number, locale: Locale): string {
  switch (row.kind) {
    case "all": {
      // One server: the entry is that server.
      if (sources.length === 1) return sources[0]!.name;
      const ok = sources.filter((source) => sourceState(source, now) === "ok").length;
      return `${t(locale, "g.start.all")} · ${t(locale, "g.countOk", { ok, total: sources.length })}`;
    }
    case "host": {
      const source = sources.find((candidate) => candidate.id === row.id);
      return source ? `${row.name} · ${stateWord(source, now, locale)}` : row.name;
    }
    case "problems": return `${t(locale, "g.start.problems")} · ${row.count}`;
    case "actions": return t(locale, "g.start.actions");
  }
}

export interface StartOptions {
  readonly locale: Locale;
  readonly demo: boolean;
  readonly problemCount: number;
  readonly actionCount: number;
}

/** The window of `rows` around the cursor: where it starts. */
export function windowStart(total: number, cursor: number, rows: number): number {
  return Math.max(0, Math.min(cursor - Math.floor(rows / 2), total - rows));
}

export function startView(sources: readonly SourceStatus[], cursor: number, now: number, options: StartOptions): StatusView {
  const { locale } = options;
  const word = liveWord(sources, now, options.demo);
  if (sources.length === 0) {
    return {
      header: headerLine(locale, t(locale, "g.title"), word),
      body: [t(locale, "g.noSources"), t(locale, "g.addOnPhone")],
      footer: footer(locale, {}, "exit"),
    };
  }
  const rows = startRows(sources, options.problemCount, options.actionCount);
  const at = Math.min(Math.max(0, cursor), rows.length - 1);
  // In the demo the last row is the hint line, so it never scrolls out of the window.
  const room = options.demo ? VISIBLE_ROWS - 1 : VISIBLE_ROWS;
  const first = windowStart(rows.length, at, room);
  const body = rows.slice(first, first + room).map((row, index) => {
    // The cursor is a dot; servers hang one step under the overview.
    const mark = first + index === at ? "● " : "  ";
    return fit(mark + (row.kind === "host" ? "  " : "") + startLabel(row, sources, now, locale), LINE_WIDTH);
  });
  if (options.demo) body.push(t(locale, "g.demo"));
  return {
    header: headerLine(locale, t(locale, "g.title"), word),
    body,
    footer: footer(locale, { tap: t(locale, "g.w.open"), swipe: t(locale, "g.w.pick") }, "exit"),
  };
}

// ---- problems page --------------------------------------------------------------

/**
 * The row text for a problem. The two problems the app makes up itself (a
 * source that failed, a source gone quiet) are said in the chosen language;
 * a metric from a source keeps its own label.
 */
export function problemText(metric: Problem["metric"], locale: Locale): string {
  if (metric.id === "__stale") return t(locale, "g.stale");
  if (metric.id === "__source") return describeIssue(metric.label, locale);
  return describeMetric(metric, locale);
}

export interface ProblemsOptions {
  readonly locale: Locale;
  readonly demo: boolean;
  /** "Seen" is armed: the next tap does it. */
  readonly armed: boolean;
}

export function problemsView(sources: readonly SourceStatus[], list: readonly Problem[], cursor: number, now: number, options: ProblemsOptions): StatusView {
  const { locale } = options;
  const header = headerLine(locale, t(locale, "g.start.problems"), liveWord(sources, now, options.demo));
  if (list.length === 0) {
    return { header, body: [t(locale, "g.noProblems")], footer: footer(locale, {}, "back") };
  }
  const at = Math.min(Math.max(0, cursor), list.length - 1);
  const first = windowStart(list.length, at, VISIBLE_ROWS);
  const body = list.slice(first, first + VISIBLE_ROWS).map((problem, index) => {
    const mark = problem.state === "critical" ? "!" : problem.state === "warn" ? "·" : "?";
    const ack = problem.acknowledged ? " " + t(locale, "g.ack") : "";
    const head = (first + index === at ? "● " : "  ") + mark + " ";
    // The acknowledgement marker is kept; the text before it gives way.
    return head + fit(problem.sourceName + " " + problemText(problem.metric, locale), LINE_WIDTH - head.length - ack.length) + ack;
  });
  const current = list[at]!;
  const tail = options.armed && !current.acknowledged
    ? armedFooter(locale, t(locale, "g.w.seen"))
    : footer(locale, { ...(current.acknowledged ? {} : { tap: t(locale, "g.w.seen") }), swipe: t(locale, "g.w.list") }, "back");
  return { header, body, footer: tail };
}
