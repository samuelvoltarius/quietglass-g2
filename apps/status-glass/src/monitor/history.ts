import { metricState, type Metric, type MetricState, type SourceReport } from "../protocol/schema";

/**
 * The last readings of CPU, GPU and RAM per source, kept for the sparklines.
 *
 * Only the three load metrics every machine has are tracked; they are found by
 * their id or label so any source that follows the protocol gets a graph
 * without extra configuration.
 */
export type SparkKey = "cpu" | "gpu" | "ram";

/** How many readings a sparkline shows. */
export const SPARK_POINTS = 12;

export const SPARK_ORDER: readonly SparkKey[] = ["cpu", "gpu", "ram"];

/** Which load metric a protocol metric is, if any. */
export function sparkKey(metric: Pick<Metric, "id" | "label">): SparkKey | null {
  for (const text of [metric.id, metric.label]) {
    const name = text.trim().toLowerCase();
    if (/^(cpu|processor|prozessor|load)(?![a-z])/.test(name)) return "cpu";
    if (/^gpu(?![a-z])/.test(name)) return "gpu";
    if (/^(ram|mem|memory|speicher|arbeitsspeicher)(?![a-z])/.test(name)) return "ram";
  }
  return null;
}

export interface SparkSeries {
  readonly key: SparkKey;
  /** Short label drawn into the picture, upper case. */
  readonly label: string;
  /** Oldest first, at most SPARK_POINTS readings. */
  readonly values: readonly number[];
  readonly unit: string;
  readonly warn: number | undefined;
  readonly critical: number | undefined;
  readonly lowerIsWorse: boolean;
  readonly state: MetricState;
}

export class MetricHistory {
  readonly #values = new Map<string, number[]>();

  /** Notes the readings of a fresh report. Call once per report, not per redraw. */
  record(sourceId: string, report: SourceReport): void {
    for (const metric of report.metrics) {
      const key = sparkKey(metric);
      if (key === null || typeof metric.value !== "number" || !Number.isFinite(metric.value)) continue;
      const id = sourceId + "\u0000" + key;
      const list = this.#values.get(id) ?? [];
      list.push(metric.value);
      while (list.length > SPARK_POINTS) list.shift();
      this.#values.set(id, list);
    }
  }

  forget(sourceId: string): void {
    for (const id of [...this.#values.keys()]) if (id.startsWith(sourceId + "\u0000")) this.#values.delete(id);
  }

  /** The sparklines of one source, in the order CPU, GPU, RAM; metrics without readings are left out. */
  series(sourceId: string, report: SourceReport | null): SparkSeries[] {
    if (!report) return [];
    const out: SparkSeries[] = [];
    for (const key of SPARK_ORDER) {
      const metric = report.metrics.find((m) => sparkKey(m) === key && typeof m.value === "number");
      const values = this.#values.get(sourceId + "\u0000" + key);
      if (!metric || !values || values.length === 0) continue;
      out.push({
        key,
        label: key.toUpperCase(),
        values: [...values],
        unit: metric.unit ?? "",
        warn: metric.warn,
        critical: metric.critical,
        lowerIsWorse: metric.lowerIsWorse === true,
        state: metricState(metric),
      });
    }
    return out;
  }
}
