/**
 * Shoot Day -> Google Calendar through a Google Apps Script web app (the
 * "bridge", selfhost/services/shoot-day/google-calendar-bridge.gs). One
 * calendar event per project that has a date. No OAuth, no dependencies.
 *
 * Also the Work Dashboard's appointments (tasks with is_event; createEventSync):
 * confirmed ones (no label "vorschlag") are created/updated as "<Kunde> – <Titel>",
 * cancelled ones (task gone, label "abgesagt") removed; "intern" never goes there.
 * Same bridge and payload, keyed "wd:<task id>".
 *
 * Environment (all needed, otherwise the sync is off and makes no calls)
 *   SHOOT_GCAL_WEBHOOK        the bridge's /exec URL
 *   SHOOT_GCAL_SECRET         shared secret, same as the script property SHOOT_SECRET
 *   SHOOT_GCAL_CALENDAR       calendar id (default: the script owner's default calendar)
 *   SHOOT_GCAL_DURATION_MIN   length of a timed event (default 60)
 *   SHOOT_TZ                  time zone of the dates (default Europe/Vienna)
 *   SHOOT_GCAL_RETRY_MS       first retry delay after a failed sync (default 30000, doubles up to 15 min)
 */
import { createHash } from "node:crypto";

export function configFromEnv(env = process.env) {
  return {
    webhook: (env["SHOOT_GCAL_WEBHOOK"] ?? "").trim(),
    secret: env["SHOOT_GCAL_SECRET"] ?? "",
    calendar: env["SHOOT_GCAL_CALENDAR"] ?? "",
    durationMin: Math.max(5, Number(env["SHOOT_GCAL_DURATION_MIN"]) || 60),
    tz: env["SHOOT_TZ"] || "Europe/Vienna",
    retryMs: Math.max(1, Number(env["SHOOT_GCAL_RETRY_MS"]) || 30_000),
  };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, "0");
function validDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** "2026-10-14 10:30", "2026-10-14", "14.10.2026 10:30" -> { y, m, d, hh, mm } (hh = -1: all day) or null. */
export function parseWhen(text) {
  const s = String(text ?? "").trim();
  let y; let mo; let d; let hh; let mi;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?$/.exec(s);
  if (m) { [, y, mo, d, hh, mi] = m; }
  else if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ ,]+(\d{1,2})[:.](\d{2}))?(?:\s*Uhr)?$/.exec(s))) { [, d, mo, y, hh, mi] = m; }
  else return null;
  y = Number(y); mo = Number(mo); d = Number(d);
  if (!validDate(y, mo, d)) return null;
  if (hh === undefined) return { y, m: mo, d, hh: -1, mm: 0 };
  hh = Number(hh); mi = Number(mi);
  if (hh > 23 || mi > 59) return null;
  return { y, m: mo, d, hh, mm: mi };
}

/** Offset of `tz` from UTC in minutes at the given instant. */
function offsetMinutes(instant, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** ISO string with offset for a wall-clock time in `tz`, e.g. 2026-10-14T10:30:00+02:00. */
export function isoWithOffset(wallUtcMs, tz) {
  let offset = offsetMinutes(new Date(wallUtcMs), tz);
  offset = offsetMinutes(new Date(wallUtcMs - offset * 60_000), tz); // settle across a DST change
  const t = new Date(wallUtcMs);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The bridge payload (without the secret) for a project, or null when it has no usable date. No links, no secrets. */
export function buildEvent(project, customer, cfg) {
  const when = parseWhen(project.date);
  if (!when) return null;
  const customerName = customer?.name && customer.name !== "?" ? customer.name : "";
  const open = (project.ideas ?? []).filter((i) => !i.done).length;
  const lines = [];
  if (customerName) lines.push("Kunde: " + customerName + (customer?.company ? " (" + customer.company + ")" : ""));
  if (customer?.phone) lines.push("Tel: " + customer.phone);
  if (customer?.email) lines.push("E-Mail: " + customer.email);
  if (project.place) lines.push("Ort: " + project.place);
  lines.push("Offene Ideen: " + open);
  const event = {
    action: "upsert",
    project: project.id,
    title: customerName ? customerName + " – " + project.name : project.name,
    location: project.place || "",
    description: lines.join("\n"),
    allDay: when.hh < 0,
    date: `${when.y}-${pad(when.m)}-${pad(when.d)}`,
    start: "",
    end: "",
  };
  if (when.hh >= 0) {
    const start = Date.UTC(when.y, when.m - 1, when.d, when.hh, when.mm);
    event.start = isoWithOffset(start, cfg.tz);
    event.end = isoWithOffset(start + cfg.durationMin * 60_000, cfg.tz);
  }
  if (cfg.calendar) event.calendarId = cfg.calendar;
  return event;
}

export const signature = (event) => (event ? createHash("sha256").update(JSON.stringify(event)).digest("hex").slice(0, 24) : "");

// ---------------------------------------------------------------------------
// Appointments from the Work Dashboard (tasks with is_event). Same bridge, same
// payload; the bridge's key is "wd:<task id>", so they never meet a project's event.
// ---------------------------------------------------------------------------
/** Labels that keep an appointment out of Google: a proposal not yet confirmed, internal, cancelled. */
const NOT_IN_GOOGLE = ["vorschlag", "intern", "abgesagt"];
const CANCELLED_STATUS = ["abgesagt", "cancelled", "canceled"];
export const taskKey = (taskId) => "wd:" + taskId;

/** A dashboard date-time → { wall (ms of the wall-clock time in `tz`), iso } or null. Without an offset it is taken as wall time in `tz`. */
export function zonedTime(value, tz) {
  const s = String(value ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) return null;
  if (!validDate(Number(m[1]), Number(m[2]), Number(m[3])) || Number(m[4]) > 23 || Number(m[5]) > 59) return null;
  let wall;
  if (m[7]) {
    const instant = Date.parse(s.replace(" ", "T"));
    if (!Number.isFinite(instant)) return null;
    wall = instant + offsetMinutes(new Date(instant), tz) * 60_000;
  } else {
    wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  }
  wall = Math.floor(wall / 60_000) * 60_000;
  return { wall, iso: isoWithOffset(wall, tz) };
}

/**
 * The bridge payload (without the secret) for a dashboard appointment, or null when it
 * does not belong into Google: a proposal ("vorschlag"), internal ("intern"), cancelled
 * ("abgesagt" or a cancelled status), or without a usable date. No links, no secrets.
 * @param {{ taskId: string, title: string, customer?: string, project?: string, status?: string, labels?: string[],
 *   starts_at?: string, ends_at?: string, start_date?: string, due_date?: string, location?: string }} task
 */
export function buildTaskEvent(task, cfg) {
  const labels = (task?.labels ?? []).map((l) => String(l).toLowerCase());
  if (labels.some((l) => NOT_IN_GOOGLE.includes(l))) return null;
  if (CANCELLED_STATUS.includes(String(task?.status ?? "").toLowerCase())) return null;
  const start = zonedTime(task?.starts_at, cfg.tz);
  const day = [task?.start_date, task?.due_date, task?.starts_at].map((v) => /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""))).find((x) => x && validDate(Number(x[1]), Number(x[2]), Number(x[3])));
  if (!start && !day) return null;
  const title = String(task?.title ?? "").trim() || "Termin";
  const customer = String(task?.customer ?? "").trim();
  const lines = [];
  if (customer) lines.push("Kunde: " + customer);
  if (task?.project) lines.push("Projekt: " + task.project);
  if (task?.location) lines.push("Ort: " + task.location);
  lines.push("— aus dem Work Dashboard");
  const event = {
    action: "upsert",
    project: taskKey(task.taskId),
    title: customer ? customer + " – " + title : title,
    location: task?.location || "",
    description: lines.join("\n"),
    allDay: !start,
    date: start ? start.iso.slice(0, 10) : day[0],
    start: "",
    end: "",
  };
  if (start) {
    const end = zonedTime(task?.ends_at, cfg.tz);
    event.start = start.iso;
    event.end = end && end.wall > start.wall ? end.iso : isoWithOffset(start.wall + cfg.durationMin * 60_000, cfg.tz);
  }
  if (cfg.calendar) event.calendarId = cfg.calendar;
  return event;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (t) => String(t).replace(/\s+/g, " ").slice(0, 160);

export class GcalError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

/**
 * Calls the bridge. Apps Script answers a POST with a 302 to a googleusercontent
 * URL that must be fetched with GET (re-sending the POST fails), so redirects
 * are followed by hand. Transient failures are retried with backoff.
 * Errors never contain the secret or the URL.
 */
export function createClient(cfg, log = () => undefined, attempts = 4) {
  async function once(payload) {
    let response = await fetch(cfg.webhook, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // no CORS preflight semantics needed; the script parses the body itself
      body: JSON.stringify({ secret: cfg.secret, ...payload }),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    for (let hops = 0; response.status >= 300 && response.status < 400 && hops < 5; hops++) {
      const next = response.headers.get("location");
      if (!next) break;
      response = await fetch(new URL(next, cfg.webhook), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(30_000) });
    }
    const text = await response.text();
    if (!response.ok) throw new GcalError("bridge answered HTTP " + response.status, response.status);
    let body;
    try { body = JSON.parse(text); } catch { throw new GcalError("bridge answer is not JSON (is access set to \"Anyone\"?)", 502); }
    if (!body?.ok) throw new GcalError("bridge refused: " + clip(body?.error ?? "unknown"), 400);
    return body;
  }

  return {
    async send(payload) {
      let delay = 200;
      for (let attempt = 1; ; attempt++) {
        try { return await once(payload); } catch (error) {
          const status = error instanceof GcalError ? error.status : 0;
          const retryable = status === 0 || status === 429 || status >= 500;
          if (!retryable || attempt >= attempts) {
            throw error instanceof GcalError ? error : new GcalError("bridge unreachable: " + clip(error.name === "TimeoutError" ? "timeout" : error.cause?.code ?? error.message));
          }
          log("gcal: retry " + attempt + " (" + (status ? "HTTP " + status : "network") + ")");
          await sleep(delay); delay *= 2;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Sync engine. Reconciles every project with its event; works from the data
// itself, so a missed or failed run is simply repeated by the next one.
// ---------------------------------------------------------------------------
/**
 * hooks: { projects(): [{project, customer}], known(): {projectId: eventId}, setKnown(projectId, eventId|null), save(): Promise }
 * The project keeps `gcalEventId` and `gcalSig` (hash of what was last sent).
 */
export function createSync(cfg, hooks, log = (m) => console.error(m)) {
  const enabled = () => Boolean(cfg.webhook && cfg.secret);
  const client = createClient(cfg, log);
  const status = { lastSync: 0, lastError: "" };
  let running = null; let again = false; let timer = null; let backoff = cfg.retryMs;

  const isDirty = (project, customer) => {
    const event = buildEvent(project, customer, cfg);
    return event ? !project.gcalEventId || signature(event) !== project.gcalSig : Boolean(project.gcalEventId);
  };

  async function syncOne({ project, customer }) {
    const event = buildEvent(project, customer, cfg);
    if (!event) {
      await client.send({ action: "delete", project: project.id, ...(cfg.calendar ? { calendarId: cfg.calendar } : {}) });
      delete project.gcalEventId; delete project.gcalSig; hooks.setKnown(project.id, null);
      return;
    }
    const answer = await client.send(event);
    project.gcalEventId = String(answer.eventId || "synced"); project.gcalSig = signature(event); hooks.setKnown(project.id, project.gcalEventId);
  }

  const orphans = () => { const live = new Set(hooks.projects().map((i) => i.project.id)); return Object.keys(hooks.known()).filter((pid) => !live.has(pid)); };
  const pendingCount = () => hooks.projects().filter(({ project, customer }) => isDirty(project, customer)).length + orphans().length;

  async function pass() {
    let failed = 0; let lastError = "";
    for (const pid of orphans()) { // projects deleted since the last run
      try {
        await client.send({ action: "delete", project: pid, ...(cfg.calendar ? { calendarId: cfg.calendar } : {}) });
        hooks.setKnown(pid, null);
      } catch (error) { failed++; lastError = error.message; }
    }
    for (const item of hooks.projects()) {
      if (!isDirty(item.project, item.customer)) continue;
      try { await syncOne(item); } catch (error) {
        failed++; lastError = error.message;
      }
    }
    await hooks.save();
    return { failed, lastError };
  }

  async function run() {
    do {
      again = false;
      const { failed, lastError } = await pass();
      if (failed) { status.lastError = lastError; log("gcal: " + failed + " item(s) not synced: " + lastError); }
      else { status.lastError = ""; status.lastSync = Date.now(); backoff = cfg.retryMs; }
    } while (again);
    if (pendingCount() > 0) {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; request(); }, backoff);
      timer.unref?.();
      backoff = Math.min(backoff * 2, 15 * 60_000);
    }
  }

  /** Fire and forget: called after the HTTP answer; never throws. */
  function request() {
    if (!enabled()) return Promise.resolve();
    if (running) { again = true; return running; }
    running = run().catch((error) => { status.lastError = clip(error.message); log("gcal: " + clip(error.message)); })
      .finally(() => { running = null; });
    return running;
  }

  return {
    enabled,
    request,
    status: () => ({ enabled: enabled(), lastSync: status.lastSync, lastError: status.lastError, pending: enabled() ? pendingCount() : 0 }),
    stop: () => { clearTimeout(timer); timer = null; },
  };
}

// ---------------------------------------------------------------------------
// Sync engine for the dashboard's appointments. Runs in the rhythm of the
// dashboard poll (and on POST /api/gcal/sync); works from the list itself, so a
// missed or failed run is simply repeated by the next one.
// ---------------------------------------------------------------------------
/**
 * hooks: { list(): Promise<task[] | null> (null = dashboard not readable: nothing is deleted),
 *          known(): {taskId: {eventId, sig}} (kept in the server's state.gcalEvents), save(): Promise }
 * Sends only what changed (signature of the payload); an appointment that is gone, cancelled,
 * internal or back to a proposal is deleted in Google.
 */
export function createEventSync(cfg, hooks, log = (m) => console.error(m)) {
  const enabled = () => Boolean(cfg.webhook && cfg.secret && hooks.enabled?.() !== false);
  const client = createClient(cfg, log);
  const status = { lastSync: 0, lastError: "" };
  let running = null; let again = false;

  async function pass() {
    const tasks = await hooks.list();
    if (!Array.isArray(tasks)) return { failed: 1, lastError: "dashboard not readable", changed: false };
    const known = hooks.known();
    const want = new Map();
    for (const task of tasks) {
      const event = task?.taskId ? buildTaskEvent(task, cfg) : null;
      if (event) want.set(String(task.taskId), event);
    }
    let failed = 0; let lastError = ""; let changed = false;
    for (const taskId of Object.keys(known)) {
      if (want.has(taskId)) continue;
      try {
        await client.send({ action: "delete", project: taskKey(taskId), ...(cfg.calendar ? { calendarId: cfg.calendar } : {}) });
        delete known[taskId]; changed = true;
      } catch (error) { failed++; lastError = error.message; }
    }
    for (const [taskId, event] of want) {
      const sig = signature(event);
      if (known[taskId]?.sig === sig) continue;
      try {
        const answer = await client.send(event);
        known[taskId] = { eventId: String(answer.eventId || "synced").slice(0, 200), sig }; changed = true;
      } catch (error) { failed++; lastError = error.message; }
    }
    if (changed) await hooks.save();
    return { failed, lastError };
  }

  async function run() {
    do {
      again = false;
      const { failed, lastError } = await pass();
      if (failed) { status.lastError = clip(lastError); log("gcal: " + failed + " appointment(s) not synced: " + clip(lastError)); }
      else { status.lastError = ""; status.lastSync = Date.now(); }
    } while (again);
  }

  /** One pass now (queued behind a running one); never rejects. */
  function request() {
    if (!enabled()) return Promise.resolve();
    if (running) { again = true; return running; }
    running = run().catch((error) => { status.lastError = clip(error.message); log("gcal: " + clip(error.message)); })
      .finally(() => { running = null; });
    return running;
  }

  return {
    enabled,
    request,
    status: () => ({ enabled: enabled(), lastSync: status.lastSync, lastError: status.lastError, synced: Object.keys(hooks.known() ?? {}).length }),
  };
}
