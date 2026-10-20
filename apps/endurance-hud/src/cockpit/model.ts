import type { Locale } from "../i18n";
import { averageOf, elapsed, hrZone, pace, paceOf, speedOf, type Mode, type Sport, type Telemetry } from "../telemetry/model";
import { footer } from "../glasses/footer";
import { qis } from "../qis";
import { words } from "../words";

/**
 * What the cockpit shows, in words and numbers, decided without drawing
 * (QUS v1). compose.ts only lays this out.
 */
export type Tone = "ok" | "warn" | "critical" | "offline";

export interface CockpitCell { readonly label: string; readonly value: string; readonly alert?: boolean }

/** Left half: a ring of the five heart-rate zones with the pulse in the middle, power and cadence below. */
export interface RingGraphic {
  readonly kind: "ring";
  /** 0 = no reading, 1..5 = the zone the heart rate is in. */
  readonly zone: number;
  readonly center: string;
  readonly sub: string;
  readonly stats: readonly { readonly label: string; readonly value: string }[];
}

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  /** The one big value: speed on the bike, pace on foot. */
  readonly headline: readonly string[];
  readonly cells: readonly CockpitCell[];
  readonly graphic: RingGraphic;
  /** Lower left: the sport and how the data stands. */
  readonly caption: string;
  readonly hint: string;
  readonly tone: Tone;
}

export interface CockpitInput {
  readonly locale: Locale;
  readonly sport: Sport;
  readonly data: Telemetry;
  readonly mode: Mode;
  readonly maxHr: number;
  readonly now: number;
  /** The highest heart rate of this workout, if any (a cell). */
  readonly hrMax?: number;
}

export function hhmm(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const DASH = "–";
const whole = (value: number): string => (value > 0 ? String(Math.round(value)) : DASH);

/** The main value with its unit, upper case: "31.4 KM/H" or "5:42 /KM"; dashes without a reading. */
export function mainValue(sport: Sport, data: Telemetry): string {
  if (sport === "run") { const p = paceOf(data); return p > 0 ? `${pace(p)} /KM` : `${DASH} /KM`; }
  const s = speedOf(data);
  return s > 0 ? `${s.toFixed(1)} KM/H` : `${DASH} KM/H`;
}

/** The average of the main value, without a unit ("28.9" / "5:48"), or a dash. */
export function averageText(sport: Sport, data: Telemetry): string {
  const value = averageOf(data, sport);
  if (!(value > 0)) return DASH;
  return sport === "run" ? pace(value) : value.toFixed(1);
}

export function modeWord(mode: Mode, locale: Locale): string {
  if (mode.kind === "demo") return words[locale].demo;
  if (mode.kind === "live") return qis[locale].cpLive;
  return `${words[locale].stale} ${mode.age}`;
}

export function sportWord(sport: Sport, locale: Locale): string {
  return (sport === "run" ? words[locale].run : words[locale].bike).toUpperCase();
}

export function cockpitHint(locale: Locale): string {
  return footer(locale, { tap: qis[locale].refresh, swipe: qis[locale].sport }, "exit");
}

export function cockpitCells(input: CockpitInput): CockpitCell[] {
  const { locale, sport, data } = input;
  const q = qis[locale];
  const w = words[locale];
  const zone = hrZone(data.heartRate, input.maxHr);
  return [
    { label: q.cpSport, value: sportWord(sport, locale) },
    { label: w.elapsed.toUpperCase(), value: elapsed(data.elapsedSeconds) },
    { label: w.distance.toUpperCase(), value: data.distanceKm > 0 ? data.distanceKm.toFixed(1) : DASH },
    { label: `${q.cpAvg} ${(sport === "run" ? w.pace : w.speed).toUpperCase()}`, value: averageText(sport, data) },
    { label: q.cpZone, value: zone > 0 ? `Z${zone}` : DASH, ...(zone >= 5 ? { alert: true } : {}) },
    { label: q.cpHrMax, value: whole(input.hrMax ?? 0) },
  ];
}

export function cockpitModel(input: CockpitInput): CockpitModel {
  const { locale, sport, data, mode } = input;
  const w = words[locale];
  const zone = hrZone(data.heartRate, input.maxHr);
  return {
    title: "ENDURANCE HUD",
    clock: hhmm(input.now),
    headline: [mainValue(sport, data)],
    cells: cockpitCells(input),
    graphic: {
      kind: "ring",
      zone,
      center: whole(data.heartRate),
      sub: qis[locale].cpHeart,
      stats: [
        { label: w.power.toUpperCase(), value: data.powerWatts > 0 ? `${Math.round(data.powerWatts)} W` : DASH },
        { label: w.cadence.toUpperCase(), value: data.cadence > 0 ? `${Math.round(data.cadence)} RPM` : DASH },
      ],
    },
    caption: `${sportWord(sport, locale)} · ${modeWord(mode, locale)}`,
    hint: cockpitHint(locale),
    tone: mode.kind === "stale" ? "offline" : zone >= 5 ? "warn" : "ok",
  };
}
