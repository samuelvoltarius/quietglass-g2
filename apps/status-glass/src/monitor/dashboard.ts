import {
  metricState, severityOf, worstState, type Metric, type MetricState, type SourceReport,
} from "../protocol/schema";

/**
 * Dashboard state across several sources.
 *
 * The organising principle: **a healthy system should cost no attention.** So
 * the dashboard's job is not to show everything, it is to decide the very few
 * things worth showing — and to stay quiet when the answer is "nothing".
 */

export interface SourceStatus {
  readonly id: string;
  readonly name: string;
  readonly report: SourceReport | null;
  /** Null while never fetched. */
  readonly fetchedAt: number | null;
  /** Transport or parse failure, if the last attempt failed. */
  readonly error: string | null;
  /** Metric ids the user has acknowledged; they stop being shouted about. */
  readonly acknowledged: readonly string[];
}

export function createSource(id: string, name: string): SourceStatus {
  return { id, name, report: null, fetchedAt: null, error: null, acknowledged: [] };
}

/** A source that has not answered within this long is treated as stale. */
export const STALE_AFTER_MS = 120_000;

export function isStale(source: SourceStatus, now: number): boolean {
  if (source.fetchedAt === null) return true;
  return now - source.fetchedAt > STALE_AFTER_MS;
}

/**
 * The state of one source.
 *
 * A source we cannot reach is `unknown`, never `ok` — silence must never look
 * like health. That is the failure mode that makes monitoring worthless.
 */
export function sourceState(source: SourceStatus, now: number): MetricState {
  if (source.error !== null) return "unknown";
  if (!source.report || isStale(source, now)) return "unknown";
  return worstState(source.report.metrics.map(metricState));
}

export function overallState(sources: readonly SourceStatus[], now: number): MetricState {
  if (sources.length === 0) return "unknown";
  return worstState(sources.map((s) => sourceState(s, now)));
}

export interface Problem {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly metric: Metric;
  readonly state: MetricState;
  readonly acknowledged: boolean;
}

/**
 * Every metric that is not healthy, worst first, acknowledged ones last.
 *
 * Acknowledged problems are kept rather than hidden: a known problem is still
 * a problem, it just stops being the headline.
 */
export function problems(sources: readonly SourceStatus[], now: number): Problem[] {
  const found: Problem[] = [];

  for (const source of sources) {
    if (source.error !== null || !source.report) {
      found.push({
        sourceId: source.id,
        sourceName: source.name,
        metric: { id: "__source", label: source.error ?? "unreachable" },
        state: "unknown",
        acknowledged: source.acknowledged.includes("__source"),
      });
      continue;
    }

    if (isStale(source, now)) {
      found.push({
        sourceId: source.id,
        sourceName: source.name,
        metric: { id: "__stale", label: "no data" },
        state: "unknown",
        acknowledged: source.acknowledged.includes("__stale"),
      });
    }

    for (const metric of source.report.metrics) {
      const state = metricState(metric);
      if (state === "ok") continue;
      found.push({
        sourceId: source.id,
        sourceName: source.name,
        metric,
        state,
        acknowledged: source.acknowledged.includes(metric.id),
      });
    }
  }

  return found.sort((a, b) => {
    if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
    return severityOf(b.state) - severityOf(a.state);
  });
}

export function unacknowledgedProblems(sources: readonly SourceStatus[], now: number): Problem[] {
  return problems(sources, now).filter((p) => !p.acknowledged);
}

export function acknowledge(source: SourceStatus, metricId: string): SourceStatus {
  if (source.acknowledged.includes(metricId)) return source;
  return { ...source, acknowledged: [...source.acknowledged, metricId] };
}

/** Acknowledgements are cleared when a metric recovers, so it can shout again. */
export function clearRecovered(source: SourceStatus): SourceStatus {
  if (source.acknowledged.length === 0 || !source.report) return source;
  const stillBad = new Set(
    source.report.metrics.filter((m) => metricState(m) !== "ok").map((m) => m.id),
  );
  const kept = source.acknowledged.filter((id) => stillBad.has(id) || id.startsWith("__"));
  return kept.length === source.acknowledged.length ? source : { ...source, acknowledged: kept };
}

export function applyReport(
  source: SourceStatus,
  report: SourceReport,
  now: number,
): SourceStatus {
  return clearRecovered({ ...source, report, fetchedAt: now, error: null });
}

export function applyError(source: SourceStatus, error: string, now: number): SourceStatus {
  return { ...source, error, fetchedAt: now };
}
