import type { Locale } from "../i18n";
import { t } from "../messages";
import { metricState, type Metric, type MetricState } from "../protocol/schema";
import { problems, unacknowledgedProblems, type SourceStatus } from "../monitor/dashboard";
import { footer } from "../glasses/footer";
import { cpuMetric, fullestDisk, percent } from "../glasses/host";
import { isOffline } from "../glasses/view";

/**
 * What the cockpit shows, in words and numbers, decided without drawing
 * (QUS v1): the headline, the label/value cells, the graphic for the left
 * half, the caption and the hint line. compose.ts only lays this out.
 *
 * Two kinds of page: the overview of every server ("Alle Server") and one
 * server. With a single server the overview is that server.
 */

export type Tone = "ok" | "warn" | "critical" | "offline";

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  /** Drawn with a frame round it (something is wrong here). */
  readonly alert?: boolean;
}

/** One bar of the left half: a reading against 0..100 %. */
export interface CockpitBar {
  readonly label: string;
  /** 0..100, or null when there is no reading. */
  readonly value: number | null;
  readonly text: string;
  readonly tone: Tone;
}

export type CockpitGraphic =
  /** A ring of one segment per server; the centre says how many are fine. */
  | { readonly kind: "ring"; readonly segments: readonly Tone[]; readonly center: string; readonly sub: string }
  /** CPU, RAM and disk of one server as bars. */
  | { readonly kind: "bars"; readonly bars: readonly CockpitBar[] };

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  /** One or two lines, already upper case. */
  readonly headline: readonly string[];
  /** Rows of three columns. */
  readonly cells: readonly CockpitCell[];
  readonly graphic: CockpitGraphic;
  /** Left bottom: when the data is from. */
  readonly caption: string;
  /** The one footer line with the gestures. */
  readonly hint: string;
  readonly tone: Tone;
}

/** Which page of the cockpit. */
export type CockpitPage =
  | { readonly kind: "overview" }
  | { readonly kind: "host"; readonly id: string };

export interface CockpitInput {
  readonly sources: readonly SourceStatus[];
  readonly page: CockpitPage;
  readonly now: number;
  readonly locale: Locale;
  /** The sample data of the first start: the caption says so. */
  readonly demo: boolean;
}

/** The pages a swipe walks through: the overview and every server; a single server is its own page. */
export function cockpitPages(sources: readonly SourceStatus[]): CockpitPage[] {
  if (sources.length === 1) return [{ kind: "host", id: sources[0]!.id }];
  return [{ kind: "overview" }, ...sources.map((source): CockpitPage => ({ kind: "host", id: source.id }))];
}

/** "HH:MM" of an epoch ms in the phone's time (24 h). */
export function hhmm(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** How one server stands: offline, critical (an open critical problem), warn (any problem, seen or not) or ok. */
export function hostTone(source: SourceStatus, now: number): Tone {
  if (isOffline(source, now)) return "offline";
  if (unacknowledgedProblems([source], now).some((problem) => problem.state === "critical")) return "critical";
  return problems([source], now).length > 0 ? "warn" : "ok";
}

const toneOf = (state: MetricState): Tone => (state === "critical" ? "critical" : state === "warn" ? "warn" : "ok");

/**
 * The one statement of a page: "ALLES OK", "2 PROBLEME", "3 GESEHEN" (problems
 * all acknowledged), "OFFLINE" (no source answers) or "KEINE QUELLE".
 */
export function statusLines(sources: readonly SourceStatus[], now: number, locale: Locale): string[] {
  if (sources.length === 0) return t(locale, "g.cp.noSource").split("|").map((line) => line.trim().toUpperCase());
  if (sources.every((source) => isOffline(source, now))) return [t(locale, "g.cp.offline").toUpperCase()];
  const list = problems(sources, now);
  const open = list.filter((problem) => !problem.acknowledged).length;
  if (open > 0) return [t(locale, open === 1 ? "g.cp.problem" : "g.cp.problems", { n: open }).toUpperCase()];
  if (list.length > 0) return [t(locale, "g.cp.seen", { n: list.length }).toUpperCase()];
  return [t(locale, "g.cp.allOk").toUpperCase()];
}

const DASH = "–";

/** RAM: the reference server sends `memory`; some sources say `ram`. */
function ramOf(source: SourceStatus): Metric | undefined {
  const metrics = source.report?.metrics ?? [];
  return metrics.find((metric) => metric.id === "memory") ?? metrics.find((metric) => metric.id === "ram");
}

function readingOf(metric: Metric | undefined): number | null {
  return metric !== undefined && typeof metric.value === "number" && Number.isFinite(metric.value) ? metric.value : null;
}

/** "5 h", "13 d" / "13 T": below two days hours, then days. */
export function uptimeShort(hours: number, locale: Locale): string {
  const h = Math.max(0, Math.round(hours));
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} ${t(locale, "g.cp.dayUnit")}`;
}

function cell(label: string, metric: Metric | undefined, format: (value: number) => string): CockpitCell {
  const value = readingOf(metric);
  if (value === null) return { label, value: DASH };
  const alert = metric !== undefined && metricState(metric) !== "ok";
  return { label, value: format(value), ...(alert ? { alert: true } : {}) };
}

/** The six cells of one server: CPU, RAM, disk, load, temperature, uptime. */
export function hostCells(source: SourceStatus, now: number, locale: Locale): CockpitCell[] {
  const offline = isOffline(source, now);
  const report = offline ? null : source.report;
  const pick = (id: string): Metric | undefined => (report ? report.metrics.find((metric) => metric.id === id) : undefined);
  const temp = pick("temp");
  return [
    cell("CPU", report ? cpuMetric(report) : undefined, percent),
    cell("RAM", report ? ramOf(source) : undefined, percent),
    cell(t(locale, "g.cp.disk"), report ? fullestDisk(report) : undefined, percent),
    cell(t(locale, "g.cp.load"), pick("load"), percent),
    cell(t(locale, "g.cp.temp"), temp, (value) => `${Math.round(value)}${temp?.unit ?? "°"}`),
    cell(t(locale, "g.cp.up"), pick("uptime"), (value) => uptimeShort(value, locale)),
  ];
}

function bar(label: string, metric: Metric | undefined, offline: boolean): CockpitBar {
  const value = offline ? null : readingOf(metric);
  if (value === null || metric === undefined) return { label, value: null, text: DASH, tone: "offline" };
  return { label, value: Math.max(0, Math.min(100, value)), text: percent(value), tone: toneOf(metricState(metric)) };
}

/** CPU, RAM and the fullest disk as bars. */
export function hostBars(source: SourceStatus, now: number, locale: Locale): CockpitBar[] {
  const offline = isOffline(source, now);
  const report = source.report;
  return [
    bar("CPU", report ? cpuMetric(report) : undefined, offline),
    bar("RAM", report ? ramOf(source) : undefined, offline),
    bar(t(locale, "g.cp.disk"), report ? fullestDisk(report) : undefined, offline),
  ];
}

/** The biggest reading of a metric over all servers that answer; its state decides the alert. */
function highest(sources: readonly SourceStatus[], now: number, pick: (source: SourceStatus) => Metric | undefined): { value: number; metric: Metric } | null {
  let best: { value: number; metric: Metric } | null = null;
  for (const source of sources) {
    if (isOffline(source, now)) continue;
    const metric = pick(source);
    const value = readingOf(metric);
    if (metric === undefined || value === null) continue;
    if (best === null || value > best.value) best = { value, metric };
  }
  return best;
}

/** The six cells of the overview: servers fine / warning / offline, then the highest CPU, RAM and disk. */
export function overviewCells(sources: readonly SourceStatus[], now: number, locale: Locale): CockpitCell[] {
  const tones = sources.map((source) => hostTone(source, now));
  const count = (wanted: readonly Tone[]): number => tones.filter((tone) => wanted.includes(tone)).length;
  const warn = count(["warn", "critical"]);
  const down = count(["offline"]);
  const max = (label: string, pick: (source: SourceStatus) => Metric | undefined): CockpitCell => {
    const top = highest(sources, now, pick);
    return top === null ? { label, value: DASH } : { label, value: percent(top.value), ...(metricState(top.metric) !== "ok" ? { alert: true } : {}) };
  };
  return [
    { label: "OK", value: String(count(["ok"])) },
    { label: t(locale, "g.cp.warn"), value: String(warn), ...(warn > 0 ? { alert: true } : {}) },
    { label: t(locale, "g.cp.down"), value: String(down), ...(down > 0 ? { alert: true } : {}) },
    max(t(locale, "g.cp.maxCpu"), (source) => (source.report ? cpuMetric(source.report) : undefined)),
    max(t(locale, "g.cp.maxRam"), ramOf),
    max(t(locale, "g.cp.maxDisk"), (source) => (source.report ? fullestDisk(source.report) : undefined)),
  ];
}

/** The newest successful answer, "Stand 14:05"; a server that has never answered says so. */
export function captionFor(sources: readonly SourceStatus[], now: number, locale: Locale, demo: boolean): string {
  if (demo) return t(locale, "g.cp.demo");
  const times = sources.map((source) => source.okAt).filter((time): time is number => time !== null);
  if (times.length === 0) return t(locale, "g.cp.never");
  const newest = Math.max(...times);
  const stale = sources.length > 0 && sources.every((source) => isOffline(source, now));
  return t(locale, stale ? "g.cp.staleAt" : "g.cp.dataAt", { time: hhmm(newest) });
}

/** The hint line: only the gestures that do something here. */
export function cockpitHint(locale: Locale, pages: number): string {
  return footer(locale, { tap: t(locale, "g.w.reload"), ...(pages > 1 ? { swipe: t(locale, "g.cp.swipe") } : {}) }, "back");
}

export function cockpitModel(input: CockpitInput): CockpitModel {
  const { sources, now, locale } = input;
  const pages = cockpitPages(sources);
  const page = input.page;
  const host = page.kind === "host" ? sources.find((source) => source.id === page.id) : undefined;
  const base = {
    title: "STATUS",
    clock: hhmm(now),
    caption: captionFor(sources, now, locale, input.demo),
    hint: cockpitHint(locale, pages.length),
  };
  if (host) {
    const tone = hostTone(host, now);
    return {
      ...base,
      headline: [host.name.toUpperCase(), ...statusLines([host], now, locale)],
      cells: hostCells(host, now, locale),
      graphic: { kind: "bars", bars: hostBars(host, now, locale) },
      tone,
    };
  }
  const tones = sources.map((source) => hostTone(source, now));
  const fine = tones.filter((tone) => tone === "ok").length;
  const worst: Tone = tones.includes("critical") ? "critical" : tones.includes("offline") ? "offline" : tones.includes("warn") ? "warn" : "ok";
  return {
    ...base,
    headline: statusLines(sources, now, locale),
    cells: overviewCells(sources, now, locale),
    graphic: { kind: "ring", segments: tones, center: sources.length === 0 ? DASH : `${fine}/${sources.length}`, sub: t(locale, "g.cp.ringSub") },
    tone: sources.length === 0 ? "offline" : worst,
  };
}

/** A key that changes exactly when what the cockpit would draw changes (the tile sender dedupes on pixels; this is for tests and callers). */
export function modelKey(model: CockpitModel): string {
  return JSON.stringify([model.clock, model.headline, model.cells, model.graphic, model.caption, model.hint]);
}
