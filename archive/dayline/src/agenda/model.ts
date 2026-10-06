export interface AgendaItem { readonly id: string; readonly at: string; readonly title: string; readonly kind: "event" | "reminder"; readonly done?: boolean; }
/** RFC 5545 folding is a line break plus one space or tab; pasted text and many exports use a bare LF. */
export function unfoldIcs(text: string): string[] { return text.replace(/\r?\n[ \t]/g, "").replace(/\r/g, "").split("\n"); }
/** RFC 5545 TEXT escapes; a newline becomes a space because a row on the glasses is a single line. */
export function unescapeIcsText(value: string): string { return value.replace(/\\([\\;,nN])/g, (_match, char: string) => char === "n" || char === "N" ? " " : char); }
/** Chronological, not lexical: "09:30+02:00" and "08:00Z" do not compare as strings. Unreadable times keep string order, after real ones. */
export function byTime(a: AgendaItem, b: AgendaItem): number { const left = Date.parse(a.at); const right = Date.parse(b.at); if (Number.isFinite(left) && Number.isFinite(right)) return left - right; if (Number.isFinite(left)) return -1; if (Number.isFinite(right)) return 1; return a.at.localeCompare(b.at); }
/** Agenda horizon for imported calendars: from the start of today through the next 30 days. Today's earlier events stay, so the day reads as a whole. */
export const ICS_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
interface IcsProp { readonly params: Readonly<Record<string, string>>; readonly value: string; }
export interface Wall { readonly y: number; readonly mo: number; readonly d: number; readonly h: number; readonly mi: number; readonly s: number; }
type Zone = { readonly kind: "utc" } | { readonly kind: "local" } | { readonly kind: "tz"; readonly format: Intl.DateTimeFormat };
export interface IcsTime { readonly wall: Wall; readonly zone: Zone; readonly dateOnly: boolean; }
/** Name, parameters and value; a colon inside a quoted parameter (ALTREP="http://…") does not end the name. */
export function splitIcsLine(line: string): { readonly name: string; readonly params: Record<string, string>; readonly value: string } | null {
  let quoted = false; let split = -1; for (let index = 0; index < line.length; index += 1) { const char = line[index]; if (char === "\"") quoted = !quoted; else if (char === ":" && !quoted) { split = index; break; } }
  if (split < 1) return null; const head = line.slice(0, split); const name = head.split(";", 1)[0]?.toUpperCase() ?? ""; const params: Record<string, string> = {};
  for (const match of head.matchAll(/;([^=;:]+)=("[^"]*"|[^;]*)/g)) params[(match[1] ?? "").toUpperCase()] = (match[2] ?? "").replace(/^"|"$/g, "");
  return { name, params, value: line.slice(split + 1) };
}
const zoneFormats = new Map<string, Intl.DateTimeFormat | null>();
function zoneFormat(id: string): Intl.DateTimeFormat | null { if (!zoneFormats.has(id)) { let format: Intl.DateTimeFormat | null = null; try { format = new Intl.DateTimeFormat("en-US", { timeZone: id, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }); } catch { format = null; } zoneFormats.set(id, format); } return zoneFormats.get(id) ?? null; }
/** An IANA zone Intl knows, also inside Mozilla-style "/mozilla.org/…/Europe/Vienna" ids; null (read as device-local) for anything else, e.g. Windows zone names. */
export function resolveTzid(tzid: string): Intl.DateTimeFormat | null { const id = tzid.trim().replace(/^"|"$/g, ""); if (!id) return null; return zoneFormat(id) ?? (id.includes("/") ? zoneFormat(id.split("/").filter(Boolean).slice(-2).join("/")) : null); }
function zoneOffset(format: Intl.DateTimeFormat, ms: number): number { const parts: Record<string, number> = {}; for (const part of format.formatToParts(new Date(ms))) parts[part.type] = Number(part.value); return Date.UTC(parts.year ?? 1970, (parts.month ?? 1) - 1, parts.day ?? 1, (parts.hour ?? 0) % 24, parts.minute ?? 0, parts.second ?? 0) - Math.floor(ms / 1000) * 1000; }
const wallMs = (wall: Wall): number => Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s);
const toWall = (ms: number): Wall => { const date = new Date(ms); return { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate(), h: date.getUTCHours(), mi: date.getUTCMinutes(), s: date.getUTCSeconds() }; };
/** Wall-clock time in an IANA zone to an instant; the second pass settles times next to a DST change. */
export function zonedToUtc(wall: Wall, format: Intl.DateTimeFormat): number { const guess = wallMs(wall); return guess - zoneOffset(format, guess - zoneOffset(format, guess)); }
function instant(time: IcsTime): number { const { y, mo, d, h, mi, s } = time.wall; if (time.dateOnly || time.zone.kind === "local") return new Date(y, mo - 1, d, h, mi, s).valueOf(); return time.zone.kind === "utc" ? wallMs(time.wall) : zonedToUtc(time.wall, time.zone.format); }
const pad = (value: number, size = 2): string => String(value).padStart(size, "0");
const wallIso = (wall: Wall): string => `${pad(wall.y, 4)}-${pad(wall.mo)}-${pad(wall.d)}T${pad(wall.h)}:${pad(wall.mi)}:${pad(wall.s)}`;
function atString(time: IcsTime): string { return time.dateOnly || time.zone.kind === "local" ? wallIso(time.wall) : time.zone.kind === "utc" ? `${wallIso(time.wall)}Z` : new Date(instant(time)).toISOString(); }
/** A DATE or DATE-TIME value with its TZID; an unknown TZID falls back to device-local time instead of failing. */
export function parseIcsTime(value: string, params: Readonly<Record<string, string>> = {}, fallback: Zone = { kind: "local" }): IcsTime | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z?))?$/.exec(value.trim()); if (!match) return null; const [, y = "", mo = "", d = "", hh, mm = "00", ss = "00", utc] = match;
  const format = utc || hh === undefined || !params.TZID ? null : resolveTzid(params.TZID);
  return { wall: { y: Number(y), mo: Number(mo), d: Number(d), h: Number(hh ?? 0), mi: Number(mm), s: Number(ss) }, dateOnly: hh === undefined, zone: utc ? { kind: "utc" } : format ? { kind: "tz", format } : params.TZID ? { kind: "local" } : fallback };
}
function parseDuration(value: string): number | null { const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim()); if (!match) return null; const [, sign, w = "0", d = "0", h = "0", m = "0", s = "0"] = match; return (sign === "-" ? -1 : 1) * (((Number(w) * 7 + Number(d)) * 24 + Number(h)) * 3600 + Number(m) * 60 + Number(s)) * 1000; }
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const daysIn = (y: number, mo: number): number => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const weekdayOf = (ms: number): number => new Date(ms).getUTCDay();
export interface Rule { readonly freq: string; readonly interval: number; readonly count?: number; readonly until?: IcsTime; readonly byday: readonly { readonly n: number; readonly day: number }[]; readonly bymonthday: readonly number[]; readonly bymonth: readonly number[]; readonly wkst: number; }
/** DAILY, WEEKLY, MONTHLY and YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY and BYMONTH; null for rules this app does not expand (BYSETPOS, HOURLY, …), which then show only their first date. */
export function parseRrule(value: string): Rule | null {
  const parts: Record<string, string> = {}; for (const pair of value.split(";")) { const [key = "", part = ""] = pair.split("="); if (key.trim()) parts[key.trim().toUpperCase()] = part.trim().toUpperCase(); }
  const freq = parts.FREQ ?? ""; if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq) || ["BYSETPOS", "BYHOUR", "BYMINUTE", "BYSECOND", "BYWEEKNO", "BYYEARDAY", "RSCALE"].some((key) => key in parts)) return null;
  const list = (key: string): string[] => (parts[key] ?? "").split(",").filter(Boolean);
  const byday = list("BYDAY").map((item) => { const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item); return match ? { n: Number(match[1] ?? 0), day: WEEKDAYS.indexOf(match[2] ?? "") } : null; });
  const bymonthday = list("BYMONTHDAY").map(Number); const bymonth = list("BYMONTH").map(Number); const interval = Number(parts.INTERVAL ?? 1); const count = parts.COUNT === undefined ? undefined : Number(parts.COUNT);
  if (byday.some((item) => item === null) || bymonthday.some((day) => !Number.isInteger(day) || day === 0 || Math.abs(day) > 31) || bymonth.some((month) => !Number.isInteger(month) || month < 1 || month > 12) || !Number.isInteger(interval) || interval < 1 || (count !== undefined && (!Number.isInteger(count) || count < 0))) return null;
  if ((freq === "YEARLY" && byday.length) || (freq === "MONTHLY" && byday.length && bymonthday.length) || (freq !== "MONTHLY" && byday.some((item) => item?.n))) return null;
  const until = parts.UNTIL ? parseIcsTime(parts.UNTIL) : undefined; if (until === null) return null;
  return { freq, interval, ...(count === undefined ? {} : { count }), ...(until ? { until } : {}), byday: byday.flatMap((item) => item ? [item] : []), bymonthday, bymonth, wkst: Math.max(0, WEEKDAYS.indexOf(parts.WKST ?? "MO")) };
}
/** Candidate wall times of one period, in order; a 31st in a short month (or 29 February) is skipped, as RFC 5545 asks. */
function periodWalls(start: Wall, rule: Rule, period: number): Wall[] {
  const at = (y: number, mo: number, d: number): Wall[] => d >= 1 && d <= daysIn(y, mo) ? [{ ...start, y, mo, d }] : [];
  const step = period * rule.interval; const sorted = (days: number[]): number[] => [...new Set(days)].sort((a, b) => a - b); let walls: Wall[];
  if (rule.freq === "DAILY") walls = [toWall(wallMs(start) + step * DAY_MS)].filter((wall) => !rule.byday.length || rule.byday.some((item) => item.day === weekdayOf(wallMs(wall))));
  else if (rule.freq === "WEEKLY") { const weekday = weekdayOf(wallMs(start)); const weekStart = wallMs(start) - ((weekday - rule.wkst + 7) % 7) * DAY_MS + step * 7 * DAY_MS; walls = sorted(rule.byday.length ? rule.byday.map((item) => (item.day - rule.wkst + 7) % 7) : [(weekday - rule.wkst + 7) % 7]).map((offset) => toWall(weekStart + offset * DAY_MS)); }
  else if (rule.freq === "MONTHLY") {
    const index = start.y * 12 + start.mo - 1 + step; const y = Math.floor(index / 12); const mo = (index % 12) + 1; const length = daysIn(y, mo);
    const nth = (item: { readonly n: number; readonly day: number }): number[] => { const all = Array.from({ length: 5 }, (_, week) => (item.day - weekdayOf(Date.UTC(y, mo - 1, 1)) + 7) % 7 + 1 + week * 7).filter((day) => day <= length); if (!item.n) return all; const day = all[item.n > 0 ? item.n - 1 : all.length + item.n]; return day === undefined ? [] : [day]; };
    walls = sorted(rule.bymonthday.length ? rule.bymonthday.map((day) => day < 0 ? length + day + 1 : day) : rule.byday.length ? rule.byday.flatMap(nth) : [start.d]).flatMap((day) => at(y, mo, day));
  } else { const y = start.y + step; walls = sorted(rule.bymonth.length ? [...rule.bymonth] : [start.mo]).flatMap((mo) => sorted((rule.bymonthday.length ? [...rule.bymonthday] : [start.d]).map((day) => day < 0 ? daysIn(y, mo) + day + 1 : day)).flatMap((day) => at(y, mo, day))); }
  return rule.freq !== "YEARLY" && rule.bymonth.length ? walls.filter((wall) => rule.bymonth.includes(wall.mo)) : walls;
}
/** Occurrence starts from DTSTART on, stopping at COUNT, UNTIL (inclusive) or the end of the window, whichever comes first. Walks wall-clock time, so a 09:00 meeting stays 09:00 across DST. */
export function expandRule(start: IcsTime, rule: Rule, endMs: number): IcsTime[] {
  const untilMs = !rule.until ? Infinity : rule.until.zone.kind === "utc" && !rule.until.dateOnly ? instant(rule.until) : instant({ wall: rule.until.dateOnly ? { ...rule.until.wall, h: 23, mi: 59, s: 59 } : rule.until.wall, zone: start.zone, dateOnly: false });
  const startMs = wallMs(start.wall); const out: IcsTime[] = []; let counted = 0;
  for (let period = 0; period < 50_000; period += 1) {
    for (const wall of periodWalls(start.wall, rule, period)) {
      if (wallMs(wall) < startMs) continue; const time: IcsTime = { ...start, wall }; const at = instant(time);
      if (at > untilMs || at >= endMs || (rule.count !== undefined && counted >= rule.count)) return out; counted += 1; out.push(time);
    }
  }
  return out;
}
export interface IcsOptions { readonly now?: Date; readonly days?: number; }
/** Events from the start of today through the window: recurring ones expanded, cancelled ones and EXDATEs dropped, moved instances (RECURRENCE-ID) shown once at their new time. */
export function parseIcs(text: string, options: IcsOptions = {}): AgendaItem[] {
  const events: Record<string, IcsProp[]>[] = []; let block: Record<string, IcsProp[]> | null = null; let depth = 0;
  for (const line of unfoldIcs(text)) {
    if (line === "BEGIN:VEVENT") { block = {}; depth = 0; continue; }
    if (line === "END:VEVENT") { if (block) events.push(block); block = null; continue; }
    if (!block) continue; if (line.startsWith("BEGIN:")) { depth += 1; continue; } if (line.startsWith("END:")) { depth = Math.max(0, depth - 1); continue; } if (depth) continue;
    const prop = splitIcsLine(line); if (prop) (block[prop.name] ??= []).push({ params: prop.params, value: prop.value });
  }
  const today = new Date(options.now ?? Date.now()); today.setHours(0, 0, 0, 0); const fromMs = today.valueOf(); const toMs = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (options.days ?? ICS_WINDOW_DAYS)).valueOf();
  const first = (event: Record<string, IcsProp[]>, key: string): IcsProp | undefined => event[key]?.[0];
  const moved = new Set(events.flatMap((event) => { const id = first(event, "RECURRENCE-ID"); const uid = first(event, "UID")?.value; const time = id ? parseIcsTime(id.value, id.params) : null; return time && uid ? [`${uid}@${instant(time)}`] : []; }));
  const items: AgendaItem[] = [];
  for (const event of events) {
    const summary = first(event, "SUMMARY")?.value; const dtstart = first(event, "DTSTART"); if (!summary || !dtstart?.value || first(event, "STATUS")?.value.trim().toUpperCase() === "CANCELLED") continue;
    const title = unescapeIcsText(summary); const uid = first(event, "UID")?.value; const id = uid ?? `${dtstart.value}-${summary}`; const start = parseIcsTime(dtstart.value, dtstart.params);
    if (!start) { items.push({ id, at: parseIcsDate(dtstart.value), title, kind: "event" }); continue; }
    const dtend = first(event, "DTEND"); const end = dtend ? parseIcsTime(dtend.value, dtend.params, start.zone) : null; const duration = first(event, "DURATION");
    const length = end ? instant(end) - instant(start) : (duration && parseDuration(duration.value)) ?? (start.dateOnly ? DAY_MS : 0);
    const rrule = first(event, "RRULE"); const rule = rrule && !first(event, "RECURRENCE-ID") ? parseRrule(rrule.value) : null;
    const excluded = new Set((event.EXDATE ?? []).flatMap((prop) => prop.value.split(",").flatMap((value) => { const time = parseIcsTime(value, prop.params, start.zone); return time ? [time.dateOnly ? wallIso(time.wall).slice(0, 10) : String(instant(time))] : []; })));
    const starts = rule ? expandRule(start, rule, toMs).filter((time) => !excluded.has(String(instant(time))) && !excluded.has(wallIso(time.wall).slice(0, 10)) && !(uid && moved.has(`${uid}@${instant(time)}`))) : [start];
    for (const time of starts) { const at = instant(time); if (at >= toMs || (at < fromMs && at + Math.max(0, length) <= fromMs)) continue; const iso = atString(time); items.push({ id: rule ? `${id}@${iso}` : id, at: iso, title, kind: "event" }); }
  }
  return items.sort(byTime);
}
/** Keeps a trailing Z: a UTC time read as local time would be off by the zone offset. */
export function parseIcsDate(value: string): string { const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z?))?/.exec(value); if (!match) return value; const [, y, m, d, hh = "00", mm = "00", ss = "00", utc = ""] = match; return `${y}-${m}-${d}T${hh}:${mm}:${ss}${utc}`; }
export function parseBridge(value: unknown): AgendaItem[] { if (!Array.isArray(value)) throw new Error("bridge response must be an array"); return value.flatMap((raw, index) => { const row = (raw ?? {}) as Partial<AgendaItem>; return typeof row.title === "string" && typeof row.at === "string" ? [{ id: typeof row.id === "string" ? row.id : `item-${index}`, at: row.at, title: row.title, kind: row.kind === "reminder" ? "reminder" as const : "event" as const, ...(row.done === true ? { done: true } : {}) }] : []; }).sort(byTime); }
export function demoAgenda(): AgendaItem[] { const base = new Date(); base.setMinutes(0, 0, 0); return [{ id: "1", at: new Date(base.getTime() + 45 * 60_000).toISOString(), title: "Team-Check-in", kind: "event" }, { id: "2", at: new Date(base.getTime() + 120 * 60_000).toISOString(), title: "Angebot senden", kind: "reminder" }, { id: "3", at: new Date(base.getTime() + 210 * 60_000).toISOString(), title: "Zahnarzt", kind: "event" }, { id: "4", at: new Date(base.getTime() + 300 * 60_000).toISOString(), title: "Milch mitnehmen", kind: "reminder" }]; }
/** The time; with `now`, items on another day also get their date, because an imported calendar spans weeks. */
export function when(iso: string, locale = "de-AT", now?: Date): string { const date = new Date(iso); if (Number.isNaN(date.valueOf())) return "--:--"; const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }); return now && date.toDateString() !== now.toDateString() ? `${date.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" })} ${time}` : time; }
/** Flips a reminder's done flag; events and other ids are untouched. */
export function toggleDone(items: readonly AgendaItem[], id: string): AgendaItem[] { return items.map((item) => item.id === id && item.kind === "reminder" ? { ...item, done: !item.done } : item); }
/** Fetches the bridge with a timeout so a hung local server cannot leave a request pending forever. */
export async function fetchBridge(endpoint: string, options: { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch } = {}): Promise<AgendaItem[]> {
  const doFetch = options.fetchImpl ?? fetch; const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try { const response = await doFetch(endpoint, { signal: controller.signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return parseBridge(await response.json()); }
  catch (cause) { if (controller.signal.aborted) throw new Error("timed out"); throw cause; }
  finally { clearTimeout(timeout); }
}
/** Latest wins: each begin() makes every earlier token stale, so a slow bridge answer cannot overwrite a newer import. */
export function latestOnly(): { begin(): () => boolean } { let generation = 0; return { begin() { generation += 1; const mine = generation; return () => mine === generation; } }; }
