import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import type { Brief, HubReport } from "../api/types";
import { carBrief } from "../hub/areas";
import { CAR_COMMANDS } from "../hub/status-pages";
import { printerActions } from "../hub/model";
import { hhmm, type CockpitCell, type CockpitModel } from "./model";
import { PRINTER, trendBearing, WEATHER_PATTERNS, weatherKind, type Tone } from "./widgets";
import { trendArrow, weatherWord } from "../hub/brief";

/**
 * The area pages as cockpit pictures (0.13), laid out by compose.ts like every QUS app:
 * Auto = battery ring of BYD Glass (pulses while charging), Server = segment ring of Status Glass,
 * Drucker = progress ring with a running marker while printing. Pure: the hub model's pieces in,
 * the words and numbers out. The hint line is the page's footer (gestures, an armed action or a message).
 */

type T = (key: string, vars?: Record<string, string | number>) => string;
const tFor = (locale: Locale): T => (key, vars = {}) => tr(messages, locale, key, vars);

function ago(at: number | undefined, now: number, t: T): string {
  if (typeof at !== "number" || at <= 0) return "–";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? t("st.justNow") : minutes < 120 ? t("st.agoMin", { n: minutes }) : t("st.agoH", { n: Math.round(minutes / 60) });
}

const base = (title: string, now: number, hint: string): Pick<CockpitModel, "title" | "clock" | "hint" | "mood" | "tone" | "state"> =>
  ({ title, clock: hhmm(now), hint, mood: "idle", tone: "ok", state: "ready" });

export function carPage(report: HubReport, brief: Brief | null | undefined, carIndex: number, locale: Locale, now: number, hint: string): CockpitModel {
  const t = tFor(locale);
  const shown = carBrief(report, brief);
  const car = shown?.car;
  const head = { ...base(t("tile.car"), now, hint) };
  if (car === undefined || (car.status !== "ok" && car.stale !== true)) {
    const why = car === undefined ? t("st.loading") : t(car.status === "off" ? "car.off" : "car.unreachable");
    return { ...head, headline: [car === undefined ? "…" : "–"], cells: [], caption: why, graphic: { kind: "ring", percent: null, tone: "offline", center: "–", sub: "" } };
  }
  const soc = typeof car.soc === "number" ? car.soc : null;
  const tone: Tone = car.stale === true ? "offline" : soc !== null && soc < 15 ? "critical" : soc !== null && soc < 25 ? "warn" : "ok";
  const headline = car.locked === false ? t("cp.car.unlocked") : car.locked === true ? t("cp.car.locked") : t("cp.car.unknownLock");
  const cells: CockpitCell[] = [
    { label: t("cp.car.range"), value: typeof car.rangeKm === "number" ? `${car.rangeKm} km` : "–" },
    { label: t("cp.car.doors"), value: car.doorOpen === true ? t("cp.car.open") : car.doorOpen === false ? t("cp.car.shut") : "–", alert: car.doorOpen === true },
    { label: t("cp.car.charge"), value: car.charging === true ? t("area.charging") : car.chargeDone === true ? t("area.full") : t("cp.no") },
    { label: t("cp.car.climate"), value: car.climateOn === true ? t("cp.on") : car.climateOn === false ? t("cp.off") : "–" },
    { label: t("cp.car.outside"), value: typeof car.outsideC === "number" ? `${Math.round(car.outsideC)}°` : "–" },
    { label: t("cp.car.asOf"), value: ago(car.stale === true ? car.since : shown?.at, now, t) },
  ];
  const control = report.carControl === true;
  const index = Math.max(0, Math.min(carIndex, CAR_COMMANDS.length - 1));
  const command = CAR_COMMANDS[index]!;
  const commandText = command.tempC === undefined ? t(`car.act.${command.aktion}`) : t("car.act.klima_an", { t: command.tempC, m: command.minuten ?? 15 });
  const caption = control ? `> ${commandText}  ${index + 1}/${CAR_COMMANDS.length}` : t("cp.car.readOnly");
  return {
    ...head, tone: car.locked === false ? "waiting" : "ok", headline: [headline], cells, caption,
    graphic: { kind: "ring", percent: soc, tone, center: soc === null ? "–" : `${soc} %`, sub: t("cp.car.battery"), pulse: car.charging === true },
  };
}

export function serverPage(brief: Brief | null | undefined, locale: Locale, now: number, hint: string): CockpitModel {
  const t = tFor(locale);
  const servers = brief?.servers;
  const head = base(t("tile.server"), now, hint);
  if (servers === undefined || (servers.status !== "ok" && servers.stale !== true)) {
    const why = servers === undefined ? t("st.loading") : t(servers.status === "off" ? "srv.off" : "srv.unreachable");
    return { ...head, headline: ["–"], cells: [], caption: why, graphic: { kind: "segments", segments: [], center: "–", sub: "" } };
  }
  const machines = servers.machines ?? [];
  const segments = machines.map((machine): Tone => (!machine.ok ? "critical" : (machine.warn ?? 0) > 0 ? "warn" : "ok"));
  const down = machines.filter((machine) => !machine.ok).length;
  const cells: CockpitCell[] = machines.slice(0, 6).map((machine) => ({
    label: machine.name.toUpperCase(),
    value: !machine.ok ? t("cp.srv.down") : (machine.warn ?? 0) > 0 ? t("cp.srv.warn", { n: machine.warn ?? 0 }) : (machine.newDevices ?? 0) > 0 ? t("cp.srv.new", { n: machine.newDevices ?? 0 }) : t("srv.ok"),
    alert: !machine.ok,
  }));
  return {
    ...head, tone: down > 0 ? "waiting" : "ok", headline: [down > 0 ? t("cp.srv.headDown", { n: down }) : t("cp.srv.headOk")], cells,
    caption: servers.stale === true ? t("st.stale", { ago: ago(servers.since, now, t) }) : t("st.asOf", { ago: ago(brief?.at, now, t) }),
    graphic: { kind: "segments", segments, center: `${machines.length - down}/${machines.length}`, sub: t("tile.server") },
  };
}

export function printerPage(report: HubReport, locale: Locale, now: number, hint: string): CockpitModel {
  const t = tFor(locale);
  const printer = report.printer;
  const head = base(t("tile.printer"), now, hint);
  if (printer.demo === true || printer.offline === true) {
    return {
      ...head, headline: [printer.demo === true ? t("cp.pr.notSet") : t("cp.pr.off")], caption: printer.demo === true ? "" : t("cp.pr.offHint"),
      cells: [], graphic: { kind: "icon", rows: PRINTER, dim: true },
    };
  }
  const percent = printer.progress ?? (printer.layers > 0 ? Math.round((printer.layer / printer.layers) * 100) : 0);
  const running = printer.state === "printing" || printer.state === "paused";
  const headline = printer.state === "printing" ? t("cp.pr.printing") : printer.state === "paused" ? t("cp.pr.paused") : printer.state === "error" ? t("cp.pr.error") : t("cp.pr.ready");
  const cells: CockpitCell[] = [
    ...(printer.job !== null ? [{ label: t("cp.pr.file"), value: printer.job }] : []),
    ...(printer.layers > 0 ? [{ label: t("cp.pr.layer"), value: `${printer.layer}/${printer.layers}` }] : []),
    ...(printer.etaMin !== null && printer.etaMin > 0 ? [{ label: t("cp.pr.left"), value: printer.etaMin < 60 ? `${printer.etaMin} min` : `${Math.floor(printer.etaMin / 60)}:${String(printer.etaMin % 60).padStart(2, "0")} h` }] : []),
    { label: t("cp.pr.nozzle"), value: `${Math.round(printer.nozzleC)}°` },
    { label: t("cp.pr.bed"), value: `${Math.round(printer.bedC)}°` },
  ];
  const actions = running ? printerActions(printer, locale) : [];
  const chosen = actions[Math.max(0, Math.min(printer.selected, actions.length - 1))];
  return {
    ...head, tone: printer.state === "error" ? "waiting" : "ok", headline: [headline], cells: cells.slice(0, 6),
    caption: chosen === undefined ? "" : `> ${chosen.label}`,
    graphic: running
      ? { kind: "ring", percent, tone: printer.state === "paused" ? "warn" : "ok", center: `${percent} %`, sub: printer.state === "paused" ? t("tile.paused") : t("cp.pr.progress"), spin: printer.state === "printing" }
      : { kind: "icon", rows: PRINTER, dim: printer.state !== "error" },
  };
}

/** Tag (page 0 of the briefing): the weather pictogram of Rain Lens, the day's numbers in cells. */
export function dayPage(brief: Brief | null | undefined, locale: Locale, now: number, hint: string): CockpitModel {
  const t = tFor(locale);
  const head = base(t("tile.day"), now, hint);
  if (brief === null || brief === undefined) return { ...head, headline: ["…"], cells: [], caption: t("st.loading"), graphic: { kind: "icon", rows: WEATHER_PATTERNS.cloud, dim: true } };
  const weather = brief.weather;
  const ok = weather.status === "ok";
  const temp = ok && typeof weather.tempC === "number" ? `${Math.round(weather.tempC)}°` : "–";
  const word = ok ? weatherWord(weather.code, locale).toUpperCase() : "";
  const events = brief.calendar.status === "ok" ? brief.calendar.events ?? [] : [];
  // The next timed appointment still ahead; an all-day one only when there is none.
  const next = events.find((event) => !event.allDay && event.start !== "" && event.endMs > now) ?? events.find((event) => event.allDay) ?? null;
  const rain = weather.rain;
  const rainShort = !ok || rain === undefined || rain.kind === "unknown" ? "–" : rain.kind === "none" ? t("cp.no") : rain.kind === "now" ? t("cp.day.rainNow") : t("cp.day.rainFrom", { at: rain.from });
  const total = brief.calendar.status === "ok" ? brief.calendar.total ?? events.length : null;
  const sugar = brief.sugar.status === "ok" ? brief.sugar.current : null;
  const out = sugar !== null && sugar !== undefined && (sugar.mgdl < (brief.sugar.low ?? 70) || sugar.mgdl > (brief.sugar.high ?? 180));
  const cells: CockpitCell[] = [
    { label: t("cp.day.maxMin"), value: ok && typeof weather.maxC === "number" && typeof weather.minC === "number" ? `${Math.round(weather.maxC)}°/${Math.round(weather.minC)}°` : "–" },
    { label: t("cp.day.rain"), value: rainShort },
    { label: t("cp.day.appts"), value: total === null ? "–" : String(total) },
    { label: t("cp.day.next"), value: next === null ? "–" : next.allDay || next.start === "" ? t("cp.day.allDay") : next.start },
    { label: t("cp.day.sugar"), value: sugar === null || sugar === undefined ? "–" : `${sugar.mgdl} ${trendArrow(sugar.direction)}`.trim(), alert: out },
    { label: t("cp.car.asOf"), value: ago(brief.at, now, t) },
  ];
  return {
    ...head, headline: [word === "" ? temp : `${temp} ${word}`], cells,
    caption: next === null ? t("tile.appts0") : next.title,
    graphic: { kind: "icon", rows: WEATHER_PATTERNS[ok ? weatherKind(weather.code) : "cloud"], dim: !ok },
  };
}

/** Zucker (page 1 of the briefing when the daemon sends the curve): Sugar Glass' curve of the last 3 h. */
export function sugarPage(brief: Brief | null | undefined, locale: Locale, now: number, hint: string): CockpitModel {
  const t = tFor(locale);
  const sugar = brief?.sugar;
  const head = base(t("cp.sugar.title"), now, hint);
  const low = sugar?.low ?? 70;
  const high = sugar?.high ?? 180;
  const current = sugar?.status === "ok" ? sugar.current ?? null : null;
  const night = sugar?.status === "ok" ? sugar.night ?? null : null;
  const state = current === null ? "–" : current.mgdl < low ? t("cp.sugar.low") : current.mgdl > high ? t("cp.sugar.high") : t("cp.sugar.inRange");
  const out = current !== null && (current.mgdl < low || current.mgdl > high);
  const cells: CockpitCell[] = [
    { label: t("cp.sugar.state"), value: state, alert: out },
    { label: t("cp.car.asOf"), value: current === null ? "–" : t("st.agoMin", { n: current.ageMin }) },
    { label: t("cp.sugar.range"), value: `${low}–${high}` },
    { label: t("cp.sugar.night"), value: night === null ? "–" : `${night.min}–${night.max}` },
    { label: `<${low}`, value: night === null ? "–" : `${night.belowMin} min`, alert: night !== null && night.belowMin > 0 },
    { label: `>${high}`, value: night === null ? "–" : `${night.aboveMin} min` },
  ];
  const bearing = trendBearing(current?.direction);
  return {
    ...head, tone: out ? "waiting" : "ok",
    headline: [current === null ? "–" : `${current.mgdl} ${trendArrow(current.direction)}`.trim()], cells,
    caption: t("cp.sugar.caption"),
    graphic: { kind: "spark", points: sugar?.curve ?? [], band: { low, high }, ...(bearing === undefined ? {} : { arrow: bearing }), top: "mg/dL", ticks: ["-3h", "-2h", "-1h", t("cp.sugar.now")] },
  };
}
