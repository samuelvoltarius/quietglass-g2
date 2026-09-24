import { formatMetric, type MetricState } from "../protocol/schema";
import {
  overallState, problems, sourceState, type SourceStatus,
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
}

const DEFAULT_ROWS = 5;

export function buildView(
  sources: readonly SourceStatus[],
  options: ViewOptions = {},
  now = Date.now(),
): StatusView {
  if (sources.length === 0) {
    return {
      header: "Status Glass",
      body: ["No sources configured.", "Add one in the phone app."],
      footer: "",
    };
  }

  const list = problems(sources, now);
  const overall = overallState(sources, now);

  if (list.length === 0) {
    // Everything healthy: one line, no header, no noise.
    return {
      header: "",
      body: [countLabel(sources, now)],
      footer: "all ok",
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
    const ack = problem.acknowledged ? " (ack)" : "";
    return (selected ? "> " : "  ") + mark + " " + problem.sourceName + " " +
           formatMetric(problem.metric) + ack;
  });

  const hidden = list.length - window.length;
  return {
    header: headerFor(overall, list.length),
    body,
    footer: (hidden > 0 ? "+" + hidden + " more  ·  " : "") + "tap = acknowledge",
  };
}

function headerFor(state: MetricState, count: number): string {
  const label = state === "critical" ? "CRITICAL" : state === "warn" ? "WARNING" : "NO DATA";
  return label + "  " + count;
}

/** "4 sources ok" — enough to know monitoring is alive, nothing more. */
function countLabel(sources: readonly SourceStatus[], now: number): string {
  const ok = sources.filter((s) => sourceState(s, now) === "ok").length;
  return ok + " of " + sources.length + " ok";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
