import {
  metricState, severityOf, worstState, type Metric, type MetricState, type NetDevice, type NetworkInfo, type SourceReport,
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
  /** When a report last arrived successfully; null if never. */
  readonly okAt: number | null;
  /** Transport or parse failure, if the last attempt failed. */
  readonly error: string | null;
  /** Metric ids the user has acknowledged; they stop being shouted about. */
  readonly acknowledged: readonly string[];
}

export function createSource(id: string, name: string): SourceStatus {
  return { id, name, report: null, fetchedAt: null, okAt: null, error: null, acknowledged: [] };
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

    const newcomers = netNewMetric(source.report.network);
    if (newcomers) {
      found.push({
        sourceId: source.id,
        sourceName: source.name,
        metric: newcomers,
        state: "warn",
        acknowledged: source.acknowledged.includes(newcomers.id),
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

/** Prefix of the made-up problem "new devices in the home network". */
export const NET_NEW_PREFIX = "__netnew:";

/** The devices of a network block that are new (first seen in the last 24 h, not known). */
export function newDevices(network: NetworkInfo | undefined): NetDevice[] {
  return (network?.devices ?? []).filter((d) => d.new && !d.known);
}

/** What a person calls a device: its DNS name, else its address, else its MAC. */
export function deviceLabel(device: NetDevice): string {
  return device.name ?? device.ip ?? device.mac;
}

/**
 * New devices as a warning. The id carries a fingerprint of exactly which
 * devices are new, so "seen" holds for them and a further newcomer shouts
 * again. `value` is the count, `detail` the first one's name.
 */
export function netNewMetric(network: NetworkInfo | undefined): Metric | null {
  const fresh = newDevices(network);
  const count = fresh.length > 0 ? fresh.length : network && network.devices.length === 0 ? network.new : 0;
  if (count <= 0) return null;
  const key = fresh.map((d) => d.mac).sort().join(",") || "n" + count;
  return {
    id: NET_NEW_PREFIX + fingerprint(key),
    label: "new devices",
    value: count,
    ...(fresh[0] ? { detail: deviceLabel(fresh[0]) } : {}),
  };
}

/** A short, stable hash (FNV-1a, 32 bit), only to tell device sets apart. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Acknowledgements are cleared when a metric recovers, so it can shout again. */
export function clearRecovered(source: SourceStatus): SourceStatus {
  if (source.acknowledged.length === 0 || !source.report) return source;
  const stillBad = new Set(
    source.report.metrics.filter((m) => metricState(m) !== "ok").map((m) => m.id),
  );
  const newcomers = netNewMetric(source.report.network);
  if (newcomers) stillBad.add(newcomers.id);
  const kept = source.acknowledged.filter((id) => stillBad.has(id) || (id.startsWith("__") && !id.startsWith(NET_NEW_PREFIX)));
  return kept.length === source.acknowledged.length ? source : { ...source, acknowledged: kept };
}

export function applyReport(
  source: SourceStatus,
  report: SourceReport,
  now: number,
): SourceStatus {
  return clearRecovered({ ...source, report, fetchedAt: now, okAt: now, error: null });
}

export function applyError(source: SourceStatus, error: string, now: number): SourceStatus {
  return { ...source, error, fetchedAt: now };
}
