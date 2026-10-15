import { compassPoint, localNoon, moonPhase, moonPhaseName, sunPosition, sunTimes, type Span, type SunPosition, type SunTimes } from "./solar";

/**
 * The photographer's view of the sun, as plain data: what light it is at a
 * moment, which golden or blue hour comes next (or is running), and the
 * light at the next shoot. Pure in (moment, place), so every line on the
 * glasses and the phone can be tested with a fixed date.
 */

export interface Place {
  readonly latitude: number;
  readonly longitude: number;
}

export type LightKind = "golden" | "blue";
export type Phase = "night" | "blue" | "golden" | "day";

export interface LightWindow {
  readonly kind: LightKind;
  readonly start: number;
  readonly end: number;
  /** Morning (around sunrise) or evening. */
  readonly evening: boolean;
}

export interface NextLight {
  readonly window: LightWindow;
  /** True while the window is running. */
  readonly now: boolean;
  /** Minutes until it starts (0 while running). */
  readonly inMinutes: number;
}

export interface LightAt {
  readonly at: number;
  readonly sun: SunPosition;
  readonly phase: Phase;
}

export interface DayLight {
  readonly place: Place;
  readonly times: SunTimes;
  readonly windows: readonly LightWindow[];
  readonly moon: { readonly fraction: number; readonly name: string };
}

/** Golden: −4° … +6°, blue: −6° … −4° (geometric elevation). */
export function phaseOf(elevation: number): Phase {
  if (elevation >= 6) return "day";
  if (elevation >= -4) return "golden";
  if (elevation >= -6) return "blue";
  return "night";
}

export function lightAt(at: number, place: Place): LightAt {
  const sun = sunPosition(at, place.latitude, place.longitude);
  return { at, sun, phase: phaseOf(sun.elevation) };
}

function windowsOf(times: SunTimes): LightWindow[] {
  const out: LightWindow[] = [];
  const add = (kind: LightKind, span: Span, evening: boolean): void => {
    if (span.start !== null && span.end !== null && span.end > span.start) out.push({ kind, start: span.start, end: span.end, evening });
  };
  add("blue", times.blueMorning, false);
  const { goldenMorning: gm, goldenEvening: ge } = times;
  // Polar winter: the sun peaks inside the golden band, so the morning one never
  // ends and the evening one never starts. That is one golden stretch round noon.
  if (gm.start !== null && gm.end === null && ge.start === null && ge.end !== null) add("golden", { start: gm.start, end: ge.end }, false);
  else {
    add("golden", gm, false);
    add("golden", ge, true);
  }
  add("blue", times.blueEvening, true);
  return out.sort((a, b) => a.start - b.start);
}

export function dayLight(at: number, place: Place): DayLight {
  const times = sunTimes(localNoon(at), place.latitude, place.longitude);
  const moon = moonPhase(at);
  return { place, times, windows: windowsOf(times), moon: { fraction: moon.fraction, name: moonPhaseName(moon.phase) } };
}

/** The golden or blue hour that is running at `at`, or the next one (looking into the next two days). */
export function nextLight(at: number, place: Place, kinds: readonly LightKind[] = ["golden", "blue"]): NextLight | null {
  for (let day = 0; day < 3; day += 1) {
    const { windows } = dayLight(at + day * 86_400_000, place);
    for (const window of windows) {
      if (!kinds.includes(window.kind) || window.end <= at) continue;
      const running = window.start <= at;
      return { window, now: running, inMinutes: running ? 0 : Math.round((window.start - at) / 60_000) };
    }
  }
  return null;
}

/** The evening golden hour after `at` on the same day, if there is one still to come. */
export function goldenFrom(at: number, place: Place): number | null {
  const window = dayLight(at, place).windows.find((w) => w.kind === "golden" && w.start > at);
  return window ? window.start : null;
}

/** Elevation samples over the local day for the sun-path arc: [ms, elevation, azimuth]. */
export function dayPath(at: number, place: Place, stepMinutes = 10): Array<[number, number, number]> {
  const noon = localNoon(at);
  const start = noon - 12 * 3_600_000;
  const out: Array<[number, number, number]> = [];
  for (let minutes = 0; minutes <= 24 * 60; minutes += stepMinutes) {
    const t = start + minutes * 60_000;
    const sun = sunPosition(t, place.latitude, place.longitude);
    out.push([t, sun.elevation, sun.azimuth]);
  }
  return out;
}

/** "12° WSW" — rounded elevation and 16-point compass direction. */
export function sunWords(sun: SunPosition, locale: "de" | "en"): string {
  return `${Math.round(sun.elevation)}° ${compassPoint(sun.azimuth, locale)}`;
}

/** 24-hour wall clock in the phone's time zone. */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A schedule time ("18:30") on the calendar day of `day`, as epoch ms. */
export function atClock(day: number, minutesOfDay: number): number {
  const d = new Date(day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(minutesOfDay / 60), minutesOfDay % 60, 0, 0).getTime();
}

/** Valid coordinates or null. */
export function place(latitude: unknown, longitude: unknown): Place | null {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (latitude === null || longitude === null || latitude === undefined || longitude === undefined) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { latitude: lat, longitude: lon };
}
