import type { Locale } from "../i18n";
import { describeIssue, t } from "../messages";
import { formatMetric, metricState, type Metric, type SourceReport } from "../protocol/schema";
import { NET_NEW_PREFIX, problems, type SourceStatus } from "../monitor/dashboard";
import { LINE_WIDTH, fit } from "./view";

/**
 * How the glasses talk about one machine: the compact line of the overview,
 * the warning texts, and every value on the detail page.
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

/** "13 T 4 h" / "13 d 4 h", or "5 h" below a day. */
export function uptimeText(hours: number, locale: Locale): string {
  const h = Math.max(0, Math.round(hours));
  if (h < 24) return `${h} h`;
  return t(locale, "g.days", { d: Math.floor(h / 24), h: h % 24 });
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

/** Packs short items into lines of at most `width`, separated by " · ". */
export function pack(items: readonly string[], width = LINE_WIDTH): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of items.map((i) => fit(i, width))) {
    if (!current) { current = item; continue; }
    if (current.length + 3 + item.length <= width) current += " · " + item;
    else { lines.push(current); current = item; }
  }
  if (current) lines.push(current);
  return lines;
}

const KNOWN = /^(cpu|load|memory|freemem|swap|disk:.*|temp|temp_nvme|gpu|gpu_mem|gpu_temp|gpu_power|net_rx|net_tx|docker|failed|svc:.*|tailscale|uptime)$/;

/**
 * Every line of the detail page: the problems first (worst on top, with the
 * names of failed units below), then all values grouped by kind, then
 * whatever else the source sends.
 */
export function detailLines(source: SourceStatus, locale: Locale, now: number): string[] {
  const report = source.report;
  const lines: string[] = [];
  const width = LINE_WIDTH;

  if (source.error !== null) lines.push("! " + fit(describeIssue(source.error, locale), width - 2));

  for (const problem of problems([source], now)) {
    if (problem.metric.id === "__source") continue;
    const mark = problem.state === "critical" ? "! " : problem.state === "warn" ? "· " : "? ";
    const ack = problem.acknowledged ? " " + t(locale, "g.ack") : "";
    const text = problem.metric.id === "__stale" ? t(locale, "g.stale") : describeMetric(problem.metric, locale);
    lines.push(mark + fit(text, width - mark.length - ack.length) + ack);
    // The names are the point of a failed-units warning.
    if ((problem.metric.id === "failed" || problem.metric.id === "docker") && problem.metric.detail) {
      lines.push(fit("  " + problem.metric.detail, width));
    }
  }

  if (!report) return lines.length > 0 ? lines : [t(locale, "g.detailEmpty")];

  const items: string[] = [];
  const add = (text: string | null): void => { if (text) items.push(text); };
  const flush = (): void => { lines.push(...pack(items.splice(0))); };

  const cpu = find(report, "cpu");
  const load = find(report, "load");
  if (valued(cpu)) add(`CPU ${percent(cpu.value)}`);
  if (valued(load)) add(`${t(locale, "g.load")} ${percent(load.value)}${load.detail ? ` (${load.detail})` : ""}`);
  flush();

  const ram = find(report, "memory");
  const swap = find(report, "swap");
  if (valued(ram)) add(`RAM ${percent(ram.value)}${ram.detail ? " " + ram.detail : ""}`);
  if (valued(swap)) add(`Swap ${percent(swap.value)}${swap.detail ? " " + swap.detail : ""}`);
  flush();

  for (const disk of report.metrics.filter((m) => m.id.startsWith("disk:") && typeof m.value === "number")) {
    add(`${t(locale, "g.disk")} ${disk.id.slice(5)} ${percent(disk.value!)}${disk.detail ? " " + disk.detail : ""}`);
  }
  flush();

  const temp = find(report, "temp");
  const nvme = find(report, "temp_nvme");
  if (valued(temp)) add(`${t(locale, "g.temp")} ${number(temp.value, locale)}${temp.unit ?? ""}`);
  if (valued(nvme)) add(`NVMe ${number(nvme.value, locale)}${nvme.unit ?? ""}`);

  const gpu = find(report, "gpu");
  const gpuParts: string[] = [];
  if (valued(gpu)) gpuParts.push(percent(gpu.value));
  const gpuMem = find(report, "gpu_mem");
  if (valued(gpuMem)) gpuParts.push(`VRAM ${percent(gpuMem.value)}`);
  const gpuTemp = find(report, "gpu_temp");
  if (valued(gpuTemp)) gpuParts.push(`${number(gpuTemp.value, locale)}${gpuTemp.unit ?? ""}`);
  const gpuPower = find(report, "gpu_power");
  if (valued(gpuPower)) gpuParts.push(`${number(gpuPower.value, locale)} ${gpuPower.unit ?? "W"}`.trim());
  if (gpuParts.length > 0) add("GPU " + gpuParts.join(" "));
  flush();

  const rx = find(report, "net_rx");
  const tx = find(report, "net_tx");
  if (valued(rx) && valued(tx)) {
    add(t(locale, "g.net", { rx: number(rx.value, locale), tx: number(tx.value, locale), unit: rx.unit ?? "" }).trim());
  }
  const docker = find(report, "docker");
  if (valued(docker) && metricState(docker) === "ok") add(t(locale, "g.docker", { count: Math.round(docker.value) }));
  flush();

  const home = networkLine(report, locale);
  if (home) lines.push(fit(home, width));

  const failed = find(report, "failed");
  if (valued(failed) && failed.value === 0) add(t(locale, "g.noFailed"));
  const tailscale = find(report, "tailscale");
  if (tailscale && metricState(tailscale) === "ok") {
    const peers = /^(\d+)\/(\d+)/.exec(tailscale.detail ?? "");
    add(peers ? t(locale, "g.tailscalePeers", { on: peers[1] ?? "", all: peers[2] ?? "" }) : "Tailscale ok");
  }
  for (const service of report.metrics.filter((m) => m.id.startsWith("svc:") && metricState(m) === "ok")) {
    add(`${service.id.slice(4)} ok`);
  }
  const uptime = find(report, "uptime");
  if (valued(uptime)) add(t(locale, "g.uptime", { time: uptimeText(uptime.value, locale) }));
  flush();

  // Whatever else the source sends, the generic way; unhealthy ones are already on top.
  for (const metric of report.metrics) {
    if (KNOWN.test(metric.id) || metricState(metric) !== "ok") continue;
    add(formatMetric(metric, locale));
  }
  flush();

  return lines.length > 0 ? lines : [t(locale, "g.detailEmpty")];
}
