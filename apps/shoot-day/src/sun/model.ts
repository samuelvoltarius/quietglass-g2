import { footer } from "../glasses/footer";
import type { CallSheet } from "../api/types";
import { clockMinutes } from "../api/types";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { atClock, dayLight, dayPath, hhmm, lightAt, nextLight, sunWords, type LightWindow, type Place } from "./light";
import { sunPosition } from "./solar";

/**
 * Everything the Light view says, as words and numbers: one pure function of
 * (moment, place, call sheet, language). The glasses (compose.ts) and the
 * phone tab draw from the same model, so both always agree and every line is
 * testable with a fixed date.
 */

/** Where the place came from, shown on the phone. */
export type PlaceSource = "phone" | "shoot" | "saved" | "demo";

export interface LightInput {
  /** The moment shown (now, or now plus the preview offset). */
  readonly at: number;
  /** The real now; differs from `at` while previewing. */
  readonly now: number;
  readonly place: Place | null;
  readonly source: PlaceSource | null;
  readonly locale: Locale;
  /** For the next shoot; a sheet with coordinates also names the place of the shoot. */
  readonly sheet: CallSheet | null;
}

export interface TimelineEntry {
  readonly at: number;
  readonly time: string;
  readonly label: string;
  readonly kind: "blue" | "golden" | "sun" | "noon" | "shoot";
}

export interface ShootLight {
  readonly at: number;
  readonly time: string;
  readonly what: string;
  /** "Shooting 18:30: Sonne 12° WSW, goldene Stunde ab 19:12". */
  readonly line: string;
}

export interface LightModel {
  readonly ok: boolean;
  readonly locale: Locale;
  /** "LICHT" / "LIGHT". */
  readonly label: string;
  /** Clock of the moment shown. */
  readonly clock: string;
  /** "" now, "VORSCHAU 19:00 (+1:30)" while previewing. */
  readonly preview: string;
  readonly title: string;
  readonly when: string;
  readonly span: string;
  /** Title, when and span in one line (phone, tests). */
  readonly headline: string;
  readonly golden: boolean;
  readonly sunLabel: string;
  readonly sunWords: string;
  readonly azimuth: number;
  readonly elevation: number;
  readonly sunriseAzimuth: number | null;
  readonly sunsetAzimuth: number | null;
  /** Up to two short fact lines: sunset and blue hour, sunrise and noon. */
  readonly facts: readonly string[];
  readonly moon: string;
  /** The next item of the schedule with its light, or null. */
  readonly shoot: ShootLight | null;
  /** Every schedule row with a time, with its light (phone). */
  readonly shoots: readonly ShootLight[];
  /** Gesture hint for the bottom row when there is no shoot to show. */
  readonly hint: string;
  readonly path: {
    /** The moment shown (the marker on the arc). */
    readonly at: number;
    readonly start: number;
    readonly end: number;
    readonly samples: ReadonlyArray<readonly [number, number]>;
    readonly windows: readonly LightWindow[];
    readonly maxElevation: number;
  };
  readonly timeline: readonly TimelineEntry[];
  readonly notice: readonly string[];
}

const DAY_MS = 86_400_000;

/** "42 min", "2 h 05 min". */
export function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

const signed = (minutes: number): string => {
  const m = Math.abs(Math.round(minutes));
  return `${minutes < 0 ? "−" : "+"}${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};

/** Coordinates the call sheet may carry for the shoot's place. */
export function sheetPlace(sheet: CallSheet | null): Place | null {
  if (!sheet || sheet.latitude === undefined || sheet.longitude === undefined) return null;
  return { latitude: sheet.latitude, longitude: sheet.longitude };
}

/** The light at one moment of the schedule, as one line. */
export function shootLine(at: number, place: Place, locale: Locale): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const time = hhmm(at);
  const light = lightAt(at, place);
  const sun = sunWords(light.sun, locale);
  const day = dayLight(at, place);
  const running = day.windows.find((w) => w.start <= at && at < w.end);
  if (running) return L(running.kind === "golden" ? "g.light.shoot.golden" : "g.light.shoot.blue", { time, sun, end: hhmm(running.end) });
  if (light.phase === "night") return L("g.light.shoot.night", { time, el: Math.round(light.sun.elevation) });
  const golden = day.windows.find((w) => w.kind === "golden" && w.start > at);
  if (golden) return L("g.light.shoot.until", { time, sun, start: hhmm(golden.start) });
  return L("g.light.shoot.day", { time, sun });
}

function shootsOf(input: LightInput, place: Place): ShootLight[] {
  const sheet = input.sheet;
  if (!sheet) return [];
  const at = sheetPlace(sheet) ?? place;
  const out: ShootLight[] = [];
  for (const row of sheet.schedule) {
    const minutes = clockMinutes(row.time);
    if (minutes === null) continue;
    const when = atClock(input.at, minutes);
    out.push({ at: when, time: hhmm(when), what: row.what, line: shootLine(when, at, input.locale) });
  }
  return out.sort((a, b) => a.at - b.at);
}

function timelineOf(at: number, place: Place, locale: Locale, shoots: readonly ShootLight[]): TimelineEntry[] {
  const L = (key: string): string => t(locale, key);
  const { times } = dayLight(at, place);
  const out: TimelineEntry[] = [];
  const add = (when: number | null, key: string, kind: TimelineEntry["kind"]): void => {
    if (when !== null) out.push({ at: when, time: hhmm(when), label: L(key), kind });
  };
  add(times.blueMorning.start, "p.light.t.blueStart", "blue");
  add(times.goldenMorning.start, "p.light.t.goldenStart", "golden");
  add(times.sunrise, "p.light.t.sunrise", "sun");
  add(times.goldenMorning.end, "p.light.t.goldenEnd", "golden");
  add(times.noon, "p.light.t.noon", "noon");
  add(times.goldenEvening.start, "p.light.t.goldenStart", "golden");
  add(times.sunset, "p.light.t.sunset", "sun");
  add(times.blueEvening.start, "p.light.t.blueStart", "blue");
  add(times.blueEvening.end, "p.light.t.blueEnd", "blue");
  for (const shoot of shoots) out.push({ at: shoot.at, time: shoot.time, label: shoot.what || L("p.light.t.shoot"), kind: "shoot" });
  return out.sort((a, b) => a.at - b.at);
}

export function lightModel(input: LightInput): LightModel {
  const { at, locale } = input;
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const clock = hhmm(at);
  const offset = (at - input.now) / 60_000;
  const preview = Math.abs(offset) >= 1 ? L("g.light.preview", { time: clock, offset: signed(offset) }) : "";
  const hint = footer(locale, { tap: L("g.f.now"), swipe: L("g.f.time") }, "back");
  const place = input.place;
  if (!place) {
    return {
      ok: false, locale, label: L("g.light.title"), clock, preview, title: L("g.light.noPlace"), when: "", span: "", headline: L("g.light.noPlace"), golden: false,
      sunLabel: L("g.light.sun"), sunWords: "–", azimuth: 0, elevation: 0, sunriseAzimuth: null, sunsetAzimuth: null,
      facts: [], moon: "", shoot: null, shoots: [], hint,
      path: { at, start: at, end: at, samples: [], windows: [], maxElevation: 0 }, timeline: [],
      notice: [L("g.light.noPlace.1"), L("g.light.noPlace.2")],
    };
  }

  const day = dayLight(at, place);
  const { times } = day;
  const sun = sunPosition(at, place.latitude, place.longitude);

  // The headline: the golden or blue hour that runs, or the next one.
  const next = nextLight(at, place);
  let title = L("g.light.none");
  let when = "";
  let span = "";
  if (next) {
    title = L(next.window.kind === "golden" ? "g.light.golden" : "g.light.blue");
    when = next.now ? L("g.light.left", { d: duration((next.window.end - at) / 60_000) }) : L("g.light.in", { d: duration(next.inMinutes) });
    // A window that is not today carries its day.
    const days = Math.round((startOfDay(next.window.start) - startOfDay(at)) / DAY_MS);
    span = `${hhmm(next.window.start)}–${hhmm(next.window.end)}` + (days === 1 ? " " + L("g.light.tomorrow") : "");
  }
  const headline = [title, when, span ? `(${span})` : ""].filter(Boolean).join(" ");

  const facts: string[] = [];
  const blue = day.windows.find((w) => w.kind === "blue" && w.evening);
  if (times.sunset !== null) facts.push(L(blue ? "g.light.fact.set" : "g.light.fact.setOnly", { set: hhmm(times.sunset), from: blue ? hhmm(blue.start) : "", to: blue ? hhmm(blue.end) : "" }));
  else facts.push(L(times.noonElevation > 0 ? "g.light.fact.polarDay" : "g.light.fact.polarNight"));
  if (times.sunrise !== null) facts.push(L("g.light.fact.rise", { rise: hhmm(times.sunrise), noon: hhmm(times.noon), el: Math.round(times.noonElevation) }));

  const riseAz = times.sunrise !== null ? sunPosition(times.sunrise, place.latitude, place.longitude).azimuth : null;
  const setAz = times.sunset !== null ? sunPosition(times.sunset, place.latitude, place.longitude).azimuth : null;

  const moon = L("g.light.moon", { pct: Math.round(day.moon.fraction * 100), name: L("g.light.moon." + day.moon.name) });

  const shoots = shootsOf(input, place);
  // The next shoot from the real now on (a preview does not skip it).
  const shoot = shoots.find((s) => s.at >= input.now - 5 * 60_000) ?? null;

  const samples = dayPath(at, place, 10).map(([time, elevation]) => [time, elevation] as const);
  const start = samples[0]?.[0] ?? at;
  const end = samples[samples.length - 1]?.[0] ?? at;

  return {
    ok: true, locale, label: L("g.light.title"), clock, preview, title, when, span, headline,
    golden: next?.window.kind === "golden" && next.now,
    sunLabel: L("g.light.sun"), sunWords: sunWords(sun, locale), azimuth: sun.azimuth, elevation: sun.elevation,
    sunriseAzimuth: riseAz, sunsetAzimuth: setAz,
    facts, moon, shoot, shoots, hint,
    path: { at, start, end, samples, windows: day.windows, maxElevation: Math.max(10, times.noonElevation) },
    timeline: timelineOf(at, place, locale, shoots),
    notice: [],
  };
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
