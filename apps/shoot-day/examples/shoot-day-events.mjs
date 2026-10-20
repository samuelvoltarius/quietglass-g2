/**
 * Appointments (Termine) for the Work Dashboard: understanding a typed entry
 * ("Dreh bei Musterwirt nächsten Donnerstag 9–12 Uhr") and checking dates the local
 * model proposes.
 *
 * Everything about calendar arithmetic is deterministic code, never the model:
 *   - relative dates ("heute", "morgen", "übermorgen", "in 2 Wochen", "nächsten
 *     Donnerstag", "übernächsten Freitag", "Donnerstag nächste Woche") and written
 *     dates ("23.10.", "23.10.2026", "2026-10-23", "23. Oktober") are computed here;
 *   - a date the model names must fall on the weekday the text names, else it is
 *     corrected (or emptied when the text itself contradicts itself);
 *   - times are checked (HH:MM, end after start, else the end is emptied);
 *   - the project must be one of the candidates;
 *   - closing days in the customer's notes ("Ruhetag Mo/Di") become hints.
 *
 * Without a model (or when it fails) a plain rule parser does the same from the
 * words alone. parseEvent() never throws.
 *
 * Customer material never leaves the house – only the configured local model is asked.
 * Dependency-free (Node 18+).
 */
import { chatUrl } from "./shoot-day-pdf.mjs";

export const DEFAULT_TZ = "Europe/Vienna";
export const WEEKDAYS = Object.freeze(["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"]);
const SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const MONTHS = [
  ["jänner", "januar", "jän", "jan"], ["februar", "feber", "feb"], ["märz", "maerz", "mär", "mrz"], ["april", "apr"], ["mai"], ["juni", "jun"],
  ["juli", "jul"], ["august", "aug"], ["september", "sept", "sep"], ["oktober", "okt"], ["november", "nov"], ["dezember", "dez"],
];
const NUMBER_WORDS = { ein: 1, eine: 1, einer: 1, einem: 1, einen: 1, eins: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12 };
const MAX_HINTS = 5;

const pad = (n) => String(n).padStart(2, "0");
const line = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
};
const norm = (text) => String(text ?? "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// ---------------------------------------------------------------------------
// Calendar arithmetic on "YYYY-MM-DD" (UTC dates, no time zone drift).
// ---------------------------------------------------------------------------
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar date "YYYY-MM-DD" → itself, else "". */
export function validIso(text) {
  const m = ISO.exec(String(text ?? "").trim());
  if (!m) return "";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? m[0] : "";
}
const toMs = (iso) => Date.parse(iso + "T00:00:00Z");
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso, n) => fromMs(toMs(iso) + n * 86_400_000);
/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (iso) => new Date(toMs(iso)).getUTCDay();
export const weekdayName = (iso) => WEEKDAYS[weekdayOf(iso)];
/** The next date with weekday `wd`: strictly after `iso`, or on it with `orSame`. */
export function nextWeekday(iso, wd, orSame = false) {
  const diff = (wd - weekdayOf(iso) + 7) % 7;
  return addDays(iso, diff === 0 && !orSame ? 7 : diff);
}
/** "23.10." → "23.10.2026" style short label. */
export const germanDate = (iso) => { const m = ISO.exec(iso); return m ? `${m[3]}.${m[2]}.${m[1]}` : ""; };

/** Today as "YYYY-MM-DD" in a time zone (an unknown zone falls back to DEFAULT_TZ). */
export function todayIn(tz = DEFAULT_TZ, now = new Date()) {
  const zone = validZone(tz);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function validZone(tz) {
  const zone = String(tz ?? "").trim();
  if (!zone) return DEFAULT_TZ;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return zone; } catch { return DEFAULT_TZ; }
}
/** `today` as given ("YYYY-MM-DD" or a Date) → "YYYY-MM-DD". */
export function isoToday(today, tz = DEFAULT_TZ) {
  if (today instanceof Date && !Number.isNaN(today.getTime())) return todayIn(tz, today);
  return validIso(today) || todayIn(tz);
}

// ---------------------------------------------------------------------------
// Weekdays in text.
// ---------------------------------------------------------------------------
const FULL_DAY = /\b(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend)(?:s|e|en)?\b/gi;
const dayIndex = (word) => {
  const w = word.toLowerCase();
  if (w.startsWith("sonnabend")) return 6;
  return WEEKDAYS.findIndex((d) => w.startsWith(d.toLowerCase()));
};

/** Every weekday named in full ("Donnerstag", "donnerstags", "Donnerstage"), in order of appearance. */
export function weekdaysIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(FULL_DAY)) { const i = dayIndex(m[1]); if (i >= 0 && !out.includes(i)) out.push(i); }
  return out;
}

/**
 * Closing days from a customer's notes: "Ruhetag Mo/Di", "Mo–Mi geschlossen",
 * "montags und dienstags Ruhetag", "Ruhetage: Montag, Dienstag".
 * @returns {{ days: number[], label: string }}
 */
export function closedDays(notes) {
  const days = new Set();
  // commas too: "Mi-So 8:30-17:00, Mo+Di Ruhetag" – the opening hours are not closing days
  const clauses = String(notes ?? "").split(/[\n;,]|(?<=[a-zäöüß]{3})\.\s+/i);
  for (const clause of clauses) {
    if (!/ruhetag|geschlossen|zugesperrt|kein betrieb|\bzu\b/i.test(clause)) continue;
    if (/\b\d{1,2}[:.]\d{2}\b/.test(clause)) continue;   // a time of day: opening hours, not a closing day
    // abbreviations: Mo Di Mi Do Fr Sa always (capitalised, whole word); "So" only next to another day sign
    const tokens = [];
    const re = /\b(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend)(?:s|e|en)?\b|\b(Mo|Di|Mi|Do|Fr|Sa|So)\b\.?|(\s*(?:[-–]|bis)\s*)/gi;
    for (const m of clause.matchAll(re)) {
      if (m[1]) tokens.push({ day: dayIndex(m[1]) });
      else if (m[2]) {
        if (!/^[A-Z][a-z]$/.test(m[2])) continue;   // lower-case "so", "do" are words, not days
        const i = SHORT.indexOf(m[2]);
        if (m[2] === "So") {
          const around = clause.slice(Math.max(0, m.index - 2), m.index + m[0].length + 2);
          if (!/[/,–-]|\.\s*$/.test(around) && !/^So\./.test(m[0])) continue;
        }
        tokens.push({ day: i });
      } else if (m[3]) tokens.push({ range: true });
    }
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.range || t.day === undefined) continue;
      if (tokens[k + 1]?.range && tokens[k + 2]?.day !== undefined) {
        // Mo–Mi → Mo, Di, Mi (monday-based week)
        let d = t.day;
        const end = tokens[k + 2].day;
        for (let guard = 0; guard < 7; guard++) { days.add(d); if (d === end) break; d = (d + 1) % 7; }
        k += 2;
      } else days.add(t.day);
    }
  }
  const sorted = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return { days: sorted, label: sorted.map((d) => SHORT[d]).join("/") };
}

// ---------------------------------------------------------------------------
// Dates and times from words.
// ---------------------------------------------------------------------------
const MONTH_RE = MONTHS.flat().sort((a, b) => b.length - a.length).join("|");
const DATE_PATTERNS = [
  /\b(\d{4})-(\d{2})-(\d{2})\b/g,                                         // 2026-10-23
  /\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2}(?!\d))?/g,                       // 23.10. / 23.10.2026 / 23.10.26
  new RegExp("\\b(\\d{1,2})\\.?\\s*(" + MONTH_RE + ")\\.?(?:\\s+(\\d{4}))?\\b", "gi"),   // 23. Oktober (2026)
];

/** Written dates in the text: [{ iso, index, length }]; a date without a year is the next one from today. */
function writtenDates(text, today) {
  const out = [];
  const year = Number(today.slice(0, 4));
  const push = (y, mo, d, m, explicitYear) => {
    let iso = validIso(`${y}-${pad(mo)}-${pad(d)}`);
    if (iso && !explicitYear && iso < today) iso = validIso(`${y + 1}-${pad(mo)}-${pad(d)}`);
    if (iso) out.push({ iso, index: m.index, length: m[0].length });
  };
  for (const m of text.matchAll(DATE_PATTERNS[0])) push(Number(m[1]), Number(m[2]), Number(m[3]), m, true);
  for (const m of text.matchAll(DATE_PATTERNS[1])) {
    if (out.some((o) => m.index >= o.index && m.index < o.index + o.length)) continue;
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : year;
    push(y, Number(m[2]), Number(m[1]), m, Boolean(m[3]));
  }
  for (const m of text.matchAll(DATE_PATTERNS[2])) {
    const mo = MONTHS.findIndex((names) => names.includes(m[2].toLowerCase())) + 1;
    if (mo > 0) push(m[3] ? Number(m[3]) : year, mo, Number(m[1]), m, Boolean(m[3]));
  }
  return out.sort((a, b) => a.index - b.index);
}

const numberOf = (word) => (/^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word.toLowerCase()] ?? NaN);

/**
 * The date a text names, computed from `today` ("YYYY-MM-DD"). Never asks a model.
 * @returns {{ date: string, kind: "written"|"relative"|"weekday"|"", weekday: number, conflict: string }}
 *   weekday: the weekday the text names (-1 none); conflict: a hint when the text contradicts itself (date then "")
 */
export function resolveDate(text, today) {
  const s = String(text ?? "");
  const named = weekdaysIn(s);
  const abbrev = /\b(Mo|Di|Mi|Do|Fr|Sa|So)\.?,?\s+\d{1,2}\./.exec(s);
  const weekday = named.length ? named[0] : abbrev ? SHORT.indexOf(abbrev[1]) : -1;
  const result = (date, kind) => ({ date, kind, weekday, conflict: "" });

  const written = writtenDates(s, today);
  if (written.length) {
    const date = written[0].iso;
    if (weekday >= 0 && weekdayOf(date) !== weekday) {
      return { date: "", kind: "written", weekday, conflict: germanDate(date) + " ist ein " + weekdayName(date) + ", kein " + WEEKDAYS[weekday] + " – bitte Datum prüfen" };
    }
    return result(date, "written");
  }
  const low = s.toLowerCase();
  // (?<!\p{L}) instead of \b: \b does not see "ü" as a letter
  if (/(?<!\p{L})übermorgen\b/u.test(low)) return result(addDays(today, 2), "relative");
  // "morgen" = tomorrow ("morgens" is not matched; "heute morgen" is this morning)
  if (/\bmorgen\b/.test(low) && !/\b(heute|gestern)\s+morgen\b/.test(low)) return result(addDays(today, 1), "relative");
  if (/\bheute\b/.test(low)) return result(today, "relative");
  let m = /\bin\s+(\d+|eine[mnr]?|ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s+(tag(?:e|en)?|woche(?:n)?|monat(?:e|en)?)\b/i.exec(s);
  if (m) {
    const n = numberOf(m[1]);
    if (Number.isFinite(n) && n > 0 && n < 400) {
      const unit = m[2].toLowerCase();
      if (unit.startsWith("tag")) return result(addDays(today, n), "relative");
      if (unit.startsWith("woche")) return result(addDays(today, 7 * n), "relative");
      const [y, mo, d] = today.split("-").map(Number);
      const total = mo - 1 + n;
      const ty = y + Math.floor(total / 12); const tm = total % 12 + 1;
      const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
      return result(`${ty}-${pad(tm)}-${pad(Math.min(d, last))}`, "relative");
    }
  }
  if (weekday >= 0) {
    const nextWeek = /\b(nächste[nr]?|kommende[nr]?)\s+woche\b/i.test(s);
    if (nextWeek) {
      // the weekday in the next calendar week (weeks start on Monday)
      const monday = addDays(today, 7 - ((weekdayOf(today) + 6) % 7));
      return result(addDays(monday, (weekday + 6) % 7), "weekday");
    }
    const first = nextWeekday(today, weekday);
    if (/(?<!\p{L})übernächste[nrm]?\s+(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag)/iu.test(s)) return result(addDays(first, 7), "weekday");
    if (/\b(diese[nrm]?|heute)\s+(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag)/i.test(s)) return result(nextWeekday(today, weekday, true), "weekday");
    return result(first, "weekday");
  }
  return { date: "", kind: "", weekday, conflict: "" };
}

/** Text without its written dates (so "23.10." is never read as a time). */
const withoutDates = (text, today) => {
  let s = String(text ?? "");
  for (const d of writtenDates(s, today).reverse()) s = s.slice(0, d.index) + " ".repeat(d.length) + s.slice(d.index + d.length);
  return s;
};
const hhmm = (h, m) => {
  const hh = Number(h); const mm = m === undefined || m === "" ? 0 : Number(m);
  return Number.isInteger(hh) && Number.isInteger(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 ? `${pad(hh)}:${pad(mm)}` : "";
};
/** "9", "09:00", "9.30" → "HH:MM", else "". */
export function cleanTime(value) {
  const m = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:uhr)?\s*$/i.exec(String(value ?? ""));
  return m ? hhmm(m[1], m[2]) : "";
}

/** Times in the text: "von 9 bis 12 Uhr", "9–12 Uhr", "14:30–16:00", "um 14.30", "ab 9 Uhr". end "" when not after start. */
export function resolveTimes(text, today = "2000-01-01") {
  const s = withoutDates(text, today);
  const range = /(?:\bvon\s+)?\b(\d{1,2})(?:[:.](\d{2}))?\s*(?:uhr)?\s*(?:-|–|bis)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(uhr)?/gi;
  for (const m of s.matchAll(range)) {
    if (!/[:.]|uhr|von|bis/i.test(m[0])) continue;   // "2-3 Wochen" is no time
    const start = hhmm(m[1], m[2]); const end = hhmm(m[3], m[4]);
    if (!start) continue;
    return { start, end: end && end > start ? end : "" };
  }
  const single = /\b(?:um|ab|gegen)?\s*(\d{1,2})(?:[:.](\d{2}))\s*(?:uhr)?|\b(\d{1,2})\s*uhr\b/gi;
  for (const m of s.matchAll(single)) {
    const start = m[3] !== undefined ? hhmm(m[3]) : hhmm(m[1], m[2]);
    if (start) return { start, end: "" };
  }
  return { start: "", end: "" };
}

// ---------------------------------------------------------------------------
// Candidates (customers/projects) and hints.
// ---------------------------------------------------------------------------
/**
 * @typedef {{ wdProjectId: number|string|null, customer: string, project: string, notes?: string, location?: string, date?: string }} Candidate
 */
const STOP = new Set(["gmbh", "og", "kg", "co", "und", "der", "die", "das", "café", "cafe", "gasthof", "gasthaus", "hotel", "restaurant", "bar", "studio", "firma", "familie", "herr", "frau"]);
const words = (text) => norm(text).split(" ").filter((w) => w.length >= 3 && !STOP.has(w));

/** How well a candidate fits the text: the whole name counts most, a distinctive word of it less. */
function score(candidate, text) {
  const t = " " + norm(text) + " ";
  let n = 0;
  const project = norm(candidate.project); const customer = norm(candidate.customer);
  if (project && t.includes(" " + project + " ")) n += 6;
  else if (words(candidate.project).some((w) => w.length >= 4 && t.includes(" " + w + " "))) n += 2;
  if (customer && t.includes(" " + customer + " ")) n += 5;
  else if (words(candidate.customer).some((w) => w.length >= 4 && t.includes(" " + w + " "))) n += 3;
  return n;
}

/** The candidate a text means, by names; null when none or when it is not clear. */
export function matchCandidate(text, candidates = []) {
  const scored = candidates.map((c) => ({ c, n: score(c, text) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  if (!scored.length) return { candidate: null, ambiguous: [] };
  const top = scored.filter((x) => x.n === scored[0].n);
  if (top.length === 1) return { candidate: top[0].c, ambiguous: [] };
  return { candidate: null, ambiguous: top.map((x) => x.c) };
}

const asProjectId = (id) => {
  if (id === null || id === undefined || id === "") return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
};

/** Hints from the customer's notes and the project material that speak for or against the date. */
export function eventHints(candidate, date, candidates = []) {
  const out = [];
  if (!candidate) return out;
  const closed = closedDays(candidate.notes);
  if (closed.days.length) {
    const who = line(candidate.customer, 60) || "Der Kunde";
    if (!date) out.push(who + " hat " + closed.label + " Ruhetag");
    else if (closed.days.includes(weekdayOf(date))) out.push(who + " hat " + closed.label + " Ruhetag – " + weekdayName(date) + " fällt auf einen Ruhetag");
    else out.push(who + " hat " + closed.label + " Ruhetag – " + weekdayName(date) + " passt");
  }
  if (date) {
    for (const c of candidates) {
      const when = /^(\d{4}-\d{2}-\d{2})/.exec(String(c.date ?? ""))?.[1] ?? "";
      if (when === date) out.push("Am " + germanDate(date) + " ist schon „" + line(c.project, 60) + "“ (" + line(c.customer, 60) + ") eingetragen");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The proposal: rules, the model's answer checked by the same rules.
// ---------------------------------------------------------------------------
/** A title from the words of the entry: dates, times and filler removed. */
function ruleTitle(text, today) {
  let s = withoutDates(text, today)
    .replace(/(?:\bvon\s+)?\b\d{1,2}(?:[:.]\d{2})?\s*(?:uhr)?\s*(?:-|–|bis)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:uhr)?/gi, " ")
    .replace(/\b(?:um|ab|gegen)\s+\d{1,2}(?:[:.]\d{2})?\s*(?:uhr)?/gi, " ")
    .replace(/\b\d{1,2}(?:[:.]\d{2})\s*(?:uhr)?|\b\d{1,2}\s*uhr\b/gi, " ")
    .replace(/\b(?:am|im|in)\s+(?=\s|$)/gi, " ")
    .replace(/(?<!\p{L})(?:übermorgen|morgen|heute)\b/giu, " ")
    .replace(/\bin\s+(?:\d+|eine[mnr]?|ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s+(?:tag(?:e|en)?|woche(?:n)?|monat(?:e|en)?)\b/gi, " ")
    .replace(/(?<!\p{L})(?:nächste[nrm]?|kommende[nrm]?|übernächste[nrm]?|diese[nrm]?)\s+woche\b/giu, " ")
    .replace(/(?<!\p{L})(?:am\s+)?(?:nächste[nrm]?|kommende[nrm]?|übernächste[nrm]?|diese[nrm]?)?\s*(?:sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag)\b/giu, " ")
    .replace(/\s+[,–-]\s*$/, "").replace(/\s+/g, " ").trim()
    .replace(/^[,.:;–-]+\s*|\s*[,.:;–-]+$/g, "");
  s = line(s, 120);
  return s ? s[0].toUpperCase() + s.slice(1) : "Termin";
}

/**
 * The checked proposal from the entry and (optionally) the model's raw answer.
 * The words decide date and times when they are clear; the model fills gaps
 * (title, place, a date the rules cannot read) and is corrected where it disagrees.
 */
export function checkProposal(raw, { text, today, candidates = [] }) {
  const hints = [];
  const model = raw && typeof raw === "object" ? raw : null;

  // project: only one of the candidates
  let candidate = null;
  let onlyCustomer = "";
  if (model) {
    const wanted = model.wdProjectId ?? model.projectId ?? null;
    if (wanted !== null && wanted !== undefined && wanted !== "") candidate = candidates.find((c) => c.wdProjectId !== null && String(c.wdProjectId) === String(wanted)) ?? null;
    if (!candidate && (model.project || model.customer)) {
      const lower = (v) => norm(v);
      candidate = candidates.find((c) => lower(c.project) === lower(model.project) && (!model.customer || lower(c.customer) === lower(model.customer)))
        ?? null;
    }
  }
  if (!candidate) {
    const { candidate: hit, ambiguous } = matchCandidate(text, candidates);
    candidate = hit;
    if (!hit && ambiguous.length) {
      const customers = [...new Set(ambiguous.map((c) => c.customer))];
      if (customers.length === 1) onlyCustomer = customers[0];
      hints.push(customers.length === 1
        ? line(customers[0], 60) + " hat mehrere Projekte – bitte eins wählen"
        : "Mehrere Kunden passen (" + customers.slice(0, 3).map((c) => line(c, 40)).join(", ") + ") – bitte wählen");
    }
  }

  // date: the words first, the model only where the words say nothing
  const words = resolveDate(text, today);
  let date = "";
  if (words.conflict) hints.push(words.conflict);
  else if (words.date) {
    date = words.date;
    const said = validIso(model?.date);
    if (said && said !== date) hints.push("Datum nachgerechnet: " + WEEKDAYS[weekdayOf(date)] + ", " + germanDate(date));
  } else {
    date = validIso(model?.date);
    if (date && words.weekday >= 0 && weekdayOf(date) !== words.weekday) {
      const fixed = nextWeekday(addDays(date, -1), words.weekday);
      hints.push(germanDate(date) + " ist kein " + WEEKDAYS[words.weekday] + " – korrigiert auf " + germanDate(fixed));
      date = fixed;
    }
  }
  if (date && date < today) hints.push("Das Datum liegt in der Vergangenheit");

  // times: the words first
  const said = resolveTimes(text, today);
  let start = said.start; let end = said.end;
  if (!start) {
    start = cleanTime(model?.start);
    end = cleanTime(model?.end);
  } else if (!end && cleanTime(model?.start) === start) {
    end = cleanTime(model?.end);   // the model may know the end when it agrees on the start
  }
  if (!start) end = "";
  if (end && end <= start) end = "";

  const title = line(model?.title, 120) || ruleTitle(text, today);
  const location = line(model?.location, 160) || line(candidate?.location, 160);
  for (const h of eventHints(candidate, date, candidates)) hints.push(h);
  for (const h of Array.isArray(model?.hints) ? model.hints : []) {
    const clean = line(h, 200);
    if (clean && !/[{}<>]/.test(clean) && !hints.includes(clean)) hints.push(clean);
  }
  return {
    title,
    wdProjectId: asProjectId(candidate?.wdProjectId),
    customer: line(candidate ? candidate.customer : onlyCustomer, 120),
    project: candidate ? line(candidate.project, 120) : "",
    date,
    start,
    end,
    location,
    hints: hints.slice(0, MAX_HINTS),
  };
}

/** The prompt for one entry. */
export function parseMessages({ text, today, tz = DEFAULT_TZ, candidates = [] }) {
  const system = "Du liest eine kurze Termin-Eingabe einer Filmproduktion und machst daraus einen Termin. Antworte NUR mit JSON, ohne Erklärung: "
    + "{\"title\":\"kurzer Titel\",\"wdProjectId\":<id>|null,\"date\":\"YYYY-MM-DD\"|\"\",\"start\":\"HH:MM\"|\"\",\"end\":\"HH:MM\"|\"\",\"location\":\"\",\"hints\":[\"…\"]}. "
    + "Heute ist " + weekdayName(today) + ", " + today + " (Zeitzone " + tz + "). Rechne relative Angaben (morgen, nächsten Donnerstag, in 2 Wochen) von heute aus; "
    + "der Wochentag des Datums muss zum Text passen. Datum ohne Uhrzeit = ganztägig (start und end leer). "
    + "wdProjectId nur aus der Kandidatenliste, sonst null; erfinde nichts. location nur, wenn der Text oder das Projekt einen Ort nennt. "
    + "hints = kurze Hinweise aus den Kundennotizen oder dem Projekt, die für oder gegen das Datum sprechen (z. B. Ruhetage), sonst [].";
  const list = candidates.slice(0, 80).map((c) => "- wdProjectId: " + (c.wdProjectId ?? "null") + " | Kunde: " + line(c.customer, 80) + " | Projekt: " + line(c.project, 80)
    + (c.location ? " | Ort: " + line(c.location, 100) : "") + (c.date ? " | Drehtermin: " + line(c.date, 40) : "")
    + (c.notes ? " | Kundennotizen: " + line(c.notes, 400) : "")).join("\n");
  const user = "Eingabe: " + line(text, 1000) + "\n\nKandidaten:\n" + (list || "(keine)");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function jsonObject(content) {
  const text = String(content ?? "").replace(/```(?:json)?/gi, "").trim();
  const from = text.indexOf("{"); const to = text.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  try { const value = JSON.parse(text.slice(from, to + 1)); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
}

/**
 * POST /api/events/parse. `llm`: { url, model?, token?, timeoutMs?, fetchImpl? } or null (rules only).
 * @returns {Promise<{ ok: true, proposal: object, source: "model"|"rules" }>} never rejects
 */
export async function parseEvent({ text, today, tz, candidates = [] }, llm = null) {
  const zone = validZone(tz);
  const day = isoToday(today, zone);
  const entry = line(text, 1000);
  const list = Array.isArray(candidates) ? candidates : [];
  const ctx = { text: entry, today: day, candidates: list };
  if (llm?.url) {
    try {
      const endpoint = chatUrl(llm.url);
      const response = await (llm.fetchImpl ?? fetch)(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(llm.token ? { Authorization: "Bearer " + llm.token } : {}) },
        body: JSON.stringify({
          ...(llm.model ? { model: llm.model } : {}), messages: parseMessages({ text: entry, today: day, tz: zone, candidates: list }),
          temperature: 0.1, max_tokens: 600, stream: false, chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(Math.min(Number(llm.timeoutMs) || 60_000, 120_000)),
      });
      if (!response.ok) throw new Error("http " + response.status);
      const reply = await response.json();
      const raw = jsonObject(reply?.choices?.[0]?.message?.content);
      if (!raw) throw new Error("unreadable");
      return { ok: true, proposal: checkProposal(raw, ctx), source: "model" };
    } catch {
      const proposal = checkProposal(null, ctx);
      proposal.hints = ["Sprachmodell nicht erreichbar – einfache Erkennung", ...proposal.hints].slice(0, MAX_HINTS);
      return { ok: true, proposal, source: "rules" };
    }
  }
  return { ok: true, proposal: checkProposal(null, ctx), source: "rules" };
}

// ---------------------------------------------------------------------------
// Appointments the project understanding proposes (shoot-day-brain.mjs).
// ---------------------------------------------------------------------------
/** Words in the material that ask for appointments ("Terminvorschläge Drehtage binnen 48 h"). */
const ASKS_FOR_DATES = /terminvorschl[äa]g|termin(?:e)?\s+(?:vor)?schlag|termine?\s+(?:vorschlagen|anbieten|nennen|finden|ausmachen|vereinbaren|abstimmen)|(?:dreh)?tage?\s+vorschlagen|vorschl[äa]ge?\s+f[üu]r\s+(?:den\s+|die\s+|einen\s+)?(?:dreh)?(?:termin|tag)/i;

/** The part of the material that asks for appointments ("" = none) – a few words around it. */
export function dateRequest(text) {
  const s = String(text ?? "");
  const m = ASKS_FOR_DATES.exec(s);
  return m ? s.slice(Math.max(0, m.index - 80), m.index + m[0].length + 120) : "";
}

/**
 * The model's `termine` → checked proposals (max 3). Only when the material asks for
 * appointments; never in the past; a weekday the request or the proposal names is
 * enforced (moved forward to it); a customer's closing day drops the proposal.
 * @param {unknown} raw
 * @param {{ material: string, notes?: string, today: string, resolve?: (q: string) => string }} ctx
 */
export function cleanEventProposals(raw, { material, notes = "", today, resolve = () => "" }) {
  const request = dateRequest(material);
  if (!request || !Array.isArray(raw)) return [];
  const wanted = weekdaysIn(request);
  const closed = closedDays(notes).days;
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= 3) break;
    if (!item || typeof item !== "object") continue;
    const titel = line(item.titel ?? item.title, 120);
    if (!titel) continue;
    const grund = line(item.grund, 300);
    let datum = validIso(item.datum ?? item.date);
    if (datum) {
      const own = weekdaysIn(titel + " " + grund);
      const allowed = own.length ? own : wanted;
      if (allowed.length && !allowed.includes(weekdayOf(datum))) {
        // move forward to the next allowed weekday
        let d = datum;
        for (let i = 0; i < 7 && !allowed.includes(weekdayOf(d)); i++) d = addDays(d, 1);
        datum = d;
      }
      if (datum < today) continue;
      if (closed.includes(weekdayOf(datum))) continue;
    }
    let von = cleanTime(item.von ?? item.start);
    let bis = cleanTime(item.bis ?? item.end);
    if (!von) bis = "";
    if (bis && bis <= von) bis = "";
    const key = norm(titel) + "|" + datum;
    if (seen.has(key) || (datum && out.some((o) => o.datum === datum && o.von === von))) continue;
    seen.add(key);
    const quellen = [...new Set((Array.isArray(item.quellen) ? item.quellen : []).map((q) => resolve(q)).filter(Boolean))];
    out.push({ titel, datum, von, bis, ort: line(item.ort ?? item.location, 160), grund, quellen });
  }
  return out;
}
