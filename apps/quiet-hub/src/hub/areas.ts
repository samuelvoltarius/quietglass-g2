/**
 * The start page as Alfred's command centre (Quiet Hub 0.11): six areas, each one row of live state,
 * and above them only what needs attention (a waiting approval, new alerts, a server down, the car
 * open, sugar out of range, a printer fault). Pure: the rows come from the report and the briefing,
 * so the page is testable without a daemon.
 *
 *   ! hermes-spark wartet auf Freigabe
 *   > Agenten · 6/8 online · 1 aktiv
 *     Zuhause · 2 Lichter an · TV an
 *     Auto · 60 % · 188 km · zu
 *     Drucker · bereit
 *     Server · 4/4 ok
 *     Tag · 14° · 2 Termine · 114 →
 *
 * The cursor is kept as a key ("area:home", "warn:approval"), not as a row number: a warning that
 * comes or goes must not move the cursor onto another area.
 */
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import type { Brief, HubReport } from "../api/types";
import { trendArrow } from "./brief";
import { homeViewOf } from "./zuhause";

export type AreaScreen = "agent" | "home" | "car" | "printer" | "server" | "brief";
/** The areas in row order. */
export const AREAS: readonly AreaScreen[] = ["agent", "home", "car", "printer", "server", "brief"];
/** At most this many warning rows above the areas (the rest are counted in the areas' own rows). */
export const MAX_WARNINGS = 2;

export interface StartEntry {
  /** Stable cursor key. */
  readonly key: string;
  /** The page a tap opens. */
  readonly screen: AreaScreen | "inbox";
  readonly text: string;
  readonly warn: boolean;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

const translator = (locale: Locale): T => (key, vars = {}) => tr(messages, locale, key, vars);

/**
 * The car as shown everywhere: Panoptes' own state from the report when the daemon is paired (source of truth,
 * e.g. for the lock), else the briefing's car block (old bridge). Only the car block and its time change.
 */
export function carBrief(report: HubReport, brief: Brief | null | undefined): Brief | null | undefined {
  const car = report.car;
  if (car === undefined) return brief;
  const at = typeof car.at === "number" ? car.at : brief?.at ?? 0;
  return { ...(brief ?? ({} as Brief)), car, at };
}

/** What needs the wearer now, most urgent first. */
export function warnings(report: HubReport, brief: Brief | null | undefined, locale: Locale): StartEntry[] {
  const t = translator(locale);
  const out: StartEntry[] = [];
  const card = report.approvals[0];
  if (card !== undefined) {
    const agent = report.agents.find((entry) => entry.id === card.agentId)?.label ?? card.agentId;
    out.push({ key: "warn:approval", screen: "agent", warn: true, text: report.approvals.length > 1 ? t("area.warnApprovals", { n: report.approvals.length }) : t("area.warnApproval", { agent }) });
  }
  const unread = report.inbox.events.filter((event) => !event.read).length;
  if (unread > 0) out.push({ key: "warn:inbox", screen: "inbox", warn: true, text: t(unread === 1 ? "area.warnInbox1" : "area.warnInboxN", { n: unread }) });
  const servers = brief?.servers;
  if (servers?.status === "ok" && (servers.down ?? 0) > 0) {
    const names = (servers.machines ?? []).filter((machine) => !machine.ok).map((machine) => machine.name).join(", ");
    out.push({ key: "warn:server", screen: "server", warn: true, text: t("area.warnServer", { names }) });
  }
  const car = carBrief(report, brief)?.car;
  if (car?.status === "ok" && car.stale !== true && car.locked === false) out.push({ key: "warn:car", screen: "car", warn: true, text: t("area.warnCar") });
  const sugar = brief?.sugar;
  const current = sugar?.status === "ok" && sugar.stale !== true ? sugar.current : null;
  if (current !== null && current !== undefined && current.ageMin <= 15) {
    const low = sugar?.low ?? 70;
    const high = sugar?.high ?? 180;
    if (current.mgdl < low || current.mgdl > high) out.push({ key: "warn:sugar", screen: "brief", warn: true, text: t(current.mgdl < low ? "area.warnSugarLow" : "area.warnSugarHigh", { n: current.mgdl, arrow: trendArrow(current.direction) }).trim() });
  }
  if (report.printer.state === "error" && report.printer.offline !== true && report.printer.demo !== true) out.push({ key: "warn:printer", screen: "printer", warn: true, text: t("area.warnPrinter") });
  return out;
}

function agentLine(report: HubReport, t: T): string {
  if (report.agents.length === 0) return t("area.agentNone");
  const online = report.agents.filter((agent) => agent.online).length;
  const busy = report.agents.filter((agent) => agent.busy).length;
  const parts = [t("area.agent"), t("area.online", { online, total: report.agents.length })];
  if (report.approvals.length > 0) parts.push(t("area.waiting", { n: report.approvals.length }));
  else if (busy > 0) parts.push(t("area.busy", { n: busy }));
  return parts.join(" · ");
}

function homeLine(report: HubReport, t: T): string {
  const view = homeViewOf(report);
  if (view === null) return t("area.homeOff");
  if (view.error !== null && view.error !== undefined && view.error !== "") return `${t("area.home")} · ${t("area.haDown")}`;
  const real = Object.values(view.entities).filter((entity) => entity.group !== true);
  const lights = real.filter((entity) => entity.kind === "light" && entity.on).length;
  const parts = [t("area.home"), lights === 0 ? t("area.lights0") : t(lights === 1 ? "area.lights1" : "area.lightsN", { n: lights })];
  for (const media of real.filter((entity) => entity.kind === "media" && entity.on)) parts.push(t("area.mediaOn", { name: media.name }));
  const plugs = real.filter((entity) => entity.kind === "switch" && entity.on).length;
  if (plugs > 0) parts.push(t(plugs === 1 ? "area.plugsOn1" : "area.plugsOn", { n: plugs }));
  return parts.join(" · ");
}

function carLine(brief: Brief | null | undefined, t: T): string {
  const car = brief?.car;
  if (car === undefined) return `${t("area.car")} · …`;
  if (car.status === "off") return `${t("area.car")} · ${t("area.notSet")}`;
  if (car.status === "error" && car.stale !== true) return `${t("area.car")} · ${t("area.unreachable")}`;
  const parts = [t("area.car")];
  if (typeof car.soc === "number") parts.push(`${car.soc} %`);
  if (typeof car.rangeKm === "number") parts.push(`${car.rangeKm} km`);
  if (car.charging === true) parts.push(t("area.charging"));
  else if (car.chargeDone === true) parts.push(t("area.full"));
  if (car.locked === true) parts.push(t("area.locked"));
  else if (car.locked === false) parts.push(t("area.unlocked"));
  if (car.stale === true) parts.push(t("area.stale"));
  return parts.join(" · ");
}

function printerLine(report: HubReport, t: T): string {
  const printer = report.printer;
  const head = t("area.printer");
  if (printer.demo === true) return `${head} · ${t("area.notSet")}`;
  if (printer.offline === true) return `${head} · ${t("area.printerOff")}`;
  const percent = printer.progress ?? (printer.layers > 0 ? Math.round((printer.layer / printer.layers) * 100) : 0);
  const eta = printer.etaMin !== null && printer.etaMin > 0 ? ` · ${clock(printer.etaMin)}` : "";
  if (printer.state === "printing") return `${head} · ${t("area.printing", { n: percent })}${eta}`;
  if (printer.state === "paused") return `${head} · ${t("area.paused", { n: percent })}`;
  if (printer.state === "error") return `${head} · ${t("area.printerError")}`;
  return `${head} · ${t("area.ready")}`;
}

/** 80 -> "1:20 h", 25 -> "25 min". */
function clock(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} h`;
}

function serverLine(brief: Brief | null | undefined, t: T): string {
  const servers = brief?.servers;
  const head = t("area.server");
  if (servers === undefined) return `${head} · …`;
  if (servers.status === "off") return `${head} · ${t("area.notSet")}`;
  if (servers.status === "error") return `${head} · ${t("area.unreachable")}`;
  const machines = servers.machines ?? [];
  const ok = machines.filter((machine) => machine.ok).length;
  const parts = [head, (servers.down ?? 0) > 0 ? t("area.serversDown", { n: servers.down ?? 0 }) : t("area.serversOk", { ok, total: machines.length })];
  const warn = machines.reduce((sum, machine) => sum + (machine.warn ?? 0), 0);
  if (warn > 0) parts.push(t("area.hints", { n: warn }));
  if ((servers.newDevices ?? 0) > 0) parts.push(t(servers.newDevices === 1 ? "area.newDevice1" : "area.newDevices", { n: servers.newDevices ?? 0 }));
  return parts.join(" · ");
}

function dayLine(brief: Brief | null | undefined, t: T): string {
  const head = t("area.day");
  if (brief === null || brief === undefined) return `${head} · …`;
  const parts = [head];
  const weather = brief.weather;
  if (weather.status === "ok" && typeof weather.tempC === "number") parts.push(`${Math.round(weather.tempC)}°`);
  if (weather.status === "ok" && (weather.rain?.kind === "now" || weather.rain?.kind === "later")) parts.push(weather.rain.kind === "now" ? t("area.rainNow") : t("area.rainAt", { at: weather.rain.from }));
  const calendar = brief.calendar;
  if (calendar.status === "ok") {
    const n = calendar.total ?? calendar.events?.length ?? 0;
    parts.push(n === 0 ? t("area.appts0") : t(n === 1 ? "area.appts1" : "area.apptsN", { n }));
  }
  const current = brief.sugar.status === "ok" ? brief.sugar.current : null;
  if (current !== null && current !== undefined) parts.push(`${current.mgdl}${trendArrow(current.direction) ? ` ${trendArrow(current.direction)}` : ""}`);
  return parts.join(" · ");
}

/** One row of live state per area. */
export function areaLine(area: AreaScreen, report: HubReport, brief: Brief | null | undefined, locale: Locale): string {
  const t = translator(locale);
  switch (area) {
    case "agent": return agentLine(report, t);
    case "home": return homeLine(report, t);
    case "car": return carLine(carBrief(report, brief), t);
    case "printer": return printerLine(report, t);
    case "server": return serverLine(brief, t);
    case "brief": return dayLine(brief, t);
  }
}

/** Warning rows (at most MAX_WARNINGS) then the six areas. */
export function startEntries(report: HubReport, brief: Brief | null | undefined, locale: Locale): StartEntry[] {
  const warn = warnings(report, brief, locale).slice(0, MAX_WARNINGS);
  return [...warn, ...AREAS.map((area): StartEntry => ({ key: `area:${area}`, screen: area, warn: false, text: areaLine(area, report, brief, locale) }))];
}

/** Row of the cursor: its key when still there, else the remembered row number (clamped). */
export function cursorIndex(entries: readonly StartEntry[], key: string | null | undefined, fallback: number): number {
  const at = key === null || key === undefined ? -1 : entries.findIndex((entry) => entry.key === key);
  if (at >= 0) return at;
  return Math.max(0, Math.min(fallback, entries.length - 1));
}
