import type { Locale } from "../i18n";
import { t } from "../messages";
import { isStale, sourceState, unacknowledgedProblems, problems, type SourceStatus } from "../monitor/dashboard";
import type { MetricHistory, SparkSeries } from "../monitor/history";
import { formatMetric } from "../protocol/schema";
import { DIM, FULL, MID, createBitmap, drawText, fillRect, line, strokeRect, type Bitmap } from "./gfx";
import { PULSE_MS } from "./charts";
import { LINE_WIDTH, fit, problemText, type StatusView } from "./view";
import { compactLine } from "./host";

/**
 * The overview of several machines, one row each: a light, the name and a
 * sparkline in a 208 x 54 picture, and beside it one line with the key
 * figures (CPU, RAM, fullest disk, temperature).
 */
export const FLEET_ROWS = 4;
export const ROW_WIDTH = 208;
export const ROW_HEIGHT = 54;
/** Characters of the text column (364 px). */
export const ROW_TEXT_WIDTH = 36;

export type FleetState = "ok" | "warn" | "critical" | "offline";

export interface FleetRow {
  readonly id: string;
  readonly name: string;
  readonly state: FleetState;
  /** One line for the text column, already localised. */
  readonly text: string;
  /** The load line to draw, if the source reports one. */
  readonly series: SparkSeries | null;
  readonly selected: boolean;
}

/** A source that cannot be reached, or has been silent for too long. */
export function isOffline(source: SourceStatus, now: number): boolean {
  return source.error !== null || source.report === null || isStale(source, now);
}

/** "3 min", "2 h 10 min", "4 d" - how long ago something was. */
export function agePhrase(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
  return `${Math.floor(hours / 24)} d`;
}

/** The rows for the window around `cursor` (at most four machines at a time). */
export function fleetRows(
  sources: readonly SourceStatus[],
  history: MetricHistory,
  cursor: number,
  locale: Locale,
  now: number,
): FleetRow[] {
  const first = Math.max(0, Math.min(cursor - FLEET_ROWS + 1, sources.length - FLEET_ROWS));
  return sources.slice(first, first + FLEET_ROWS).map((source, offset) => {
    const selected = first + offset === cursor;
    const prefix = selected ? "> " : "  ";
    const series = history.series(source.id, source.report);
    const lead = series.find((s) => s.key === "cpu") ?? series[0] ?? null;
    if (isOffline(source, now)) {
      const since = source.okAt === null
        ? t(locale, "g.fleetNever")
        : t(locale, "g.fleetOffline", { time: agePhrase(now - source.okAt) });
      return { id: source.id, name: source.name, state: "offline", text: fit(prefix + since, ROW_TEXT_WIDTH), series: lead, selected };
    }
    const open = unacknowledgedProblems([source], now);
    const seen = problems([source], now);
    const worst = open[0] ?? seen[0];
    const state: FleetState = open.some((p) => p.state === "critical") ? "critical" : seen.length > 0 ? "warn" : "ok";
    // The key figures stay visible whatever is wrong: the light says that
    // something is, the header says what, a tap shows everything.
    const figures = compactLine(source.report, locale);
    let body: string;
    if (figures) {
      body = figures;
    } else if (worst) {
      const mark = worst.state === "critical" ? "! " : "· ";
      body = mark + problemText(worst.metric, locale) + (worst.acknowledged ? " " + t(locale, "g.ack") : "");
    } else {
      const parts = series.map((s) => `${s.label} ${formatMetricValue(s)}`);
      body = parts.length > 0 ? parts.join(" · ") : t(locale, "g.fleetFine");
    }
    return { id: source.id, name: source.name, state, text: fit(prefix + body, ROW_TEXT_WIDTH), series: lead, selected };
  });
}

function formatMetricValue(series: SparkSeries): string {
  const last = series.values[series.values.length - 1] ?? 0;
  const text = Number.isInteger(last) ? String(last) : last.toFixed(0);
  return series.unit === "%" ? `${text} %` : text;
}

/**
 * Header, one text per row (in `body`), and the hint in the footer.
 *
 * The header is the warning line: the worst problem nobody has seen yet
 * ("! Spark: 5 Dienste fehlgeschlagen +2"), or the count of healthy machines
 * when there is none. Offline machines are left to their own row.
 */
export function fleetView(
  sources: readonly SourceStatus[],
  rows: readonly FleetRow[],
  locale: Locale,
  now: number,
): StatusView {
  const ok = sources.filter((s) => sourceState(s, now) === "ok").length;
  const open = unacknowledgedProblems(sources.filter((s) => !isOffline(s, now)), now)
    .filter((p) => p.state === "warn" || p.state === "critical");
  let header = t(locale, "g.fleetHeader", { ok, total: sources.length });
  if (open.length > 0) {
    const worst = open[0]!;
    const more = open.length > 1 ? " " + t(locale, "g.fleetMore", { count: open.length - 1 }) : "";
    const mark = worst.state === "critical" ? "! " : "· ";
    header = mark + fit(worst.sourceName + ": " + problemText(worst.metric, locale), LINE_WIDTH - mark.length - more.length) + more;
  }
  return {
    header: fit(header, LINE_WIDTH),
    body: rows.map((row) => row.text),
    footer: t(locale, sources.some((s) => (s.report?.actions?.length ?? 0) > 0) ? "g.fleetFooterActions" : "g.fleetFooter"),
  };
}

/** True while a critical row pulses: the page then redraws twice a second. */
export function fleetPulses(rows: readonly FleetRow[]): boolean {
  return rows.some((row) => row.state === "critical");
}

/**
 * One row picture: the light (a disk when fine, a triangle for a warning, a
 * pulsing disk for critical, a crossed ring when offline), the name in pixel
 * letters and the load line. Pure in (row, now).
 */
export function fleetRowFrame(row: FleetRow, now: number): Bitmap {
  const b = createBitmap(ROW_WIDTH, ROW_HEIGHT);
  const cx = 16;
  const cy = 27;
  switch (row.state) {
    case "ok":
      disk(b, cx, cy, 9, FULL);
      break;
    case "warn":
      for (let y = 0; y < 18; y += 1) fillRect(b, cx - Math.floor(y / 2), cy - 9 + y, 2 * Math.floor(y / 2) + 1, 1, FULL);
      fillRect(b, cx, cy - 2, 1, 6, 0);
      fillRect(b, cx, cy + 5, 1, 2, 0);
      break;
    case "critical": {
      const bright = Math.floor(now / PULSE_MS) % 2 === 0;
      if (bright) {
        disk(b, cx, cy, 10, FULL);
        fillRect(b, cx - 1, cy - 6, 3, 8, 0);
        fillRect(b, cx - 1, cy + 4, 3, 3, 0);
      } else {
        // Dim phase: only the outline and the mark, so the pulse stays visible whatever the gray levels do.
        ring(b, cx, cy, 10, 8, MID);
        fillRect(b, cx - 1, cy - 6, 3, 8, MID);
        fillRect(b, cx - 1, cy + 4, 3, 3, MID);
      }
      break;
    }
    case "offline":
      ring(b, cx, cy, 10, 8, MID);
      line(b, cx - 6, cy - 6, cx + 6, cy + 6, MID, 2);
      line(b, cx + 6, cy - 6, cx - 6, cy + 6, MID, 2);
      break;
  }
  drawText(b, row.name.slice(0, 12), 36, 2, 2, row.state === "offline" ? MID : FULL);
  if (row.series) chart(b, row.series, 36, 22, ROW_WIDTH - 40, ROW_HEIGHT - 26, row.state === "offline");
  if (row.selected) strokeRect(b, 0, 0, ROW_WIDTH, ROW_HEIGHT, DIM);
  return b;
}

function disk(b: Bitmap, cx: number, cy: number, r: number, value: number): void {
  for (let y = -r; y <= r; y += 1) for (let x = -r; x <= r; x += 1) if (x * x + y * y <= r * r) fillRect(b, cx + x, cy + y, 1, 1, value);
}

function ring(b: Bitmap, cx: number, cy: number, outer: number, inner: number, value: number): void {
  for (let y = -outer; y <= outer; y += 1) {
    for (let x = -outer; x <= outer; x += 1) {
      const d = x * x + y * y;
      if (d <= outer * outer && d >= inner * inner) fillRect(b, cx + x, cy + y, 1, 1, value);
    }
  }
}

/** A thin load line with its latest point; dimmed when the machine is offline. */
function chart(b: Bitmap, series: SparkSeries, x: number, y: number, w: number, h: number, dim: boolean): void {
  const ink = dim ? DIM : FULL;
  fillRect(b, x, y + h, w, 1, DIM);
  const percent = series.unit === "%";
  let low = percent ? 0 : Math.min(...series.values);
  let high = percent ? 100 : Math.max(...series.values);
  if (high - low < 1) { low -= 1; high += 1; }
  const step = w / (11);
  const pts = series.values.map((v, i) => ({
    x: x + w - (series.values.length - 1 - i) * step,
    y: y + h - ((Math.min(high, Math.max(low, v)) - low) / (high - low)) * h,
  }));
  for (let i = 1; i < pts.length; i += 1) line(b, pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y, ink, 2);
  const tip = pts[pts.length - 1]!;
  fillRect(b, tip.x - 2, tip.y - 2, 5, 5, ink);
}

// formatMetric is re-exported for callers that print a metric the same way as the list does.
export { formatMetric };
