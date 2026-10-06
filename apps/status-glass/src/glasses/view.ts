import { formatMetric, type MetricState } from "../protocol/schema";
import type { Locale } from "../i18n";
import { describeIssue, t } from "../messages";
import {
  overallState, problems, sourceState, type Problem, type SourceStatus,
} from "../monitor/dashboard";

/**
 * What the glasses show.
 *
 * The rule this app is built around: **a healthy system costs no attention.**
 * When everything is fine the display is one short line. It grows only in
 * proportion to what is actually wrong, and the worst thing is always first.
 */
export interface StatusView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

export interface ViewOptions {
  /** Index of the highlighted problem, for acknowledging. */
  readonly cursor?: number;
  /** Lines available for problems. */
  readonly maxRows?: number;
  /** Language of everything the app itself says; English when omitted. */
  readonly locale?: Locale;
}

const DEFAULT_ROWS = 5;

/**
 * Roughly the characters that fit across the 576 px display in its
 * proportional font. Source names, metric labels and error texts all come
 * from the sources themselves and can be any length; an uncut row wraps, and
 * five wrapped rows push the rest of the list off the body.
 */
export const LINE_WIDTH = 46;

/** Shortens text to `width`, marking the cut. */
export function fit(text: string, width: number = LINE_WIDTH): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, Math.max(0, width)) : text.slice(0, width - 1) + "…";
}

export function buildView(
  sources: readonly SourceStatus[],
  options: ViewOptions = {},
  now = Date.now(),
): StatusView {
  const locale = options.locale ?? "en";
  if (sources.length === 0) {
    return {
      header: t(locale, "g.title"),
      body: [t(locale, "g.noSources"), t(locale, "g.addOnPhone")],
      footer: "",
    };
  }

  const list = problems(sources, now);
  const overall = overallState(sources, now);

  if (list.length === 0) {
    // Everything healthy: one line, no header, no noise.
    return {
      header: "",
      body: [countLabel(sources, now, locale)],
      footer: t(locale, "g.allOk"),
    };
  }

  const rows = Math.max(1, options.maxRows ?? DEFAULT_ROWS);
  const cursor = clamp(options.cursor ?? 0, 0, list.length - 1);
  // Keep the highlighted row on screen when the list is longer than the window.
  const start = clamp(cursor - Math.floor(rows / 2), 0, Math.max(0, list.length - rows));
  const window = list.slice(start, start + rows);

  const body = window.map((problem, index) => {
    const selected = start + index === cursor;
    const mark = problem.state === "critical" ? "!" : problem.state === "warn" ? "·" : "?";
    const ack = problem.acknowledged ? " " + t(locale, "g.ack") : "";
    // The acknowledgement marker is kept; the text before it gives way.
    const head = (selected ? "> " : "  ") + mark + " ";
    return head + fit(problem.sourceName + " " + problemText(problem.metric, locale), LINE_WIDTH - head.length - ack.length) + ack;
  });

  const hidden = list.length - window.length;
  return {
    header: headerFor(overall, list.length, locale),
    body,
    footer: (hidden > 0 ? t(locale, "g.more", { count: hidden }) + SEPARATOR : "") + t(locale, "g.tapAck"),
  };
}

/** Between two footer hints. */
export const SEPARATOR = "  ·  ";

/**
 * The row text for a problem. The two problems the app makes up itself (a
 * source that failed, a source gone quiet) are said in the chosen language;
 * a metric from a source keeps its own label.
 */
function problemText(metric: Problem["metric"], locale: Locale): string {
  if (metric.id === "__stale") return t(locale, "g.stale");
  if (metric.id === "__source") return describeIssue(metric.label, locale);
  return formatMetric(metric, locale);
}

function headerFor(state: MetricState, count: number, locale: Locale): string {
  const label = state === "critical" ? "g.critical" : state === "warn" ? "g.warning" : "g.noData";
  return t(locale, label) + "  " + count;
}

/** "4 of 4 ok" — enough to know monitoring is alive, nothing more. */
function countLabel(sources: readonly SourceStatus[], now: number, locale: Locale): string {
  const ok = sources.filter((s) => sourceState(s, now) === "ok").length;
  return t(locale, "g.countOk", { ok, total: sources.length });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
