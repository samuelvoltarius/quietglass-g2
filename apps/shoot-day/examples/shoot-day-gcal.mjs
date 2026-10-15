/**
 * Shoot Day -> Google Calendar through a Google Apps Script web app (the
 * "bridge", selfhost/services/shoot-day/google-calendar-bridge.gs). One
 * calendar event per project that has a date. No OAuth, no dependencies.
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
