import type { Locale } from "../i18n";
import { t } from "../messages";
import {
  entriesOnDay, formatHM, isRunning, openSecondsInRange, openSecondsOnDay, secondsInRange, secondsOnDay, startOfDay, startOfWeek,
  type ClockState, type TimeEntry,
} from "../tracking/clock";
import { armedFooter, footer } from "../glasses/footer";

/**
 * What the shift cockpit shows, in words and numbers, decided without drawing
 * (QUS v1): the one headline, the label/value cells, the ring for the left
 * half, the caption and the hint line. compose.ts only lays this out.
 *
 *   running  NOCH 2:15   the time left to the daily target (no target: LÄUFT, the entry's time)
 *   armed    STOPP?      the first tap of a stop
 *   pause    PAUSE 0:12  stopped, time since the last stop
 *   done     FEIERABEND  stopped, daily target reached
 *   idle     BEREIT      stopped, nothing recorded today
 */

export type CockpitState = "running" | "armed" | "pause" | "done" | "idle";

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  /** Drawn with a frame round it (something is worth a look here). */
  readonly alert?: boolean;
}

/** The ring of the left half: today's time against the target (or against ten hours without one). */
export interface CockpitRing {
  /** 0..1 of the ring that is recorded time. */
  readonly recorded: number;
  /** 0..1 of the ring including the entry that is still running. */
  readonly total: number;
  /** A daily target is set: its mark sits at the top and the centre says how far it is. */
  readonly hasTarget: boolean;
  readonly reached: boolean;
  readonly running: boolean;
  readonly center: string;
  readonly sub: string;
}

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  readonly state: CockpitState;
  /** The one big line, already upper case. */
  readonly headline: readonly string[];
  /** Rows of three columns: Start, Ende, Pause, Heute, Woche. */
  readonly cells: readonly CockpitCell[];
  readonly ring: CockpitRing;
  /** Left bottom: the project, or "Demo". */
  readonly caption: string;
  /** The one footer line with the gestures. */
  readonly hint: string;
}

export interface CockpitInput {
  readonly clock: ClockState;
  readonly entries: readonly TimeEntry[];
  readonly now: number;
  readonly locale: Locale;
  readonly targetHours: number | null;
  /** A stop is waiting for its confirming tap. */
  readonly armed: boolean;
  /** The sample shift of ?demo=1: the caption says so. */
  readonly demo: boolean;
  /** More than one project: a swipe on the pause page offers them. */
  readonly projectCount: number;
}

/** The ring stands for this many hours when no target is set. */
export const DEFAULT_SCALE_HOURS = 10;
/** The ring moves in this many steps. */
export const RING_STEPS = 240;

const DASH = "–";

/** "HH:MM" of an epoch ms in the phone's time (24 h). */
export function hhmm(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The numbers of one moment; the model and the phone both read these. */
export interface ShiftFigures {
  readonly running: boolean;
  /** Seconds worked today (closed entries plus the open one's part of today). */
  readonly worked: number;
  readonly closedToday: number;
  readonly week: number;
  /** The daily target in seconds, or null. */
  readonly target: number | null;
  /** Seconds to the target (negative once passed), or null without one. */
  readonly remaining: number | null;
  readonly firstStart: number | null;
  readonly lastEnd: number | null;
  /** Seconds of the open entry (0 when stopped). */
  readonly openSeconds: number;
  /** Idle time between the first start and now (or the last stop once the target is reached). */
  readonly pause: number;
  /** Seconds since the last stop; 0 while running or when nothing was recorded today. */
  readonly sinceStop: number;
}

export function shiftFigures(clock: ClockState, entries: readonly TimeEntry[], now: number, targetHours: number | null): ShiftFigures {
  const today = startOfDay(now);
  const running = isRunning(clock);
  const closedToday = secondsOnDay(entries, today);
  const openToday = openSecondsOnDay(clock, today, now);
  const worked = closedToday + openToday;
  const weekStart = startOfWeek(now);
  const week = secondsInRange(entries, weekStart, now + 1) + openSecondsInRange(clock, weekStart, now + 1, now);
  const target = targetHours !== null && targetHours > 0 ? Math.round(targetHours * 3600) : null;
  const remaining = target === null ? null : target - worked;

  const todays = entriesOnDay(entries, today);
  const starts = todays.map((entry) => Math.max(entry.startedAt, today));
  if (running && clock.startedAt !== null) starts.push(Math.max(clock.startedAt, today));
  const firstStart = starts.length === 0 ? null : Math.min(...starts);
  const lastEnd = todays.length === 0 ? null : Math.max(...todays.map((entry) => entry.endedAt));

  const finished = !running && remaining !== null && remaining <= 0 && lastEnd !== null;
  const spanEnd = finished ? lastEnd : now;
  const pause = firstStart === null ? 0 : Math.max(0, Math.round((spanEnd - firstStart) / 1000) - worked);
  const sinceStop = !running && lastEnd !== null && worked > 0 ? Math.max(0, Math.round((now - lastEnd) / 1000)) : 0;
  const openSeconds = running && clock.startedAt !== null ? Math.max(0, Math.round((now - clock.startedAt) / 1000)) : 0;
  return { running, worked, closedToday, week, target, remaining, firstStart, lastEnd, openSeconds, pause, sinceStop };
}

/** Which of the cockpit's states this moment is in. */
export function cockpitState(figures: ShiftFigures, armed: boolean): CockpitState {
  if (figures.running) return armed ? "armed" : "running";
  if (figures.worked <= 0) return "idle";
  return figures.remaining !== null && figures.remaining <= 0 ? "done" : "pause";
}

/** The one statement of the page, upper case: "NOCH 2:15", "PAUSE 0:12", "FEIERABEND", "STOPP?". */
export function headlineFor(figures: ShiftFigures, state: CockpitState, locale: Locale): string[] {
  const word = (key: string, time: string): string => `${t(locale, key)} ${time}`.toUpperCase();
  switch (state) {
    case "armed": return [t(locale, "g.cp.stop").toUpperCase()];
    case "running":
      if (figures.remaining === null) return [word("g.cp.running", formatHM(figures.openSeconds))];
      return [figures.remaining > 0 ? word("g.cp.left", formatHM(figures.remaining)) : word("g.cp.over", formatHM(-figures.remaining))];
    case "pause": return [word("g.cp.pause", formatHM(figures.sinceStop))];
    case "done": return [t(locale, "g.cp.done").toUpperCase()];
    case "idle": return [t(locale, "g.cp.idle").toUpperCase()];
  }
}

/** Start, Ende, Pause, Heute, Woche. */
export function cellsFor(figures: ShiftFigures, now: number, locale: Locale): CockpitCell[] {
  let end = DASH;
  if (figures.running) {
    // The expected end of the shift: now plus what is left to the target (breaks to come are not known).
    if (figures.remaining !== null && figures.remaining > 0) end = hhmm(now + figures.remaining * 1000);
  } else if (figures.lastEnd !== null && figures.worked > 0) end = hhmm(figures.lastEnd);
  return [
    { label: t(locale, "g.cp.start"), value: figures.firstStart === null ? DASH : hhmm(figures.firstStart) },
    { label: t(locale, "g.cp.end"), value: end },
    { label: t(locale, "g.cp.break"), value: figures.firstStart === null ? DASH : formatHM(figures.pause) },
    { label: t(locale, "g.cp.today"), value: formatHM(figures.worked) },
    { label: t(locale, "g.cp.week"), value: formatHM(figures.week) },
  ];
}

/** "8", "7,5" / "7.5": hours as the language writes them, no trailing zeros. */
export function formatTargetHours(hours: number, locale: Locale): string {
  const text = String(Math.round(hours * 100) / 100);
  return locale === "de" ? text.replace(".", ",") : text;
}

export function ringFor(figures: ShiftFigures, targetHours: number | null, locale: Locale): CockpitRing {
  const scale = figures.target ?? DEFAULT_SCALE_HOURS * 3600;
  // Steps of 1/240 of the ring (two pixels): the picture, and with it the left tiles, change a few times an hour, not every second.
  const clamp = (value: number): number => Math.round(Math.max(0, Math.min(1, value)) * RING_STEPS) / RING_STEPS;
  const hasTarget = figures.target !== null;
  return {
    recorded: clamp(figures.closedToday / scale),
    total: clamp(figures.worked / scale),
    hasTarget,
    reached: hasTarget && figures.worked >= scale,
    running: figures.running,
    center: hasTarget ? `${Math.floor((figures.worked * 100) / scale)}%` : formatHM(figures.worked),
    sub: hasTarget && targetHours !== null
      ? t(locale, "g.cp.ofTarget", { target: formatTargetHours(targetHours, locale) }).toUpperCase()
      : t(locale, "g.cp.today").toUpperCase(),
  };
}

/** The hint line: only the gestures that do something here. */
export function cockpitHint(locale: Locale, state: CockpitState, projectCount: number): string {
  if (state === "armed") return armedFooter(locale, t(locale, "g.f.stop"));
  if (state === "running") return footer(locale, { tap: t(locale, "g.f.stop") }, "exit");
  return footer(locale, {
    tap: t(locale, state === "idle" ? "g.f.start" : "g.f.resume"),
    ...(projectCount > 1 ? { swipe: t(locale, "g.f.project") } : {}),
  }, "exit");
}

/** The project in the caption: the running one, else the last of today. */
export function captionFor(input: CockpitInput): string {
  if (input.demo) return t(input.locale, "g.cp.demo");
  if (input.clock.project !== null) return input.clock.project;
  const todays = entriesOnDay(input.entries, startOfDay(input.now));
  return todays[todays.length - 1]?.project ?? "";
}

export function cockpitModel(input: CockpitInput): CockpitModel {
  const { now, locale } = input;
  const figures = shiftFigures(input.clock, input.entries, now, input.targetHours);
  const state = cockpitState(figures, input.armed);
  return {
    title: t(locale, "g.cp.title"),
    clock: hhmm(now),
    state,
    headline: headlineFor(figures, state, locale),
    cells: cellsFor(figures, now, locale),
    ring: ringFor(figures, input.targetHours, locale),
    caption: captionFor(input),
    hint: cockpitHint(locale, state, input.projectCount),
  };
}

/** A key that changes exactly when what the cockpit would draw changes (the tile sender dedupes on pixels; this is for tests and callers). */
export function modelKey(model: CockpitModel): string {
  return JSON.stringify([model.clock, model.state, model.headline, model.cells, model.ring, model.caption, model.hint]);
}
