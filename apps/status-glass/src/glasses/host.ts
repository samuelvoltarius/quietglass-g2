import type { Locale } from "../i18n";
import { t } from "../messages";
import { formatMetric, metricState, type Metric, type SourceReport } from "../protocol/schema";
import { NET_NEW_PREFIX } from "../monitor/dashboard";

/**
 * How the app talks about one machine: the key figures, the warning texts and
 * the readings the cockpit and the phone show.
 *
 * The well-known ids are the ones the reference server sends (cpu, load,
 * memory, swap, disk:<mount>, temp, gpu*, net_*, docker, failed, svc:<name>,
 * tailscale, uptime). Anything else a source sends is shown the generic way,
 * with its own label and unit, so the protocol stays open.
 */

/** A number the way the language writes it: 12, 3,4 (de) / 3.4 (en). */
export function number(value: number, locale: Locale): string {
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  const text = String(rounded);
  return locale === "de" ? text.replace(".", ",") : text;
}

/** "12%" — percentages are whole numbers on the glasses. */
export function percent(value: number): string {
  return `${Math.round(value)}%`;
}

function find(report: SourceReport | null, id: string): Metric | undefined {
  return report?.metrics.find((m) => m.id === id);
}

function valued(metric: Metric | undefined): metric is Metric & { value: number } {
  return metric !== undefined && typeof metric.value === "number";
}

/** The fullest disk of a report, if it sends any `disk:` metric. */
export function fullestDisk(report: SourceReport | null): (Metric & { value: number }) | undefined {
  const disks = (report?.metrics ?? []).filter((m): m is Metric & { value: number } => m.id.startsWith("disk:") && typeof m.value === "number");
  return disks.sort((a, b) => b.value - a.value)[0];
}

/** The CPU reading: real CPU usage when the source has it, else load per core. */
export function cpuMetric(report: SourceReport | null): Metric | undefined {
  const cpu = find(report, "cpu");
  return valued(cpu) ? cpu : find(report, "load");
}

/**
 * One line per machine for the overview: CPU, RAM, the fullest disk and the
 * temperature. Null when the source sends none of them (the caller then falls
 * back to the generic text).
 */
export function compactLine(report: SourceReport | null, locale: Locale): string | null {
  const parts: string[] = [];
  const cpu = cpuMetric(report);
  if (valued(cpu)) parts.push(`CPU ${percent(cpu.value)}`);
  const ram = find(report, "memory");
  if (valued(ram)) parts.push(`RAM ${percent(ram.value)}`);
  const disk = fullestDisk(report);
  if (disk) parts.push(`${t(locale, "g.disk")} ${percent(disk.value)}`);
  const temp = find(report, "temp");
  if (valued(temp)) parts.push(`${Math.round(temp.value)}${temp.unit ?? ""}`);
  return parts.length > 0 ? parts.join("  ") : null;
}

/**
 * "Netz: 23 Geräte · 1 NEU" (or "· 21 online" when nothing is new); null when
 * the source does not watch its home network.
 */
export function networkLine(report: SourceReport | null, locale: Locale): string | null {
  const network = report?.network;
  if (!network) return null;
  return network.new > 0
    ? t(locale, "g.netLineNew", { total: network.total, count: network.new })
    : t(locale, "g.netLine", { total: network.total, online: network.online });
}

/**
 * The words for a metric that is not healthy. The reference server's own ids
 * get a sentence in the chosen language; everything else keeps its label.
 */
export function describeMetric(metric: Metric, locale: Locale): string {
  const value = typeof metric.value === "number" ? metric.value : undefined;
  if (metric.id.startsWith(NET_NEW_PREFIX)) {
    const count = Math.round(value ?? 1);
    return count === 1 && metric.detail
      ? t(locale, "g.netNewOne", { name: metric.detail })
      : t(locale, "g.netNewMany", { count });
  }
  if (metric.id === "failed" && value !== undefined) {
    if (value === 0) return t(locale, "g.noFailed");
    return Math.round(value) === 1 ? t(locale, "g.failedUnit") : t(locale, "g.failedUnits", { count: Math.round(value) });
  }
  if (metric.id.startsWith("disk:") && value !== undefined) {
    return t(locale, "g.diskFull", { mount: metric.id.slice(5), value: percent(value) });
  }
  if (metric.id.startsWith("svc:")) {
    return t(locale, "g.service", { name: metric.id.slice(4), state: metric.detail ?? metric.state ?? "?" });
  }
  if (metric.id === "tailscale" && metricState(metric) !== "ok") return t(locale, "g.tailscaleOff");
  if (metric.id === "docker" && metricState(metric) !== "ok") return "Docker: " + (metric.detail ?? metric.state ?? "");
  return formatMetric(metric, locale);
}
