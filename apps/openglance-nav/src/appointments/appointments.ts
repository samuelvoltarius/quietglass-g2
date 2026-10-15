/**
 * Today's appointments in the destination list (private build, optional).
 *
 * The source is the owner's own Quiet Hub daemon: `GET <VITE_BRIEF_URL>/brief/appointments`
 * with the build's bearer token (`VITE_BRIEF_TOKEN`). The daemon merges the
 * owner's calendars and Shoot Day projects and geocodes the places; nothing
 * here talks to anyone else. Without URL or token the feature is off: nothing
 * is shown and no request is ever made.
 */
import type { LatLng } from "../geo/geometry";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";

// Read as `import.meta.env.X` literally: that is the form Vite replaces at build time (and vitest can stub).
const envUrl = (): string | undefined => import.meta.env.VITE_BRIEF_URL as string | undefined;
const envToken = (): string | undefined => import.meta.env.VITE_BRIEF_TOKEN as string | undefined;

/** Daemon base address of this build (`VITE_BRIEF_URL`); empty = feature off. */
export function buildBriefUrl(raw: string | undefined = envUrl()): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : "";
  } catch {
    return "";
  }
}

/** Bearer token of a private build (`VITE_BRIEF_TOKEN`); empty = feature off. */
export function buildBriefToken(raw: string | undefined = envToken()): string {
  return (raw ?? "").trim();
}

/**
 * The feature is on in this build when the daemon address is set. The token is
 * optional: behind `tailscale serve` the daemon knows the wearer by the
 * Tailscale login, so no secret has to be baked into the package.
 */
export function briefConfigured(url = buildBriefUrl(), _token = buildBriefToken()): boolean {
  return url !== "";
}

/** Asked again this often while the destination list is shown. */
export const APPT_POLL_MS = 5 * 60_000;
export const APPT_TIMEOUT_MS = 6_000;
/** An appointment stays on the list this long after its start. */
export const APPT_PAST_MS = 30 * 60_000;
/** At most this many appointments head the list. */
export const MAX_APPTS = 3;
/** Kept free before the start when saying when to leave. */
export const DEPART_BUFFER_MS = 5 * 60_000;
/** One route request per appointment at most this often (only while the list is open). */
export const ETA_REFRESH_MS = 5 * 60_000;
/** Up to this many minutes "los in 12 min", beyond it "los um 13:45". */
const LEAVE_IN_MAX_MIN = 90;

export interface Appointment {
  /** Stable per appointment (start + place), used for the list cursor and the route cache. */
  readonly key: string;
  readonly title: string;
  /** "10:30" as the daemon wrote it (wall clock of the daemon's zone). */
  readonly time: string;
  readonly startMs: number;
  readonly at: LatLng;
  /** Short place name from the geocoder ("Musterdorf"). */
  readonly placeLabel: string;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The timed appointments with coordinates of a `/brief/appointments` answer.
 * All-day entries, entries without a place found and nonsense are left out.
 */
export function parseAppointments(body: unknown): Appointment[] {
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return [];
  const out: Appointment[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (e["allDay"] === true) continue;
    const lat = e["lat"], lon = e["lon"];
    if (!isNum(lat) || !isNum(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const startMs = typeof e["startIso"] === "string" ? Date.parse(e["startIso"]) : NaN;
    if (!Number.isFinite(startMs)) continue;
    const title = typeof e["title"] === "string" ? e["title"].replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const time = typeof e["time"] === "string" && /^\d{1,2}:\d{2}$/.test(e["time"]) ? e["time"] : clockOf(startMs);
    const placeLabel = typeof e["placeLabel"] === "string" && e["placeLabel"].trim() !== ""
      ? e["placeLabel"].trim().slice(0, 40)
      : typeof e["place"] === "string" ? e["place"].trim().slice(0, 40) : "";
    out.push({ key: `${startMs}|${lat.toFixed(4)},${lon.toFixed(4)}`, title: title || placeLabel, time, startMs, at: { lat, lon }, placeLabel });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Today's appointments still worth driving to: starting later, or started at most 30 min ago; soonest first, at most MAX_APPTS. */
export function upcomingAppointments(list: readonly Appointment[], now: number): Appointment[] {
  return list.filter((a) => a.startMs > now - APPT_PAST_MS).sort((a, b) => a.startMs - b.startMs).slice(0, MAX_APPTS);
}

/** The appointments of the daemon, or null on any failure (the list keeps what it had). */
export async function fetchAppointments(
  base: string,
  token: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  timeoutMs = APPT_TIMEOUT_MS,
): Promise<Appointment[] | null> {
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(base.replace(/\/+$/, "") + "/brief/appointments", {
      cache: "no-store",
      signal: controller.signal,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    if (!response.ok) return null;
    return parseAppointments(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Time to ask the daemon: feature on, list shown, nothing in flight, last attempt (failed or not) at least APPT_POLL_MS ago. */
export function shouldFetchAppointments(s: { on: boolean; listShown: boolean; busy: boolean; lastAttemptAt: number | null; now: number }): boolean {
  if (!s.on || s.busy) return false;
  if (s.lastAttemptAt === null) return true;
  return s.listShown && s.now - s.lastAttemptAt >= APPT_POLL_MS;
}

/** A travel time measured for an appointment, and when it was asked for. */
export interface ApptEta {
  readonly askedAt: number;
  /** Seconds by car from where the glasses were; null when the route failed. */
  readonly travelS: number | null;
}

/** The appointment whose travel time is due (never asked, or asked ETA_REFRESH_MS ago), or null. */
export function nextEtaRequest(list: readonly Appointment[], etas: ReadonlyMap<string, ApptEta>, now: number): Appointment | null {
  for (const appt of list) {
    const eta = etas.get(appt.key);
    if (!eta || now - eta.askedAt >= ETA_REFRESH_MS) return appt;
  }
  return null;
}

export type Departure =
  | { readonly kind: "now" }
  | { readonly kind: "in"; readonly minutes: number }
  | { readonly kind: "at"; readonly clock: string };

/** When to leave: latest departure = start − travel time − 5 min buffer. */
export function departure(startMs: number, travelS: number, now: number): Departure {
  const latest = startMs - travelS * 1000 - DEPART_BUFFER_MS;
  const minutes = Math.floor((latest - now) / 60_000);
  if (minutes < 1) return { kind: "now" };
  if (minutes > LEAVE_IN_MAX_MIN) return { kind: "at", clock: clockOf(latest) };
  return { kind: "in", minutes };
}

export function departureText(dep: Departure, locale: Locale): string {
  if (dep.kind === "now") return tr(messages, locale, "a.leaveNow");
  if (dep.kind === "at") return tr(messages, locale, "a.leaveAt", { t: dep.clock });
  return tr(messages, locale, "a.leaveIn", { n: dep.minutes });
}

/** "10:30" in the phone's zone. */
export function clockOf(ms: number): string {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

/** Cuts to `width`, marking the cut with " …"; whole words when at least one fits ("Testkunde …"). */
function cut(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width < 3) return "";
  let kept = "";
  for (const word of text.split(" ")) {
    const next = kept ? kept + " " + word : word;
    if (next.length + 2 > width) break;
    kept = next;
  }
  return (kept || text.slice(0, width - 2).trimEnd()) + " …";
}

/** Shortest sensible title: 6 characters ("Test …"). */
const MIN_TITLE = 6;

/**
 * The list row of an appointment: `10:30 Testkunde … · Musterdorf · los in 12 min`
 * within `width`. Time, place and departure stay; the title gives way first
 * (whole words where it can), and goes altogether before the place is cut.
 */
export function appointmentRow(appt: Appointment, width: number, leave: string | null = null): string {
  const tail = leave ? " · " + leave : "";
  const head = appt.time + " ";
  const place = appt.placeLabel && appt.placeLabel !== appt.title ? appt.placeLabel : "";
  const placePart = place ? " · " + place : "";
  const full = head + appt.title + placePart + tail;
  if (full.length <= width) return full;
  const room = width - head.length - tail.length;
  if (room - placePart.length >= MIN_TITLE) return head + cut(appt.title, room - placePart.length) + placePart + tail;
  // No room for a readable title: time, place and departure.
  const where = place || appt.title;
  return (head + cut(where, Math.max(0, room)) + tail).slice(0, width);
}

/** What the HUD says about arriving: minutes early (≥ 0) or late (< 0). */
export function arrivalDelta(etaMs: number, startMs: number): number {
  return Math.round((startMs - etaMs) / 60_000);
}

/** `Ankunft 10:22 · 8 min früher` / `· 5 min zu spät` / `· pünktlich`; `short` leaves out "Ankunft". */
export function arrivalText(etaClock: string, delta: number, locale: Locale, short = false): string {
  const when = delta > 0 ? tr(messages, locale, "a.early", { n: delta }) : delta < 0 ? tr(messages, locale, "a.late", { n: -delta }) : tr(messages, locale, "a.onTime");
  return (short ? etaClock : tr(messages, locale, "a.arrive", { t: etaClock })) + " · " + when;
}

/** The few characters after the speed on the map plate: `8 früh`, `5 spät`, `pünktl.`. */
export function arrivalChip(delta: number, locale: Locale): string {
  return delta > 0 ? tr(messages, locale, "a.earlyChip", { n: delta }) : delta < 0 ? tr(messages, locale, "a.lateChip", { n: -delta }) : tr(messages, locale, "a.onTimeChip");
}

/** The arrival page's hint: `Termin: <title> · Babel: Kundengespräch`, the title cut to fit `width`. */
export function arrivalHint(title: string, locale: Locale, width: number): string {
  const frame = tr(messages, locale, "a.arrivedHint", { title: "" });
  const room = width - frame.length;
  const clean = title.replace(/\s+/g, " ").trim();
  if (room < 4 || !clean) return tr(messages, locale, "a.arrivedHint", { title: cut(clean, Math.max(0, room)) }).slice(0, width);
  return tr(messages, locale, "a.arrivedHint", { title: cut(clean, room) });
}

/** Same place as an appointment (about 50 m): an interrupted navigation finds its appointment again. */
export function samePlaceAs(a: LatLng, b: LatLng): boolean {
  return Math.abs(a.lat - b.lat) < 0.0005 && Math.abs(a.lon - b.lon) < 0.0005;
}
