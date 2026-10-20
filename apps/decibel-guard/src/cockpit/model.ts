import {
  averageDb, doseLevel, formatDuration, remainingSeconds, type DoseSettings, type DoseState,
} from "../noise/dose";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { armedFooter, footer, micFooter } from "../glasses/footer";
import { dosePercent, meterShare, WARN_PERCENT } from "../glasses/quant";

/**
 * What the cockpit shows, in words and numbers, decided without drawing
 * (QUS v1). compose.ts only lays this out.
 *
 * Two rules govern this display:
 *  1. The microphone indicator is never optional: whenever the mic is on, the
 *     hint line starts with it and the lower left says so in big letters.
 *  2. Quiet costs no attention: below the threshold the headline is just the level.
 */
export type Tone = "ok" | "warn" | "critical" | "offline";

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  readonly alert?: boolean;
}

/** One reading as a bar: 0..100 on its scale, tick marks (criterion, 50 %), and an optional peak line. */
export interface CockpitBar {
  readonly label: string;
  readonly value: number | null;
  readonly text: string;
  readonly tone: Tone;
  readonly marks: readonly number[];
  readonly peak?: number;
}

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  readonly headline: readonly string[];
  readonly cells: readonly CockpitCell[];
  /** The level bar and the dose bar. */
  readonly bars: readonly CockpitBar[];
  /** Lower left: the microphone indicator while measuring. */
  readonly caption: string;
  readonly hint: string;
  readonly tone: Tone;
}

export interface CockpitInput {
  readonly dose: DoseState;
  readonly settings: DoseSettings;
  readonly listening: boolean;
  /** Approximate SPL, already quantised by the caller, or null before any audio arrives. */
  readonly level: number | null;
  /** The level as the bar shows it (3 dB steps); the headline uses `level`. */
  readonly barLevel?: number | null;
  /** Peak-hold line, quantised, or null. */
  readonly peak?: number | null;
  readonly calibrated: boolean;
  readonly locale: Locale;
  readonly now: number;
  readonly micError?: boolean;
  /** `reset` = a hold asked to clear today's dose, `stop` = a tap asked to stop measuring. */
  readonly armed?: "reset" | "stop" | null;
}

export function hhmm(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const DASH = "–";

export function percent(fraction: number): string {
  return Math.round(Math.min(fraction, 9.99) * 100) + "%";
}

/** "72 DB", with "~" in front while the values are estimates; dashes before audio arrives. */
export function levelText(level: number | null, calibrated: boolean, locale: Locale): string {
  if (level === null || !Number.isFinite(level)) return t(locale, "g.cp.noLevel");
  return t(locale, "g.cp.level", { db: `${calibrated ? "" : "~"}${Math.max(0, Math.round(level))}` });
}

/** Minutes only, so the cell changes once a minute: "0 min", "12 min", "1:05 h". */
export function minutesShort(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} h`;
}

/** The two headline lines. */
export function headlineLines(input: CockpitInput): string[] {
  const { locale } = input;
  if (input.armed === "reset") return [t(locale, "g.cp.resetQ1"), t(locale, "g.cp.resetQ2")];
  if (input.armed === "stop") return [t(locale, "g.cp.stopQ1"), t(locale, "g.cp.stopQ2")];
  if (!input.listening) {
    if (input.micError) return [t(locale, "g.cp.micErr1"), t(locale, "g.cp.micErr2")];
    return [t(locale, "g.cp.ready"), input.dose.fraction > 0 ? t(locale, "g.cp.todayPct", { pct: percent(input.dose.fraction) }) : t(locale, "g.cp.idle")];
  }
  const band = doseLevel(input.dose);
  const word = band === "exceeded" ? "g.cp.full" : band === "high" ? "g.cp.high" : band === "accumulating" ? "g.cp.counting" : "g.cp.quiet";
  return [levelText(input.level, input.calibrated, locale), t(locale, word)];
}

/** The one hint line; the microphone indicator is part of every line while measuring. */
export function hintLine(input: CockpitInput): string {
  const { locale } = input;
  const x = (key: string): string => t(locale, key);
  if (input.armed === "reset") return armedFooter(locale, x(input.listening ? "g.f.clear" : "g.f.clearDose"), input.listening);
  if (input.armed === "stop") return armedFooter(locale, x("g.f.stopAct"), input.listening);
  if (input.listening) return micFooter(locale, { tap: x("g.f.stop"), hold: x("g.f.reset") }, "exit");
  if (input.micError) return footer(locale, { tap: x("g.f.retry") }, "exit");
  return footer(locale, { tap: x("g.f.measure"), hold: x("g.f.clearDose") }, "exit");
}

export function cockpitCells(input: CockpitInput): CockpitCell[] {
  const { dose, settings, locale } = input;
  const avg = averageDb(dose);
  const db = (value: number | null): string => (value === null ? DASH : String(Math.round(value)));
  const left = input.listening && input.level !== null ? remainingSeconds(dose, input.level, settings) : null;
  const band = doseLevel(dose);
  return [
    { label: t(locale, "g.cp.max"), value: db(dose.peakDb) },
    { label: t(locale, "g.cp.avg"), value: db(avg) },
    { label: t(locale, "g.cp.limit"), value: String(Math.round(settings.criterionDb)) },
    { label: t(locale, "g.cp.dur"), value: minutesShort(dose.measuredSeconds) },
    { label: t(locale, "g.cp.over", { db: Math.round(settings.criterionDb) }), value: minutesShort(dose.overSeconds), ...(dose.overSeconds > 0 ? { alert: true } : {}) },
    { label: t(locale, "g.cp.left"), value: left === null || band === "exceeded" ? DASH : formatDuration(left, locale).replace(/ /g, "") },
  ];
}

export function levelTone(level: number | null, criterionDb: number): Tone {
  if (level === null) return "offline";
  return level >= criterionDb ? "warn" : "ok";
}

export function doseTone(pct: number): Tone {
  return pct >= 100 ? "critical" : pct >= WARN_PERCENT ? "warn" : "ok";
}

export function cockpitBars(input: CockpitInput): CockpitBar[] {
  const { locale } = input;
  const pct = dosePercent(input.dose.fraction);
  const level = input.listening ? (input.barLevel ?? input.level) : null;
  return [
    {
      label: t(locale, "g.cp.barLevel"),
      value: level === null ? null : meterShare(level),
      text: level === null ? DASH : `${input.calibrated ? "" : "~"}${Math.max(0, Math.round(level))} dB`,
      tone: levelTone(level, input.settings.criterionDb),
      marks: [meterShare(input.settings.criterionDb)],
      ...(input.listening && input.peak !== null && input.peak !== undefined ? { peak: meterShare(input.peak) } : {}),
    },
    {
      label: t(locale, "g.cp.barDose"),
      value: Math.min(100, pct),
      text: `${pct}%`,
      tone: doseTone(pct),
      marks: [WARN_PERCENT],
    },
  ];
}

export function cockpitModel(input: CockpitInput): CockpitModel {
  const { locale } = input;
  const band = doseLevel(input.dose);
  return {
    title: t(locale, "g.title"),
    clock: hhmm(input.now),
    headline: headlineLines(input),
    cells: cockpitCells(input),
    bars: cockpitBars(input),
    caption: input.listening ? t(locale, "g.micOn") : t(locale, input.calibrated ? "g.cp.calibrated" : "g.cp.estimated"),
    hint: hintLine(input),
    tone: input.micError && !input.listening ? "offline" : band === "exceeded" ? "critical" : band === "high" ? "warn" : "ok",
  };
}
