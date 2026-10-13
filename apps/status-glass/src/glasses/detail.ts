import type { Locale } from "../i18n";
import { t } from "../messages";
import { sourceState, type SourceStatus } from "../monitor/dashboard";
import type { MetricHistory, SparkSeries } from "../monitor/history";
import { cpuMetric, detailLines } from "./host";
import { isOffline } from "./fleet";
import { HEADER_WIDTH, fit, type StatusView } from "./view";

/**
 * The detail page of one machine: every value, warnings on top, five rows a
 * page, and three sparklines (CPU, RAM, then GPU or temperature) underneath.
 */
export const DETAIL_ROWS = 5;

export interface DetailPage {
  readonly view: StatusView;
  readonly pages: number;
  /** The page actually shown (the requested one, kept in range). */
  readonly page: number;
}

export function detailPage(source: SourceStatus, page: number, locale: Locale, now: number): DetailPage {
  const lines = detailLines(source, locale, now);
  const pages = Math.max(1, Math.ceil(lines.length / DETAIL_ROWS));
  const shown = ((page % pages) + pages) % pages;
  const state = isOffline(source, now) ? "g.stateOffline"
    : ({ ok: "g.stateOk", warn: "g.stateWarn", critical: "g.stateCritical", unknown: "g.stateOffline" } as const)[sourceState(source, now)];
  const pager = pages > 1 ? ` · ${shown + 1}/${pages}` : "";
  return {
    view: {
      header: fit(source.name, HEADER_WIDTH - 3 - t(locale, state).length - pager.length) + " · " + t(locale, state) + pager,
      body: lines.slice(shown * DETAIL_ROWS, shown * DETAIL_ROWS + DETAIL_ROWS),
      footer: t(locale, "g.detailFooter"),
    },
    pages,
    page: shown,
  };
}

/** CPU, RAM and the GPU (or, without one, the temperature); empty slots are left out at the end. */
export function detailSeries(source: SourceStatus, history: MetricHistory): SparkSeries[] {
  const report = source.report;
  if (!report) return [];
  const find = (id: string) => report.metrics.find((m) => m.id === id);
  const third = history.seriesOf(source.id, find("gpu"), "gpu", "GPU")
    ?? history.seriesOf(source.id, find("temp"), "temp", "TEMP");
  return [
    history.seriesOf(source.id, cpuMetric(report), "cpu", "CPU"),
    history.seriesOf(source.id, find("memory"), "ram", "RAM"),
    third,
  ].filter((s): s is SparkSeries => s !== null);
}
