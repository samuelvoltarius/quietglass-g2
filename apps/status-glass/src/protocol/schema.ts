/**
 * The Status Glass protocol.
 *
 * Deliberately small. The point is that anyone can emit it from a shell script
 * in ten minutes — if the protocol needs a client library, nobody will write an
 * integration for their own homelab.
 *
 * A source returns this JSON over HTTP, or pushes the same shape over a
 * WebSocket. Everything except `metrics` is optional.
 *
 * ```json
 * {
 *   "name": "nas",
 *   "metrics": [
 *     { "id": "cpu",  "label": "CPU",  "value": 34, "unit": "%",  "warn": 80, "critical": 95 },
 *     { "id": "disk", "label": "Disk", "value": 91, "unit": "%",  "warn": 85, "critical": 95 },
 *     { "id": "web",  "label": "Web",  "state": "ok" }
 *   ]
 * }
 * ```
 */

export type MetricState = "ok" | "warn" | "critical" | "unknown";

export interface Metric {
  readonly id: string;
  readonly label: string;
  /** Numeric reading. Omit for a pure state check. */
  readonly value?: number;
  readonly unit?: string;
  /** Thresholds. Omitted means the metric is never judged by value. */
  readonly warn?: number;
  readonly critical?: number;
  /**
   * Explicit state, for things that are not numbers ("is the service up").
   * When present it wins over the thresholds.
   */
  readonly state?: MetricState;
  /** Higher is worse by default; set for metrics like free space. */
  readonly lowerIsWorse?: boolean;
}

/**
 * Something the user can trigger from the glasses.
 *
 * A source that offers actions must accept `POST <url>/action` with
 * `{"id": "<action id>"}`. Actions are opt-in on the source side: a source that
 * lists none is read-only, which is the safe default.
 */
export interface Action {
  readonly id: string;
  readonly label: string;
  /**
   * Require a second tap before running.
   *
   * The source decides this, not the app — only the source knows whether an
   * action unlocks a door or dims a lamp. Anything with consequences should
   * set it.
   */
  readonly confirm?: boolean;
}

export interface SourceReport {
  readonly name: string;
  readonly metrics: readonly Metric[];
  /** Producer's timestamp in ms. Absent means "now".  */
  readonly timestamp?: number;
  /** Optional; a source without actions is read-only. */
  readonly actions?: readonly Action[];
}

export interface ParseResult {
  readonly report: SourceReport | null;
  readonly errors: readonly string[];
}

/**
 * Parses a report defensively. A source that returns rubbish must degrade to
 * "unknown", never take the dashboard down.
 */
export function parseReport(raw: string, fallbackName = "source"): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { report: null, errors: ["Response was not valid JSON."] };
  }
  return reportFromValue(value, fallbackName);
}

export function reportFromValue(value: unknown, fallbackName = "source"): ParseResult {
  const errors: string[] = [];
  if (!value || typeof value !== "object") {
    return { report: null, errors: ["Response was not a JSON object."] };
  }

  const root = value as Record<string, unknown>;
  const rawMetrics = Array.isArray(root["metrics"]) ? root["metrics"] : null;
  if (!rawMetrics) {
    return { report: null, errors: ['Response had no "metrics" array.'] };
  }

  const metrics: Metric[] = [];
  rawMetrics.forEach((candidate, index) => {
    const m = (candidate ?? {}) as Record<string, unknown>;
    const id = typeof m["id"] === "string" && m["id"] ? m["id"] : "m" + (index + 1);
    const label = typeof m["label"] === "string" && m["label"] ? m["label"] : id;

    const metric: Metric = {
      id,
      label,
      ...(isNumber(m["value"]) ? { value: m["value"] } : {}),
      ...(typeof m["unit"] === "string" ? { unit: m["unit"] } : {}),
      ...(isNumber(m["warn"]) ? { warn: m["warn"] } : {}),
      ...(isNumber(m["critical"]) ? { critical: m["critical"] } : {}),
      ...(isState(m["state"]) ? { state: m["state"] } : {}),
      ...(typeof m["lowerIsWorse"] === "boolean" ? { lowerIsWorse: m["lowerIsWorse"] } : {}),
    };

    if (metric.value === undefined && metric.state === undefined) {
      errors.push('Metric "' + label + '" has neither a value nor a state.');
      return;
    }
    metrics.push(metric);
  });

  const actions = readActions(root["actions"], errors);

  return {
    report: {
      name: typeof root["name"] === "string" && root["name"] ? root["name"] : fallbackName,
      metrics,
      ...(isNumber(root["timestamp"]) ? { timestamp: root["timestamp"] } : {}),
      ...(actions.length > 0 ? { actions } : {}),
    },
    errors,
  };
}

function readActions(value: unknown, errors: string[]): Action[] {
  if (!Array.isArray(value)) return [];
  const actions: Action[] = [];
  const seen = new Set<string>();

  for (const candidate of value) {
    const a = (candidate ?? {}) as Record<string, unknown>;
    const id = typeof a["id"] === "string" ? a["id"].trim() : "";
    if (!id) { errors.push("An action without an id was dropped."); continue; }
    // A duplicate id would make the wrong thing run.
    if (seen.has(id)) { errors.push('Duplicate action id "' + id + '" was dropped.'); continue; }
    seen.add(id);

    actions.push({
      id,
      label: typeof a["label"] === "string" && a["label"] ? a["label"] : id,
      // Anything not explicitly false is treated as needing confirmation only
      // when the source says so; the default is no confirmation.
      ...(a["confirm"] === true ? { confirm: true } : {}),
    });
  }
  return actions;
}

/** Judges one metric. An explicit state always wins over thresholds. */
export function metricState(metric: Metric): MetricState {
  if (metric.state) return metric.state;
  if (metric.value === undefined) return "unknown";

  const worse = (limit: number | undefined): boolean => {
    if (limit === undefined) return false;
    return metric.lowerIsWorse ? metric.value! <= limit : metric.value! >= limit;
  };

  if (worse(metric.critical)) return "critical";
  if (worse(metric.warn)) return "warn";
  return "ok";
}

const SEVERITY: Record<MetricState, number> = { ok: 0, unknown: 1, warn: 2, critical: 3 };

export function worstState(states: readonly MetricState[]): MetricState {
  let worst: MetricState = "ok";
  for (const state of states) {
    if (SEVERITY[state] > SEVERITY[worst]) worst = state;
  }
  return worst;
}

export function severityOf(state: MetricState): number {
  return SEVERITY[state];
}

/** Formats a metric for one display line. */
export function formatMetric(metric: Metric): string {
  if (metric.value === undefined) return metric.label;
  const rounded = Math.abs(metric.value) >= 100
    ? Math.round(metric.value)
    : Math.round(metric.value * 10) / 10;
  return metric.label + " " + rounded + (metric.unit ?? "");
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isState(value: unknown): value is MetricState {
  return value === "ok" || value === "warn" || value === "critical" || value === "unknown";
}
