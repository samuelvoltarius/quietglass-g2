/**
 * Quiet Hub "Tagesstart": the morning briefing, collected by the daemon.
 *
 * One request (`GET /brief`) answers with everything at a glance: today's
 * calendar (ICS), the weather with a rain nowcast (Open-Meteo), the car (BYD
 * bridge), last night's glucose (sugar bridge / Nightscout read proxy), the
 * printer (Klipper bridge or the daemon's own Moonraker) and the servers
 * (Status Glass reference servers). The glasses never hold a third-party URL
 * or token: everything below runs on the daemon, the answer is plain data.
 *
 * Every block is optional and independent: its own timeout, its own error, and
 * a failing block never hides the others. Results are cached (~2 min); a block
 * that fails after a good answer keeps the last values marked `stale`.
 *
 * The weather follows the wearer: the app sends its position (rounded to ~1 km)
 * as `GET /brief?lat=..&lon=..`; BRIEF_LAT/BRIEF_LON are only the fallback when
 * none comes (weather block `place: "here"|"default"`). Coordinates are never logged.
 *
 * Appointments also come from Shoot Day projects dated today (BRIEF_SHOOT_URL).
 * The weather is then also shown for the PLACE of each of today's appointments
 * (up to 3), at the appointment hour: the place text is geocoded (Open-Meteo
 * geocoding, only the place string is sent, cached 7 days), one forecast per
 * distinct place. An appointment within 10 km of "here" adds no line.
 *
 * Env: BRIEF_ICS_URLS (comma list), BRIEF_SHOOT_URL (+ BRIEF_SHOOT_TOKEN),
 * BRIEF_GEOCODE_URL, BRIEF_LAT, BRIEF_LON (fallback place), BRIEF_TZ,
 * BRIEF_BYD_URL, BRIEF_SUGAR_URL, BRIEF_KLIPPER_URL, BRIEF_STATUS_URLS
 * ("Name|URL,…"), optional bearer tokens BRIEF_BYD_TOKEN, BRIEF_SUGAR_TOKEN,
 * BRIEF_KLIPPER_TOKEN, BRIEF_STATUS_TOKEN, BRIEF_CACHE_MS (default 120000),
 * BRIEF_TIMEOUT_MS (default 6000), BRIEF_WEATHER_URL (Open-Meteo base),
 * BRIEF=off switches the whole page off.
 *
 * Every calendar event with a place that the geocoder finds carries `lat`,
 * `lon` and `placeLabel`; every event carries `startIso` (ISO 8601 with the
 * zone's offset) and `allDay`. `GET /brief/appointments` answers with just
 * `{date, events}` (calendar + geocoding only, no weather; refreshed when older
 * than 2 min) for the navigation app (OpenGlance). Coordinates are never logged.
 *
 * Glucose values are shown for information only, never for therapy decisions.
 */

export const BRIEF_CACHE_MS = 120_000;
export const BRIEF_TIMEOUT_MS = 6_000;
/** A failed block keeps its last good values this long (marked stale). */
const STALE_KEEP_MS = 30 * 60_000;
const MAX_ICS_BYTES = 5 * 1024 * 1024;
const MAX_EVENTS = 12;
const DAY_MS = 86_400_000;
export const SUGAR_LOW = 70;
export const SUGAR_HIGH = 180;
/** A single glucose reading stands for at most this long (sensor gaps are not counted). */
const SUGAR_SLOT_MAX_MS = 15 * 60_000;
/** Rain thresholds: mm per 15 min (minutely_15) and mm per hour (hourly). */
export const RAIN_15_MM = 0.1;
export const RAIN_H_MM = 0.2;

const list = (text) => String(text ?? "").split(",").map((part) => part.trim()).filter(Boolean);
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
const short = (error) => String(error?.message ?? error ?? "error").replace(/https?:\/\/\S+/g, "<url>").slice(0, 80);

/** Zone the day boundaries and times are computed in. */
export function defaultZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

const validZone = (zone) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
};

/** Daemon config from env. URLs and tokens never leave the daemon. */
export function parseBriefConfig(env = {}) {
  const zone = String(env.BRIEF_TZ ?? "").trim();
  const lat = num(env.BRIEF_LAT);
  const lon = num(env.BRIEF_LON);
  const statusUrls = list(env.BRIEF_STATUS_URLS).map((entry, i) => {
    const bar = entry.indexOf("|");
    const name = bar > 0 ? entry.slice(0, bar).trim() : "";
    const url = (bar > 0 ? entry.slice(bar + 1) : entry).trim();
    return { name: name || `#${i + 1}`, url };
  }).filter((entry) => /^https?:\/\//i.test(entry.url));
  return {
    enabled: String(env.BRIEF ?? "on").toLowerCase() !== "off",
    zone: zone !== "" && validZone(zone) ? zone : defaultZone(),
    icsUrls: list(env.BRIEF_ICS_URLS).map((url) => url.replace(/^webcals?:\/\//i, "https://")),
    lat: lat !== null && lat >= -90 && lat <= 90 ? lat : null,
    lon: lon !== null && lon >= -180 && lon <= 180 ? lon : null,
    weatherUrl: String(env.BRIEF_WEATHER_URL ?? "https://api.open-meteo.com/v1/forecast").trim(),
    geocodeUrl: String(env.BRIEF_GEOCODE_URL ?? "").trim() || "https://geocoding-api.open-meteo.com/v1/search",
    shootUrl: /^https?:\/\//i.test(String(env.BRIEF_SHOOT_URL ?? "").trim()) ? String(env.BRIEF_SHOOT_URL).trim().replace(/\/+$/, "") : "",
    shootToken: String(env.BRIEF_SHOOT_TOKEN ?? ""),
    bydUrl: String(env.BRIEF_BYD_URL ?? "").trim(),
    bydToken: String(env.BRIEF_BYD_TOKEN ?? ""),
    sugarUrl: String(env.BRIEF_SUGAR_URL ?? "").trim(),
    sugarToken: String(env.BRIEF_SUGAR_TOKEN ?? ""),
    klipperUrl: String(env.BRIEF_KLIPPER_URL ?? "").trim(),
    klipperToken: String(env.BRIEF_KLIPPER_TOKEN ?? ""),
    statusUrls,
    statusToken: String(env.BRIEF_STATUS_TOKEN ?? ""),
    cacheMs: Math.max(10_000, num(env.BRIEF_CACHE_MS) ?? BRIEF_CACHE_MS),
    timeoutMs: Math.max(1000, num(env.BRIEF_TIMEOUT_MS) ?? BRIEF_TIMEOUT_MS),
  };
}

// ---------------------------------------------------------------- time zones

const formatters = new Map();
function partsFormatter(zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    formatters.set(zone, f);
  }
  return f;
}

/** Wall clock of `ms` in `zone`: {y, m, d, h, mi, s, wd (0 = Sunday)}. */
export function wallIn(ms, zone) {
  const out = {};
  for (const part of partsFormatter(zone).formatToParts(new Date(ms))) out[part.type] = part.value;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(out.weekday);
  return { y: Number(out.year), m: Number(out.month), d: Number(out.day), h: Number(out.hour) % 24, mi: Number(out.minute), s: Number(out.second), wd };
}

function offsetMs(ms, zone) {
  const w = wallIn(ms, zone);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** Epoch ms of a wall-clock time in `zone` (DST gaps resolve forward, overlaps to the first). */
export function zonedToEpoch(y, m, d, h, mi, s, zone) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  if (zone === "UTC") return guess;
  const first = guess - offsetMs(guess, zone);
  return guess - offsetMs(first, zone);
}

const two = (n) => String(n).padStart(2, "0");
/** "14:05" in `zone`. */
export function clockIn(ms, zone) {
  const w = wallIn(ms, zone);
  return `${two(w.h)}:${two(w.mi)}`;
}
/** "2026-10-14T10:30:00+02:00": the instant `ms` as wall clock in `zone` with its offset. */
export function isoIn(ms, zone) {
  const w = wallIn(ms, zone);
  const off = Math.round(offsetMs(ms, zone) / 60_000);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${w.y}-${two(w.m)}-${two(w.d)}T${two(w.h)}:${two(w.mi)}:${two(w.s)}${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}
/** Days since 1970 of a calendar date (no zone involved). */
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const fromDayNum = (n) => { const t = new Date(n * DAY_MS); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() }; };

/** Start and end (epoch ms) of the calendar day containing `ms` in `zone`, plus its date. */
export function dayBounds(ms, zone) {
  const w = wallIn(ms, zone);
  const n = dayNum(w.y, w.m, w.d);
  const next = fromDayNum(n + 1);
  return { start: zonedToEpoch(w.y, w.m, w.d, 0, 0, 0, zone), end: zonedToEpoch(next.y, next.m, next.d, 0, 0, 0, zone), day: n, date: `${w.y}-${two(w.m)}-${two(w.d)}` };
}

// ---------------------------------------------------------------- ICS

/** A few Windows zone names Outlook / Exchange put into TZID. */
const WINDOWS_ZONES = {
  "W. Europe Standard Time": "Europe/Berlin", "Central Europe Standard Time": "Europe/Budapest", "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw", "GMT Standard Time": "Europe/London", "UTC": "UTC", "Coordinated Universal Time": "UTC",
  "E. Europe Standard Time": "Europe/Bucharest", "FLE Standard Time": "Europe/Helsinki", "Eastern Standard Time": "America/New_York", "Pacific Standard Time": "America/Los_Angeles",
};

function resolveZone(tzid, fallback) {
  if (!tzid) return fallback;
  const clean = tzid.replace(/^"|"$/g, "").replace(/^\/[^/]*\/[^/]*\//, "").trim();
  if (WINDOWS_ZONES[clean]) return WINDOWS_ZONES[clean];
  if (validZone(clean)) return clean;
  // "Europe/Vienna" hidden in a longer id ("/mozilla.org/20050126_1/Europe/Vienna").
  const iana = clean.match(/[A-Z][a-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/)?.[0];
  return iana && validZone(iana) ? iana : fallback;
}

/** Unfolded content lines of an ICS text. */
export function unfoldIcs(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n").filter((line) => line.trim() !== "");
}

function parseLine(line) {
  // NAME;PARAM=a;PARAM="b:c":VALUE - the first colon outside quotes ends the parameters.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon).split(";");
  const params = {};
  for (const part of head.slice(1)) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

const unescapeText = (value) => value.replace(/\\[nN]/g, " ").replace(/\\([,;\\])/g, "$1").replace(/\s+/g, " ").trim();

/**
 * One DTSTART/DTEND/EXDATE/RECURRENCE-ID value: all-day {allDay, y, m, d},
 * or timed {y, m, d, h, mi, s, zone} with the zone it is meant in.
 */
export function parseIcsDate(value, params = {}, fallbackZone = "UTC") {
  const text = String(value ?? "").trim();
  const date = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (date || params.VALUE === "DATE") {
    const m = date ?? text.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { allDay: true, y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }
  const dt = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!dt) return null;
  const zone = dt[7] === "Z" ? "UTC" : resolveZone(params.TZID, fallbackZone);
  return { allDay: false, y: Number(dt[1]), m: Number(dt[2]), d: Number(dt[3]), h: Number(dt[4]), mi: Number(dt[5]), s: Number(dt[6] ?? 0), zone };
}

const epochOf = (t) => (t.allDay ? Date.UTC(t.y, t.m - 1, t.d) : zonedToEpoch(t.y, t.m, t.d, t.h, t.mi, t.s, t.zone));

/** ISO 8601 duration (P1D, PT1H30M, P1W) in ms. */
export function parseDuration(text) {
  const m = String(text ?? "").match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 24 * 3600 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function parseRrule(value) {
  const rule = {};
  for (const part of String(value ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  const freq = String(rule.FREQ ?? "").toUpperCase();
  const byday = list(rule.BYDAY).map((d) => d.toUpperCase().slice(-2)).filter((d) => d in WEEKDAYS).map((d) => WEEKDAYS[d]);
  return {
    freq,
    interval: Math.max(1, Math.floor(num(rule.INTERVAL) ?? 1)),
    count: num(rule.COUNT) === null ? null : Math.max(0, Math.floor(num(rule.COUNT))),
    until: rule.UNTIL ? parseIcsDate(rule.UNTIL, {}, "UTC") : null,
    byday,
    // BYDAY with an ordinal ("1MO", "-1FR") or BYMONTHDAY/BYSETPOS are beyond the simple cases.
    complex: /\d/.test(String(rule.BYDAY ?? "")) || rule.BYMONTHDAY !== undefined || rule.BYSETPOS !== undefined || rule.BYMONTH !== undefined || rule.BYWEEKNO !== undefined || rule.BYYEARDAY !== undefined,
    wkst: WEEKDAYS[String(rule.WKST ?? "MO").toUpperCase()] ?? 1,
  };
}

/** VEVENTs of an ICS text (cancelled ones dropped). */
export function parseIcs(text, fallbackZone = "UTC") {
  const events = [];
  let current = null;
  let depth = 0;
  for (const line of unfoldIcs(text)) {
    const prop = parseLine(line);
    if (prop === null) continue;
    if (prop.name === "BEGIN") {
      if (prop.value.toUpperCase() === "VEVENT") { current = { exdates: [] }; depth = 0; }
      else if (current) depth += 1; // VALARM inside an event
      continue;
    }
    if (prop.name === "END") {
      if (prop.value.toUpperCase() === "VEVENT" && current) {
        if (current.start && current.status !== "CANCELLED") events.push(finishEvent(current));
        current = null;
      } else if (current && depth > 0) depth -= 1;
      continue;
    }
    if (!current || depth > 0) continue;
    switch (prop.name) {
      case "UID": current.uid = prop.value.trim(); break;
      case "SUMMARY": current.title = unescapeText(prop.value); break;
      case "LOCATION": current.place = unescapeText(prop.value).trim(); break;
      case "DTSTART": current.start = parseIcsDate(prop.value, prop.params, fallbackZone); break;
      case "DTEND": current.end = parseIcsDate(prop.value, prop.params, fallbackZone); break;
      case "DURATION": current.duration = parseDuration(prop.value); break;
      case "RRULE": current.rrule = parseRrule(prop.value); break;
      case "STATUS": current.status = prop.value.trim().toUpperCase(); break;
      case "RECURRENCE-ID": current.recurrenceId = parseIcsDate(prop.value, prop.params, fallbackZone); break;
      case "EXDATE":
        for (const value of prop.value.split(",")) {
          const ex = parseIcsDate(value, prop.params, fallbackZone);
          if (ex) current.exdates.push(ex);
        }
        break;
      default: break;
    }
  }
  return events;
}

function finishEvent(raw) {
  const start = raw.start;
  let durationMs;
  let days = 0;
  if (start.allDay) {
    const end = raw.end?.allDay ? raw.end : null;
    days = end ? Math.max(1, dayNum(end.y, end.m, end.d) - dayNum(start.y, start.m, start.d)) : raw.duration ? Math.max(1, Math.round(raw.duration / DAY_MS)) : 1;
    durationMs = days * DAY_MS;
  } else {
    const end = raw.end && !raw.end.allDay ? raw.end : null;
    durationMs = end ? Math.max(0, epochOf(end) - epochOf(start)) : Math.max(0, raw.duration ?? 0);
  }
  return {
    uid: raw.uid ?? "",
    title: raw.title || "(ohne Titel)",
    place: raw.place ?? "",
    start,
    days,
    durationMs,
    rrule: raw.rrule ?? null,
    exdates: raw.exdates,
    recurrenceId: raw.recurrenceId ?? null,
  };
}

const weekIndex = (n, wkst) => Math.floor((n - ((wkst + 3) % 7)) / 7); // day 0 (1970-01-01) is a Thursday

/** Is the date `n` (day number in the event's own calendar) an occurrence start of `event`? */
function occursOn(event, n) {
  const s = event.start;
  const first = dayNum(s.y, s.m, s.d);
  if (n < first) return false;
  const rule = event.rrule;
  if (rule === null || rule.complex || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.freq)) return n === first;
  const matches = (k) => {
    if (k < first) return false;
    const date = fromDayNum(k);
    switch (rule.freq) {
      case "DAILY":
        return (k - first) % rule.interval === 0 && (rule.byday.length === 0 || rule.byday.includes(date.wd));
      case "WEEKLY": {
        const days = rule.byday.length > 0 ? rule.byday : [fromDayNum(first).wd];
        return (weekIndex(k, rule.wkst) - weekIndex(first, rule.wkst)) % rule.interval === 0 && days.includes(date.wd);
      }
      case "MONTHLY":
        return date.d === s.d && ((date.y - s.y) * 12 + date.m - s.m) % rule.interval === 0;
      default:
        return date.d === s.d && date.m === s.m && (date.y - s.y) % rule.interval === 0;
    }
  };
  if (!matches(n)) return false;
  if (rule.until !== null) {
    const untilMs = epochOf(rule.until);
    const date = fromDayNum(n);
    const occMs = s.allDay ? Date.UTC(date.y, date.m - 1, date.d) : zonedToEpoch(date.y, date.m, date.d, s.h, s.mi, s.s, s.zone);
    if (occMs > untilMs + (rule.until.allDay ? DAY_MS - 1 : 0)) return false;
  }
  if (rule.count !== null) {
    // Count the occurrences up to n (COUNT keeps this short); give up on absurd ranges.
    let seen = 0;
    for (let k = first; k <= n && k - first < 40_000; k += 1) {
      if (matches(k)) seen += 1;
      if (seen > rule.count) return false;
    }
    if (seen > rule.count) return false;
  }
  return true;
}

const sameStart = (a, b) => (a.allDay || b.allDay ? a.y === b.y && a.m === b.m && a.d === b.d : epochOf(a) === epochOf(b));

/**
 * Today's occurrences of the parsed events in `zone`, sorted: all-day first,
 * then by start time. Each: {title, allDay, startMs, endMs, start, end}
 * where start/end are "HH:MM" ("" when the event began before / ends after today).
 */
export function eventsForDay(events, nowMs, zone) {
  const day = dayBounds(nowMs, zone);
  const overrides = new Map();
  for (const event of events) {
    if (event.recurrenceId && event.uid) {
      const key = event.uid;
      if (!overrides.has(key)) overrides.set(key, []);
      overrides.get(key).push(event.recurrenceId);
    }
  }
  const out = [];
  for (const event of events) {
    const s = event.start;
    const spanDays = s.allDay ? event.days : Math.ceil(event.durationMs / DAY_MS) + 1;
    for (let n = day.day - spanDays - 1; n <= day.day + 1; n += 1) {
      if (!occursOn(event, n)) continue;
      const date = fromDayNum(n);
      const occ = s.allDay ? { allDay: true, y: date.y, m: date.m, d: date.d } : { ...s, y: date.y, m: date.m, d: date.d };
      if (event.rrule !== null && event.exdates.some((ex) => sameStart(ex, occ))) continue;
      // A moved or edited instance replaces the master's occurrence.
      if (event.rrule !== null && event.recurrenceId === null && (overrides.get(event.uid) ?? []).some((rid) => sameStart(rid, occ))) continue;
      if (s.allDay) {
        if (n <= day.day && day.day < n + event.days) out.push({ title: event.title, allDay: true, startMs: day.start, endMs: day.end, start: "", end: "", place: event.place });
        continue;
      }
      const startMs = epochOf(occ);
      const endMs = startMs + event.durationMs;
      const overlaps = event.durationMs === 0 ? startMs >= day.start && startMs < day.end : startMs < day.end && endMs > day.start;
      if (!overlaps) continue;
      out.push({
        title: event.title, place: event.place, allDay: false, startMs, endMs,
        start: startMs < day.start ? "" : clockIn(startMs, zone),
        end: endMs > day.end ? "" : event.durationMs === 0 ? "" : clockIn(endMs, zone),
      });
    }
  }
  const seen = new Set();
  return out
    .filter((e) => { const key = `${e.title}|${e.startMs}|${e.allDay}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => (a.allDay === b.allDay ? a.startMs - b.startMs || a.title.localeCompare(b.title) : a.allDay ? -1 : 1));
}

// ---------------------------------------------------------------- Shoot Day projects

/** "2026-10-14 10:30", "2026-10-14", "14.10.2026 10:30" -> {y, m, d, h, mi} (h/mi null without a time), else null. */
export function parseShootDate(text) {
  const s = String(text ?? "").trim();
  let y; let m; let d; let rest;
  let hit = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T,]+(\d{1,2})[:.](\d{2}))?/);
  if (hit) { [y, m, d] = [+hit[1], +hit[2], +hit[3]]; rest = [hit[4], hit[5]]; } else {
    hit = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T,]+(\d{1,2})[:.](\d{2}))?/);
    if (!hit) return null;
    [d, m, y] = [+hit[1], +hit[2], +hit[3]];
    rest = [hit[4], hit[5]];
  }
  const h = rest[0] === undefined ? null : +rest[0];
  const mi = rest[1] === undefined ? null : +rest[1];
  if (m < 1 || m > 12 || d < 1 || d > 31 || (h !== null && (h > 23 || mi > 59))) return null;
  return { y, m, d, h, mi };
}

/**
 * Today's Shoot Day projects as calendar entries: "<customer> – <project>" with the
 * project's place. `customers` maps id -> name (company wins over the person's name).
 */
export function shootEventsForDay(projects, customers, nowMs, zone) {
  const day = dayBounds(nowMs, zone);
  const today = wallIn(nowMs, zone);
  const names = new Map((Array.isArray(customers) ? customers : []).map((c) => [String(c?.id), String(c?.company || c?.name || "").trim()]));
  const out = [];
  for (const project of Array.isArray(projects) ? projects : []) {
    const when = parseShootDate(project?.date);
    if (when === null || when.y !== today.y || when.m !== today.m || when.d !== today.d) continue;
    const name = String(project?.name ?? "").trim();
    const who = names.get(String(project?.customerId)) ?? "";
    const title = who !== "" && !name.toLowerCase().includes(who.toLowerCase()) ? (name === "" ? who : `${who} – ${name}`) : (name || who || "(ohne Titel)");
    const place = String(project?.place ?? "").trim();
    if (when.h === null) { out.push({ title, place, allDay: true, startMs: day.start, endMs: day.end, start: "", end: "" }); continue; }
    const startMs = zonedToEpoch(when.y, when.m, when.d, when.h, when.mi, 0, zone);
    out.push({ title, place, allDay: false, startMs, endMs: startMs, start: clockIn(startMs, zone), end: "" });
  }
  return out;
}

const words = (text) => String(text).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
function similarTitle(a, b) {
  const wa = words(a); const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return false;
  const ja = wa.join(" "); const jb = wb.join(" ");
  if (ja.includes(jb) || jb.includes(ja)) return true;
  const shared = wa.filter((w) => wb.includes(w)).length;
  return shared / new Set([...wa, ...wb]).size >= 0.5;
}

const sortEvents = (list) => list.sort((a, b) => (a.allDay === b.allDay ? a.startMs - b.startMs || a.title.localeCompare(b.title) : a.allDay ? -1 : 1));

/** ICS events plus Shoot Day ones, sorted; the same slot with a similar title counts once (the place is kept). */
export function mergeEvents(ics, shoot) {
  const out = ics.map((e) => ({ ...e }));
  for (const extra of shoot) {
    const twin = out.find((e) => e.allDay === extra.allDay && (e.allDay || e.startMs === extra.startMs) && similarTitle(e.title, extra.title));
    if (twin) { if (!twin.place && extra.place) twin.place = extra.place; continue; }
    out.push({ ...extra });
  }
  return sortEvents(out);
}

// ---------------------------------------------------------------- geocoding (appointment places)

export const GEOCODE_TTL_MS = 7 * DAY_MS;
const GEOCODE_MISS_MS = 6 * 3_600_000;
const ONLINE_PLACE = /^(https?:|www\.)|zoom|teams|meet\.google|webex|jitsi|^(online|video|telefon|phone|call)\b/i;

/** Search strings to try for a place text: the whole text, the part after the last comma, the town without postcode. */
export function geocodeCandidates(place) {
  const clean = String(place ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (clean === "" || ONLINE_PLACE.test(clean)) return [];
  const parts = clean.split(",").map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? clean;
  const town = last.replace(/^(?:[A-Za-z]{1,2}[- ]?)?\d{4,5}\s+/, "");
  return [...new Set([clean, last, town])].filter((c) => c !== "").slice(0, 3);
}

/** Place text -> {lat, lon, name}; answers are cached 7 days (misses 6 h, network errors not at all). */
export function createGeocoder({ url, fetchImpl, now = () => Date.now(), timeoutMs = BRIEF_TIMEOUT_MS, log = () => {} }) {
  const cache = new Map();
  /** Lookups in flight: the weather and the appointment list ask for the same place at once; one request serves both. */
  const pending = new Map();
  const ask = async (key, candidates) => {
    for (const name of candidates) {
      let body;
      try {
        const query = new URL(url);
        query.searchParams.set("name", name);
        query.searchParams.set("count", "1");
        query.searchParams.set("language", "de");
        query.searchParams.set("format", "json");
        body = await fetchJson(fetchImpl, query.toString(), { timeoutMs });
      } catch (error) {
        log("brief geocode failed:", short(error));
        return null;
      }
      const first = body?.results?.[0];
      const lat = num(first?.latitude);
      const lon = num(first?.longitude);
      if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      const value = { lat, lon, name: String(first?.name ?? name).slice(0, 40) };
      cache.set(key, { value, at: now() });
      return value;
    }
    cache.set(key, { value: null, at: now() });
    return null;
  };
  return {
    size: () => cache.size,
    lookup: async (place) => {
      const candidates = geocodeCandidates(place);
      if (candidates.length === 0) return null;
      const key = candidates[0].toLowerCase();
      const hit = cache.get(key);
      if (hit && now() - hit.at < (hit.value === null ? GEOCODE_MISS_MS : GEOCODE_TTL_MS)) return hit.value;
      let job = pending.get(key);
      if (!job) {
        job = ask(key, candidates).finally(() => pending.delete(key));
        pending.set(key, job);
      }
      return job;
    },
  };
}

/** How long the appointment list waits for the geocoder; a slower answer still fills the cache for the next request. */
export const GEOCODE_WAIT_MS = 3_000;
/** `GET /brief/appointments` answers from a list at most this old. */
export const APPOINTMENTS_FRESH_MS = 120_000;

/**
 * Calendar events for a navigation app: each with `startIso` (offset of `zone`)
 * and `allDay`; those whose place the geocoder finds within `waitMs` also with
 * `lat`, `lon` and `placeLabel`. Never throws: a failed or slow lookup only
 * leaves the coordinates out.
 */
export async function locateEvents(events, zone, lookup, waitMs = GEOCODE_WAIT_MS) {
  const list = Array.isArray(events) ? events : [];
  const found = await Promise.all(list.map(async (event) => {
    if (typeof event?.place !== "string" || event.place.trim() === "") return null;
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); timer.unref?.(); });
    try {
      return await Promise.race([Promise.resolve().then(() => lookup(event.place)).catch(() => null), late]);
    } finally {
      clearTimeout(timer);
    }
  }));
  return list.map((event, i) => {
    const geo = found[i];
    const out = { ...event, allDay: event.allDay === true, startIso: Number.isFinite(event.startMs) ? isoIn(event.startMs, zone) : "" };
    if (geo) Object.assign(out, { lat: geo.lat, lon: geo.lon, placeLabel: geo.name });
    return out;
  });
}

/** One appointment as `GET /brief/appointments` sends it (no internal fields). */
export function appointmentOut(event) {
  const out = {
    time: event.allDay ? "" : String(event.start ?? ""),
    end: String(event.end ?? ""),
    title: String(event.title ?? ""),
    place: String(event.place ?? ""),
    allDay: event.allDay === true,
    startIso: String(event.startIso ?? ""),
  };
  if (typeof event.lat === "number" && typeof event.lon === "number") Object.assign(out, { lat: event.lat, lon: event.lon, placeLabel: String(event.placeLabel ?? "") });
  return out;
}

/** Distance in km (haversine). */
export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Hourly values of an Open-Meteo answer for the hour nearest to `targetMs`, or null. */
export function hourForecast(data, targetMs) {
  const times = data?.hourly?.time;
  if (!Array.isArray(times)) return null;
  const want = Math.round(targetMs / 3_600_000) * 3_600_000;
  const i = times.findIndex((t) => num(t) !== null && num(t) * 1000 === want);
  if (i < 0) return null;
  const at = (key, k = i) => num(data.hourly?.[key]?.[k]);
  const temp = at("temperature_2m");
  if (temp === null) return null;
  // precipitation[i+1] is the rain of the hour that begins at times[i].
  const mm = at("precipitation", i + 1) ?? at("precipitation") ?? 0;
  const wind = at("wind_speed_10m");
  const pop = at("precipitation_probability");
  return { tempC: Math.round(temp), code: at("weather_code"), pop: pop === null ? null : Math.round(pop), mm: Math.round(mm * 10) / 10, windKmh: wind === null ? null : Math.round(wind) };
}

// ---------------------------------------------------------------- weather

/**
 * The place asked for in a request: `{lat, lon}` (rounded to 2 decimals, ~1 km),
 * `null` when none was sent, `"invalid"` for anything that is not a coordinate pair.
 */
export function parsePlace(latRaw, lonRaw) {
  const empty = (v) => v === null || v === undefined || String(v).trim() === "";
  if (empty(latRaw) && empty(lonRaw)) return null;
  if (empty(latRaw) || empty(lonRaw)) return "invalid";
  const lat = num(String(latRaw).trim());
  const lon = num(String(lonRaw).trim());
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return "invalid";
  const r = (v) => Math.round(v * 100) / 100 + 0;
  return { lat: r(lat), lon: r(lon) };
}

/** Open-Meteo request for one place: current, 15-minute and hourly precipitation, today's max/min. */
export function weatherQuery(cfg) {
  const params = new URLSearchParams({
    latitude: String(cfg.lat), longitude: String(cfg.lon),
    current: "temperature_2m,weather_code,precipitation",
    minutely_15: "precipitation",
    hourly: "temperature_2m,weather_code,precipitation,precipitation_probability,wind_speed_10m",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum",
    timezone: cfg.zone, forecast_days: "2", timeformat: "unixtime",
  });
  return `${cfg.weatherUrl.replace(/\?.*$/, "")}?${params}`;
}

/**
 * When it rains from now on: {kind: "now"|"later"|"none", from, until, mm}.
 * Each Open-Meteo value is the sum of the PRECEDING step, so the value at
 * 14:15 is rain between 14:00 and 14:15. 15-minute values are used where
 * they exist, hourly ones after; the look-ahead ends at midnight but covers
 * at least six hours.
 */
export function rainOutlook(data, nowMs, zone) {
  const slots = [];
  const push = (times, values, stepMs, threshold) => {
    if (!Array.isArray(times) || !Array.isArray(values)) return;
    times.forEach((t, i) => {
      const end = num(t) === null ? null : num(t) * 1000;
      const mm = num(values[i]);
      if (end === null || mm === null) return;
      slots.push({ start: end - stepMs, end, mm, wet: mm >= threshold });
    });
  };
  push(data?.minutely_15?.time, data?.minutely_15?.precipitation, 15 * 60_000, RAIN_15_MM);
  const fineEnd = slots.length > 0 ? Math.max(...slots.map((s) => s.end)) : -Infinity;
  const fine = slots.length;
  push(data?.hourly?.time, data?.hourly?.precipitation, 3_600_000, RAIN_H_MM);
  const usable = slots.filter((s, i) => (i < fine ? true : s.start >= fineEnd)).sort((a, b) => a.start - b.start);
  const horizon = Math.max(dayBounds(nowMs, zone).end, nowMs + 6 * 3_600_000);
  const ahead = usable.filter((s) => s.end > nowMs && s.start < horizon);
  if (ahead.length === 0) return { kind: "unknown", from: "", until: "", mm: 0 };
  const firstWet = ahead.findIndex((s) => s.wet);
  if (firstWet < 0) return { kind: "none", from: "", until: "", mm: 0 };
  let last = firstWet;
  let mm = ahead[firstWet].mm;
  while (last + 1 < ahead.length && ahead[last + 1].wet && ahead[last + 1].start <= ahead[last].end) { last += 1; mm += ahead[last].mm; }
  const startMs = ahead[firstWet].start;
  const endMs = ahead[last].end;
  const now = startMs <= nowMs;
  return {
    kind: now ? "now" : "later",
    from: now ? "" : clockIn(startMs, zone),
    until: endMs >= horizon ? "" : clockIn(endMs, zone),
    mm: Math.round(mm * 10) / 10,
  };
}

/** The weather block from an Open-Meteo answer. */
export function shapeWeather(data, nowMs, zone) {
  const round = (v) => (num(v) === null ? null : Math.round(num(v)));
  return {
    status: "ok",
    tempC: round(data?.current?.temperature_2m),
    code: num(data?.current?.weather_code),
    maxC: round(data?.daily?.temperature_2m_max?.[0]),
    minC: round(data?.daily?.temperature_2m_min?.[0]),
    rain: rainOutlook(data, nowMs, zone),
  };
}

// ---------------------------------------------------------------- car (BYD bridge)

/** The car block from the BYD bridge's GET /state. */
export function shapeCar(state) {
  const battery = state?.battery ?? {};
  const charge = state?.charge ?? {};
  const body = state?.body ?? {};
  const locked = body.locked === true ? true : body.locked === false ? false : null;
  return {
    status: "ok",
    soc: num(battery.soc),
    rangeKm: num(battery.range_km),
    charging: charge.active === true,
    chargeDone: charge.done === true,
    etaMin: charge.active === true ? num(charge.eta_min) : null,
    locked,
    mode: typeof state?.mode === "string" ? state.mode : typeof state?.drive?.mode === "string" ? state.drive.mode : null,
  };
}

// ---------------------------------------------------------------- glucose (sugar bridge)

/** Nightscout trend direction -> a stable short code the glasses map to an arrow. */
const DIRECTIONS = new Set(["DoubleUp", "SingleUp", "FortyFiveUp", "Flat", "FortyFiveDown", "SingleDown", "DoubleDown", "NOT COMPUTABLE", "RATE OUT OF RANGE", "NONE"]);
const TREND_NUMBERS = ["NONE", "DoubleUp", "SingleUp", "FortyFiveUp", "Flat", "FortyFiveDown", "SingleDown", "DoubleDown", "NOT COMPUTABLE", "RATE OUT OF RANGE"];

/** SGV entries, oldest first, without duplicates or sensor error codes. */
export function readingsFrom(body) {
  if (!Array.isArray(body)) return [];
  const seen = new Set();
  const out = [];
  for (const item of body) {
    if (item === null || typeof item !== "object") continue;
    if (item.type !== undefined && item.type !== "sgv") continue;
    const mgdl = num(item.sgv);
    const at = num(item.date) ?? (typeof item.dateString === "string" ? Date.parse(item.dateString) : null);
    if (mgdl === null || at === null || !Number.isFinite(at) || mgdl < 20 || mgdl > 600 || seen.has(at)) continue;
    seen.add(at);
    const direction = typeof item.direction === "string" && DIRECTIONS.has(item.direction) ? item.direction : TREND_NUMBERS[num(item.trend) ?? 0] ?? "NONE";
    out.push({ at, mgdl: Math.round(mgdl), direction });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Last night's window: 22:00 the evening before until 07:00 (or now, when it is earlier). */
export function nightWindow(nowMs, zone) {
  const today = dayBounds(nowMs, zone);
  const y = fromDayNum(today.day - 1);
  const t = fromDayNum(today.day);
  const start = zonedToEpoch(y.y, y.m, y.d, 22, 0, 0, zone);
  const end = Math.min(nowMs, zonedToEpoch(t.y, t.m, t.d, 7, 0, 0, zone));
  return { start, end };
}

/**
 * Min/max and minutes below SUGAR_LOW / above SUGAR_HIGH in [start, end).
 * Each reading stands for the time until the next one (at most 15 min, so a
 * sensor gap is not counted as low or high); the last one for 5 min.
 */
export function nightStats(readings, start, end) {
  const inside = readings.filter((r) => r.at >= start && r.at < end).sort((a, b) => a.at - b.at);
  if (inside.length === 0) return null;
  let below = 0;
  let above = 0;
  inside.forEach((r, i) => {
    const next = inside[i + 1]?.at ?? Math.min(end, r.at + 5 * 60_000);
    const span = Math.max(0, Math.min(next - r.at, SUGAR_SLOT_MAX_MS, end - r.at));
    if (r.mgdl < SUGAR_LOW) below += span;
    if (r.mgdl > SUGAR_HIGH) above += span;
  });
  const values = inside.map((r) => r.mgdl);
  return { min: Math.min(...values), max: Math.max(...values), belowMin: Math.round(below / 60_000), aboveMin: Math.round(above / 60_000), count: inside.length };
}

/** Hours of curve the glasses draw (Sugar Glass: CURVE_HOURS). */
export const SUGAR_CURVE_HOURS = 3;

/** The glucose block: current value and trend, last night's statistics, the last 3 h as a curve (oldest first). */
export function shapeSugar(body, nowMs, zone) {
  const readings = readingsFrom(body);
  const latest = readings.at(-1) ?? null;
  const window = nightWindow(nowMs, zone);
  const from = nowMs - SUGAR_CURVE_HOURS * 3_600_000;
  return {
    status: "ok",
    current: latest === null ? null : { mgdl: latest.mgdl, direction: latest.direction, ageMin: Math.max(0, Math.round((nowMs - latest.at) / 60_000)) },
    night: window.end > window.start ? nightStats(readings, window.start, window.end) : null,
    curve: readings.filter((r) => r.at >= from).map((r) => r.mgdl).slice(-60),
    low: SUGAR_LOW,
    high: SUGAR_HIGH,
  };
}

// ---------------------------------------------------------------- printer

const fileName = (path) => String(path ?? "").split("/").pop().replace(/\.gcode$/i, "");

/** The printer block from the Klipper Glance bridge's GET /api/printer. */
export function shapeKlipper(body) {
  const state = String(body?.state ?? "unknown");
  return {
    status: "ok",
    online: body?.online !== false,
    state: ["printing", "paused", "complete", "cancelled", "error", "standby"].includes(state) ? state : "standby",
    file: fileName(body?.file),
    progress: num(body?.progress),
    minutesLeft: num(body?.minutesLeft),
  };
}

/** The printer block from the daemon's Moonraker adapter snapshot. */
export function shapeMoonraker(snapshot) {
  if (snapshot?.offline === true) return { status: "error", error: "offline" };
  const state = snapshot?.state === "printing" || snapshot?.state === "paused" || snapshot?.state === "error" ? snapshot.state : "standby";
  return { status: "ok", online: true, state, file: fileName(snapshot?.job), progress: num(snapshot?.progress), minutesLeft: num(snapshot?.etaMin) };
}

// ---------------------------------------------------------------- servers

/** One Status Glass /status answer -> {ok, newDevices, warn}. */
export function shapeStatus(body) {
  const metrics = Array.isArray(body?.metrics) ? body.metrics : [];
  const warn = metrics.filter((m) => m?.level === "warn" || m?.level === "crit" || m?.status === "warn" || m?.status === "crit").length;
  const fresh = num(body?.network?.new);
  return { ok: true, newDevices: fresh, warn };
}

// ---------------------------------------------------------------- fetching

async function fetchWith(fetchImpl, url, { token = "", timeoutMs, accept = "application/json", maxBytes = 2 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const headers = { Accept: accept };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > maxBytes) throw new Error("too large");
    return text;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const fetchJson = async (fetchImpl, url, opts) => JSON.parse(await fetchWith(fetchImpl, url, opts));
const join = (base, path) => `${base.replace(/\/+$/, "")}${path}`;

/**
 * The briefing: `get()` answers from the cache while it is fresh, else fetches
 * every configured block in parallel (one in flight at a time); `peek()`
 * returns the cache at once and refreshes it in the background when stale.
 */
export function createBrief({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), moon = null, log = () => {}, onChange = () => {} }) {
  const cfg = config;
  let cache = null;
  let cacheKey = "";
  let inflight = null;
  let inflightKey = "";
  /** The place the last request used (background refreshes keep it). */
  let lastPlace = null;
  /** Raw forecast per rounded place: a new place does not refetch what is fresh for another. */
  const weatherCache = new Map();
  const geocoder = createGeocoder({ url: cfg.geocodeUrl, fetchImpl, now, timeoutMs: cfg.timeoutMs, log });
  const APPT_CACHE_MS = Math.max(cfg.cacheMs, 600_000);
  const MAX_APPT_PLACES = 3;
  const NEAR_KM = 10;
  /** One Open-Meteo request per distinct place (rounded to 2 decimals) while the cache is fresh. */
  async function forecast(spot, at, force, ttl) {
    const key = `${spot.lat.toFixed(2)},${spot.lon.toFixed(2)}`;
    const hit = weatherCache.get(key);
    if (!force && hit && at >= hit.at && at - hit.at < ttl) return hit.data;
    const data = await fetchJson(fetchImpl, weatherQuery({ ...cfg, lat: spot.lat, lon: spot.lon }), { timeoutMs: cfg.timeoutMs });
    weatherCache.set(key, { data, at });
    while (weatherCache.size > 12) weatherCache.delete(weatherCache.keys().next().value);
    return data;
  }
  /** Today's appointments that have a place we can find, still ahead (max 3), not within 10 km of `here`. */
  async function appointmentSpots(events, at, here) {
    const day = dayBounds(at, cfg.zone);
    const upcoming = events
      .filter((e) => typeof e.place === "string" && e.place.trim() !== "" && (e.allDay || e.endMs > at - 30 * 60_000 || e.startMs > at - 60 * 60_000))
      .sort((a, b) => (a.allDay ? day.start : a.startMs) - (b.allDay ? day.start : b.startMs));
    const found = await Promise.all(upcoming.slice(0, 6).map(async (event) => ({ event, geo: await geocoder.lookup(event.place) })));
    return found
      .filter(({ geo }) => geo !== null && (here === null || distanceKm(here, geo) >= NEAR_KM))
      .slice(0, MAX_APPT_PLACES);
  }
  /** When someone last asked for the brief itself; /report only keeps it fresh for a while after that. */
  let askedAt = -Infinity;
  const last = {};

  const blocks = {
    calendar: cfg.icsUrls.length === 0 && cfg.shootUrl === "" ? null : async (at, ctx) => {
      const events = [];
      const shoot = [];
      let failed = 0;
      let lastError = "";
      const sources = cfg.icsUrls.length + (cfg.shootUrl === "" ? 0 : 1);
      await Promise.all([
        ...cfg.icsUrls.map(async (url) => {
          try {
            const text = await fetchWith(fetchImpl, url, { timeoutMs: cfg.timeoutMs, accept: "text/calendar", maxBytes: MAX_ICS_BYTES });
            if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("no calendar");
            events.push(...parseIcs(text, cfg.zone));
          } catch (error) { failed += 1; lastError = short(error); }
        }),
        ...(cfg.shootUrl === "" ? [] : [(async () => {
          try {
            const [projects, customers] = await Promise.all([
              fetchJson(fetchImpl, join(cfg.shootUrl, "/api/projects"), { token: cfg.shootToken, timeoutMs: cfg.timeoutMs }),
              // Customer names are a nicety: without them the project name alone is used.
              fetchJson(fetchImpl, join(cfg.shootUrl, "/api/customers"), { token: cfg.shootToken, timeoutMs: cfg.timeoutMs }).catch(() => null),
            ]);
            shoot.push(...shootEventsForDay(projects?.projects, customers?.customers, at, cfg.zone));
          } catch (error) { failed += 1; lastError = short(error); }
        })()]),
      ]);
      if (failed === sources) throw new Error(lastError || "unreachable");
      const today = mergeEvents(eventsForDay(events, at, cfg.zone), shoot);
      ctx.events = today;
      return { status: "ok", events: today.slice(0, MAX_EVENTS), total: today.length, sources, failed };
    },
    weather: async (at, ctx) => {
      const here = ctx.place ?? (cfg.lat === null || cfg.lon === null ? null : { lat: cfg.lat, lon: cfg.lon });
      const spots = await appointmentSpots(ctx.events ?? [], at, here).catch(() => []);
      if (here === null && spots.length === 0) return { status: "off" };
      const day = dayBounds(at, cfg.zone);
      const jobs = [];
      if (here !== null) jobs.push(forecast(here, at, ctx.force, cfg.cacheMs));
      for (const { geo } of spots) jobs.push(forecast(geo, at, ctx.force, APPT_CACHE_MS));
      const settled = await Promise.allSettled(jobs);
      if (settled.every((r) => r.status === "rejected")) throw settled[0].reason;
      const offset = here !== null ? 1 : 0;
      const block = { status: "ok" };
      if (here !== null) {
        if (settled[0].status === "fulfilled") Object.assign(block, shapeWeather(settled[0].value, at, cfg.zone), { place: ctx.place ? "here" : "default" });
        else block.hereFailed = true;
      }
      const appts = [];
      spots.forEach(({ event, geo }, i) => {
        const r = settled[offset + i];
        if (r.status !== "fulfilled") return;
        const target = event.allDay ? Math.max(at, day.start + 9 * 3_600_000) : event.startMs;
        const hour = hourForecast(r.value, target);
        if (hour === null) return;
        appts.push({ time: event.allDay ? "" : event.start, label: geo.name, title: event.title, ...hour });
      });
      block.appts = appts;
      return block;
    },
    car: cfg.bydUrl === "" ? null : async () => shapeCar(await fetchJson(fetchImpl, join(cfg.bydUrl, "/state"), { token: cfg.bydToken, timeoutMs: cfg.timeoutMs })),
    sugar: cfg.sugarUrl === "" ? null : async (at) => {
      // From last night (statistics) or 3 h back (curve), whichever is earlier.
      const since = Math.min(nightWindow(at, cfg.zone).start - 30 * 60_000, at - SUGAR_CURVE_HOURS * 3_600_000);
      const url = join(cfg.sugarUrl, `/api/v1/entries/sgv.json?count=400&find%5Bdate%5D%5B%24gte%5D=${Math.floor(since)}`);
      return shapeSugar(await fetchJson(fetchImpl, url, { token: cfg.sugarToken, timeoutMs: cfg.timeoutMs }), at, cfg.zone);
    },
    printer: cfg.klipperUrl !== ""
      ? async () => shapeKlipper(await fetchJson(fetchImpl, join(cfg.klipperUrl, "/api/printer"), { token: cfg.klipperToken, timeoutMs: cfg.timeoutMs }))
      : moon ? async () => shapeMoonraker(moon.printer()) : null,
    servers: cfg.statusUrls.length === 0 ? null : async () => {
      const machines = await Promise.all(cfg.statusUrls.map(async ({ name, url }) => {
        try {
          const body = await fetchJson(fetchImpl, url, { token: cfg.statusToken, timeoutMs: cfg.timeoutMs });
          return { name: typeof body?.name === "string" && body.name.trim() !== "" && name.startsWith("#") ? body.name.trim().slice(0, 24) : name, ...shapeStatus(body) };
        } catch {
          return { name, ok: false, newDevices: null, warn: 0 };
        }
      }));
      return { status: "ok", machines, down: machines.filter((m) => !m.ok).length, newDevices: machines.reduce((sum, m) => sum + (m.newDevices ?? 0), 0) };
    },
  };

  async function runBlock(name, at, ctx) {
    const run = blocks[name];
    if (run === null || !cfg.enabled) return { status: "off" };
    // A failed weather block keeps the last good values of the SAME place only.
    const lastKey = name === "weather" ? `weather@${keyOf(ctx.place)}` : name;
    try {
      // Every block has its own deadline: a hanging source never holds the others.
      const value = await Promise.race([
        run(at, ctx),
        new Promise((_, reject) => { const t = setTimeout(() => reject(new Error("timeout")), cfg.timeoutMs + 500); t.unref?.(); }),
      ]);
      last[lastKey] = { value, at };
      return value;
    } catch (error) {
      const message = short(error);
      log(`brief ${name} failed:`, message);
      const prev = last[lastKey];
      if (prev && at - prev.at < STALE_KEEP_MS) return { ...prev.value, stale: true, error: message, since: prev.at };
      return { status: "error", error: message };
    }
  }

  /** The calendar block with coordinates on its events (when it has any). */
  const located = async (value) => (Array.isArray(value?.events) ? { ...value, events: await locateEvents(value.events, cfg.zone, geocoder.lookup) } : value);
  /** The appointment list last built (by `appointments()` or a full brief), and the request building one. */
  let appt = null;
  let apptInflight = null;
  const keepAppointments = (at, calendar) => { appt = { at, date: dayBounds(at, cfg.zone).date, calendar }; };
  const appointmentsOf = (entry) => {
    const c = entry.calendar ?? {};
    const out = { date: entry.date, at: entry.at, status: c.status ?? "error", events: Array.isArray(c.events) ? c.events.map(appointmentOut) : [] };
    if (c.stale) out.stale = true;
    return out;
  };

  async function collect(place, force) {
    const at = now();
    const names = Object.keys(blocks);
    const ctx = { place, force };
    // The weather needs the appointment places, so it starts when the calendar is done (each has its own deadline).
    const raw = runBlock("calendar", at, ctx).then((c) => { ctx.events ??= Array.isArray(c?.events) ? c.events : []; return c; });
    // The coordinates join the calendar block; the weather does not wait for them (it shares the geocoder cache).
    const calendar = raw.then(async (c) => {
      const value = await located(c);
      if (blocks.calendar !== null) keepAppointments(at, value);
      return value;
    });
    const values = await Promise.all(names.map((name) => name === "calendar" ? calendar
      : name === "weather" ? raw.then(() => runBlock(name, at, ctx))
        : runBlock(name, at, ctx)));
    const day = dayBounds(at, cfg.zone);
    const brief = { at, date: day.date, zone: cfg.zone, ...Object.fromEntries(names.map((name, i) => [name, values[i]])) };
    cache = brief;
    cacheKey = keyOf(place);
    onChange();
    return brief;
  }

  const keyOf = (place) => (place ? `${place.lat.toFixed(2)},${place.lon.toFixed(2)}` : "default");

  function refresh(place = null, force = false) {
    // One collection at a time; a request for another place waits for it, then runs its own.
    const key = keyOf(place);
    if (inflight !== null && inflightKey === key) return inflight;
    const previous = inflight ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => collect(place, force));
    const tracked = run.finally(() => { if (inflight === tracked) inflight = null; });
    inflight = tracked;
    inflightKey = key;
    return tracked;
  }

  const fresh = (key = cacheKey) => cache !== null && key === cacheKey && now() - cache.at < cfg.cacheMs && dayBounds(cache.at, cfg.zone).date === dayBounds(now(), cfg.zone).date;

  return {
    config: cfg,
    /**
     * force = ignore the cache (a tap on the glasses). place = {lat, lon} from
     * the wearer's phone (null = the daemon's BRIEF_LAT/BRIEF_LON, if set).
     */
    get: async (force = false, place = null) => {
      askedAt = now();
      const spot = place ? { lat: Math.round(place.lat * 100) / 100, lon: Math.round(place.lon * 100) / 100 } : null;
      lastPlace = spot;
      return !force && fresh(keyOf(spot)) ? cache : refresh(spot, force);
    },
    /**
     * Cached brief right now (null before the first one). A stale one is
     * refreshed in the background, but only while the page is in use (asked
     * for in the last 15 min): an open glasses app does not poll the weather
     * service and the bridges all day.
     */
    peek: () => {
      if (cache !== null && !fresh() && now() - askedAt < 15 * 60_000) void refresh(lastPlace).catch(() => {});
      return cache;
    },
    /**
     * Today's appointments only (`GET /brief/appointments`): from the last list
     * when it is younger than APPOINTMENTS_FRESH_MS, else calendar + geocoding
     * anew (no weather, no other block). One request at a time.
     */
    appointments: async () => {
      const at = now();
      const date = dayBounds(at, cfg.zone).date;
      if (blocks.calendar === null || !cfg.enabled) return { date, at, status: "off", events: [] };
      if (appt !== null && appt.date === date && at - appt.at < APPOINTMENTS_FRESH_MS) return appointmentsOf(appt);
      if (apptInflight === null) {
        apptInflight = (async () => {
          const value = await located(await runBlock("calendar", at, { place: null, force: false }));
          keepAppointments(at, value);
          return appointmentsOf(appt);
        })().finally(() => { apptInflight = null; });
      }
      return apptInflight;
    },
    configured: () => Object.entries(blocks).filter(([name, run]) => run !== null && (name !== "weather" || (cfg.lat !== null && cfg.lon !== null) || blocks.calendar !== null)).map(([name]) => name),
  };
}
