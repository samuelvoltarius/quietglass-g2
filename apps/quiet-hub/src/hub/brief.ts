/**
 * "Tagesstart": the morning briefing page, as pure functions.
 *
 * The daemon collects the blocks (calendar, weather, glucose, car, printer,
 * servers); this module turns them into compact rows with explicit " · "
 * separators (the G2 font is proportional, columns would not line up) and
 * packs whole blocks onto pages of seven rows. Swipe pages, tap refreshes.
 * Unconfigured blocks are left out; only the calendar says that it has no
 * source, so an empty page still explains itself.
 */
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import { fit, MAX_BODY_ROWS } from "../glasses/screen";
import { footer } from "../glasses/footer";
import type { Brief, BriefBlockBase, BriefCalendar, BriefCar, BriefEvent, BriefPrinter, BriefRain, BriefServers, BriefSugar, BriefWeather, BriefApptWeather } from "../api/types";

/** Where the page stands: no answer yet, an answer, the daemon has no /brief, or it failed. */
export type BriefLoad = "loading" | "ready" | "error" | "unsupported";

/** Event rows of the calendar block (one more says how many are left out). */
export const MAX_EVENT_ROWS = 5;
/** "Tagesstart als Startseite bis 11:00": the hour it stops being the start page. */
export const MORNING_UNTIL_HOUR = 11;
export const SEP = " · ";

const t = (locale: Locale, key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
const deg = (n: number | null | undefined): string => (typeof n === "number" ? `${n}°` : "–");

/** True when the Tagesstart should be the start page now (setting on, before 11:00 local time). */
export function morningStart(enabled: boolean, now: Date): boolean {
  return enabled && now.getHours() < MORNING_UNTIL_HOUR;
}

/** Short word for a WMO weather code. */
export function weatherWord(code: number | null | undefined, locale: Locale): string {
  if (typeof code !== "number") return "";
  const group = code === 0 ? "clear" : code === 1 ? "fair" : code === 2 ? "cloudy" : code === 3 ? "overcast"
    : code === 45 || code === 48 ? "fog" : code >= 51 && code <= 57 ? "drizzle" : code >= 61 && code <= 67 ? "rain"
      : code >= 71 && code <= 77 ? "snow" : code >= 80 && code <= 82 ? "showers" : code === 85 || code === 86 ? "snowShowers"
        : code >= 95 ? "storm" : "";
  return group === "" ? "" : t(locale, `wx.${group}`);
}

/** "Regen ab 14:00", "Regen bis 15:30", "Regen jetzt", "kein Regen" - the nowcast in words. */
export function rainText(rain: BriefRain | undefined, locale: Locale): string {
  if (rain === undefined || rain.kind === "unknown") return "";
  if (rain.kind === "none") return t(locale, "brief.rainNone");
  if (rain.kind === "now") return rain.until !== "" ? t(locale, "brief.rainUntil", { until: rain.until }) : t(locale, "brief.rainNow");
  return t(locale, "brief.rainFrom", { from: rain.from });
}

/** Nightscout direction -> arrow made only of glyphs the G2 draws. */
export function trendArrow(direction: string | undefined): string {
  switch (direction) {
    case "DoubleUp": return "↑↑";
    case "SingleUp": return "↑";
    case "FortyFiveUp": return "(↑)";
    case "Flat": return "→";
    case "FortyFiveDown": return "(↓)";
    case "SingleDown": return "↓";
    case "DoubleDown": return "↓↓";
    default: return "";
  }
}

const join = (...parts: readonly (string | null | undefined | false)[]): string => parts.filter((part): part is string => typeof part === "string" && part !== "").join(SEP);

/** The block's first word and why there is nothing to show, or null when it has data. */
function failed(block: BriefBlockBase, title: string, locale: Locale): string | null {
  if (block.status === "error") return join(title, t(locale, "brief.unreachable"));
  return null;
}
const staleMark = (block: BriefBlockBase, locale: Locale): string | null => (block.stale === true ? t(locale, "brief.stale") : null);

function eventRow(event: BriefEvent, locale: Locale): string {
  const when = event.allDay ? t(locale, "brief.allDay")
    : event.start === "" ? (event.end === "" ? t(locale, "brief.allDay") : t(locale, "brief.until", { time: event.end }))
      : event.end === "" ? event.start : `${event.start}–${event.end}`;
  return fit(`  ${when}${SEP}${event.title}`);
}

export function calendarRows(block: BriefCalendar, locale: Locale, now: number): string[] {
  const title = t(locale, "brief.calendar");
  if (block.status === "off") return [join(title, t(locale, "brief.noCalendar"))];
  const down = failed(block, title, locale);
  if (down !== null) return [down];
  const events = block.events ?? [];
  if (events.length === 0) return [join(title, t(locale, "brief.noEvents"), staleMark(block, locale))];
  // Finished ones only count; what is still ahead (and all-day) gets the rows.
  const ahead = events.filter((event) => event.allDay || event.endMs > now || (event.end === "" && event.startMs >= now));
  const past = events.length - ahead.length;
  const total = Math.max(block.total ?? events.length, events.length);
  const head = join(title, t(locale, total === 1 ? "brief.events1" : "brief.eventsN", { n: total }), past > 0 ? t(locale, "brief.past", { n: past }) : null, staleMark(block, locale));
  if (ahead.length === 0) return [head, fit(`  ${t(locale, "brief.allPast")}`)];
  const more = ahead.length + (total - events.length);
  const shown = more > MAX_EVENT_ROWS ? ahead.slice(0, MAX_EVENT_ROWS - 1) : ahead;
  const rows = [head, ...shown.map((event) => eventRow(event, locale))];
  if (more > shown.length) rows.push(fit(`  ${t(locale, "brief.more", { n: more - shown.length })}`));
  return rows;
}

export function weatherRows(block: BriefWeather, locale: Locale): string[] {
  const title = t(locale, block.place === "here" ? "brief.weatherHere" : block.place === "default" ? "brief.weatherDefault" : "brief.weather");
  const down = failed(block, title, locale);
  if (down !== null) return [down];
  const out: string[] = [];
  if (block.hereFailed === true) out.push(fit(join(title, t(locale, "brief.unreachable"))));
  else if (block.place !== undefined || block.tempC !== undefined) {
    const now = `${deg(block.tempC)}${weatherWord(block.code, locale) ? ` ${weatherWord(block.code, locale)}` : ""}`;
    const range = typeof block.minC === "number" && typeof block.maxC === "number" ? `${block.minC}–${block.maxC}°` : null;
    out.push(fit(join(title, now, range, rainText(block.rain, locale), staleMark(block, locale))));
  } else out.push(fit(join(title, staleMark(block, locale))));
  for (const appt of block.appts ?? []) out.push(apptWeatherRow(appt, locale));
  return out;
}

/** Wind from this speed on is worth a word (km/h). */
export const STRONG_WIND_KMH = 30;

/** "  10:30 Musterdorf 9° · Regen 60 %" - the forecast at the hour and place of one appointment. */
export function apptWeatherRow(appt: BriefApptWeather, locale: Locale): string {
  const wet = (appt.pop ?? 0) >= 30 || appt.mm >= 0.2;
  const rain = wet ? (typeof appt.pop === "number" ? t(locale, "brief.apptRainPop", { n: appt.pop }) : t(locale, "brief.apptRainMm", { mm: appt.mm })) : t(locale, "brief.apptDry");
  const wind = typeof appt.windKmh === "number" && appt.windKmh >= STRONG_WIND_KMH ? t(locale, "brief.apptWind", { n: appt.windKmh }) : null;
  const head = [appt.time, appt.label].filter((part) => part !== "").join(" ");
  return fit(`  ${join(`${head} ${deg(appt.tempC)}`.trim(), rain, wind)}`);
}

export function sugarRows(block: BriefSugar, locale: Locale): string[] {
  const title = t(locale, "brief.sugar");
  const down = failed(block, title, locale);
  if (down !== null) return [join(down, t(locale, "brief.infoOnly"))];
  const current = block.current ?? null;
  const night = block.night ?? null;
  if (current === null && night === null) return [join(title, t(locale, "brief.noValues"), t(locale, "brief.infoOnly"))];
  const now = current === null ? t(locale, "brief.noValues")
    : join(`${current.mgdl} mg/dL${trendArrow(current.direction) ? ` ${trendArrow(current.direction)}` : ""}`, t(locale, "brief.ago", { n: current.ageMin }));
  const rows = [fit(join(title, now, staleMark(block, locale), t(locale, "brief.infoOnly")))];
  rows.push(fit(night === null
    ? `  ${join(t(locale, "brief.night"), t(locale, "brief.noValues"))}`
    : `  ${join(`${t(locale, "brief.night")} ${night.min}–${night.max}`, t(locale, "brief.below", { low: block.low ?? 70, n: night.belowMin }), t(locale, "brief.above", { high: block.high ?? 180, n: night.aboveMin }))}`));
  return rows;
}

export function carRows(block: BriefCar, locale: Locale): string[] {
  const title = t(locale, "brief.car");
  const down = failed(block, title, locale);
  if (down !== null) return [down];
  const soc = typeof block.soc === "number" ? `${block.soc} %` : null;
  const range = typeof block.rangeKm === "number" ? `${block.rangeKm} km` : null;
  const charge = block.charging === true
    ? (typeof block.etaMin === "number" ? t(locale, "brief.chargingEta", { n: block.etaMin }) : t(locale, "brief.charging"))
    : block.chargeDone === true ? t(locale, "brief.charged") : t(locale, "brief.notCharging");
  const lock = block.locked === true ? t(locale, "brief.locked") : block.locked === false ? t(locale, "brief.unlocked") : null;
  return [fit(join(title, soc, range, charge, lock, staleMark(block, locale)))];
}

export function printerRows(block: BriefPrinter, locale: Locale): string[] {
  const title = t(locale, "brief.printer");
  const down = failed(block, title, locale);
  if (down !== null) return [down];
  const state = block.state ?? "standby";
  const pct = typeof block.progress === "number" ? ` ${block.progress} %` : "";
  const what = state === "printing" ? `${t(locale, "brief.p.printing")}${pct}`
    : state === "paused" ? `${t(locale, "brief.p.paused")}${pct}`
      : t(locale, `brief.p.${["complete", "cancelled", "error"].includes(state) ? state : "standby"}`);
  const left = (state === "printing" || state === "paused") && typeof block.minutesLeft === "number" ? t(locale, "brief.left", { n: block.minutesLeft }) : null;
  const file = state !== "standby" && (block.file ?? "") !== "" ? block.file : null;
  return [fit(join(title, what, left, file, staleMark(block, locale)))];
}

export function serverRows(block: BriefServers, locale: Locale): string[] {
  const title = t(locale, "brief.servers");
  const down = failed(block, title, locale);
  if (down !== null) return [down];
  const machines = block.machines ?? [];
  const bad = machines.filter((machine) => !machine.ok);
  const health = bad.length === 0 ? t(locale, "brief.allOk", { n: machines.length }) : t(locale, "brief.someOk", { ok: machines.length - bad.length, n: machines.length });
  const downNames = bad.length > 0 ? t(locale, "brief.down", { names: bad.map((machine) => machine.name).join(", ") }) : null;
  const fresh = (block.newDevices ?? 0) > 0 ? t(locale, (block.newDevices ?? 0) === 1 ? "brief.newDevice1" : "brief.newDevicesN", { n: block.newDevices ?? 0 }) : null;
  return [fit(join(title, health, downNames, fresh, staleMark(block, locale)))];
}

/** The page's blocks in reading order, each as its rows; unconfigured ones are left out. */
export function briefBlocks(brief: Brief | null | undefined, load: BriefLoad, locale: Locale, now: number): string[][] {
  if (brief === null || brief === undefined) {
    if (load === "unsupported") return [[t(locale, "brief.unsupported"), t(locale, "brief.unsupportedHint")]];
    if (load === "error") return [[t(locale, "brief.failed"), t(locale, "brief.retryHint")]];
    return [["", t(locale, "brief.loading")]];
  }
  const blocks: string[][] = [calendarRows(brief.calendar, locale, now)];
  if (brief.weather.status !== "off") blocks.push(weatherRows(brief.weather, locale));
  if (brief.sugar.status !== "off") blocks.push(sugarRows(brief.sugar, locale));
  if (brief.car.status !== "off") blocks.push(carRows(brief.car, locale));
  if (brief.printer.status !== "off") blocks.push(printerRows(brief.printer, locale));
  if (brief.servers.status !== "off") blocks.push(serverRows(brief.servers, locale));
  if (blocks.length === 1 && brief.calendar.status === "off") blocks.push([fit(t(locale, "brief.setupHint"))]);
  return blocks;
}

/** Whole blocks packed onto pages of `rows` rows (a block is never split unless it alone is taller). */
export function briefPages(blocks: readonly (readonly string[])[], rows = MAX_BODY_ROWS): string[][] {
  const pages: string[][] = [];
  let page: string[] = [];
  for (const block of blocks) {
    const lines = block.slice(0, rows);
    if (page.length > 0 && page.length + lines.length > rows) { pages.push(page); page = []; }
    page.push(...lines);
  }
  if (page.length > 0 || pages.length === 0) pages.push(page);
  return pages;
}

/** "Tagesstart · Mi 14.10. · Stand 07:12" - what, which day, how fresh. */
export function briefHeader(brief: Brief | null | undefined, locale: Locale, now: number): string {
  const tag = locale === "de" ? "de-AT" : "en-GB";
  const day = new Date(now).toLocaleDateString(tag, { weekday: "short", day: "numeric", month: "numeric" });
  const at = brief === null || brief === undefined ? null : new Date(brief.at).toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
  return fit(join("QUIET HUB", t(locale, "screen.brief"), day, at === null ? null : t(locale, "brief.asOf", { time: at })));
}

/** Footer: page position and the gestures. */
export function briefFooter(page: number, pages: number, locale: Locale): string {
  return footer(locale, {
    tap: t(locale, "f.reload"),
    ...(pages > 1 ? { swipe: t(locale, "f.scroll") } : {}),
  }, "back", pages > 1 ? `${page + 1}/${pages}` : "");
}

/** One-line summary for the overview row. */
export function briefSummary(brief: Brief | null | undefined, locale: Locale, now: number): string {
  if (brief === null || brief === undefined) return t(locale, "brief.tapToLoad");
  const parts: string[] = [];
  const calendar = brief.calendar;
  if (calendar.status === "ok") {
    const next = (calendar.events ?? []).find((event) => !event.allDay && event.startMs >= now);
    const n = calendar.total ?? (calendar.events ?? []).length;
    parts.push(next !== undefined ? t(locale, "brief.next", { time: next.start }) : t(locale, n === 1 ? "brief.events1" : "brief.eventsN", { n }));
  }
  if (brief.weather.status === "ok") parts.push([deg(brief.weather.tempC), rainText(brief.weather.rain, locale)].filter((part) => part !== "" && part !== "–").join(" "));
  if (brief.servers.status === "ok" && (brief.servers.down ?? 0) > 0) parts.push(t(locale, "brief.downN", { n: brief.servers.down ?? 0 }));
  return parts.length === 0 ? t(locale, "brief.open") : parts.join(SEP);
}
