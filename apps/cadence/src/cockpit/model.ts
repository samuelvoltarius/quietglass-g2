import { positionAt, type MetronomeSettings, type MetronomeState } from "../metronome/engine";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { armedFooter, footer } from "../glasses/footer";
import { pendulumSwing, type Swing } from "../glasses/charts";

/**
 * What the cockpit shows, in words and numbers, decided without drawing
 * (QUS v1). compose.ts only lays this out.
 */
export type Tone = "ok" | "warn" | "critical" | "offline";

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  readonly alert?: boolean;
}

/** Left half: the beat dots on top, the pendulum below (null above 120 bpm: then the dots are big), the bar number in the lower tile. */
export interface BeatGraphic {
  readonly kind: "beat";
  /** One entry per beat of the bar; true = lit. */
  readonly dots: readonly boolean[];
  readonly swing: Swing | null;
  readonly center: string;
  readonly sub: string;
}

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  readonly headline: readonly string[];
  readonly cells: readonly CockpitCell[];
  readonly graphic: BeatGraphic;
  readonly caption: string;
  readonly hint: string;
  readonly tone: Tone;
}

export interface CockpitInput {
  readonly state: MetronomeState;
  readonly settings: MetronomeSettings;
  readonly now: number;
  readonly locale: Locale;
  /** The practice item, if any. */
  readonly item?: string;
  /** Seconds the current session has run. */
  readonly sessionSeconds?: number;
  /** A running beat was tapped once; the next tap pauses. */
  readonly armed?: boolean;
  /** Practice logged today (seconds, sessions). */
  readonly todaySeconds?: number;
  readonly todayCount?: number;
  /** Best tempo of the item, if logged. */
  readonly best?: number | null;
}

/** A pause must be confirmed by a second tap within this time (QIS v1, arm then confirm). */
export const ARM_MS = 4_000;

export function hhmm(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function signatureLabel(settings: MetronomeSettings): string {
  return settings.signature.beats + "/" + settings.signature.unit;
}

export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)).trimEnd() + "…";
}

/** Minutes only, so the cell changes once a minute: "0 min", "12 min", "1:05 h". */
export function minutesShort(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} h`;
}

/**
 * Which dots are lit. On the downbeat the whole row lights up; with the
 * marker set to "bar" the other beats stay quiet.
 */
export function beatDots(settings: MetronomeSettings, currentBeat: number, running: boolean): boolean[] {
  const count = Math.max(1, Math.round(settings.signature.beats));
  if (running && currentBeat === 1) return Array.from({ length: count }, () => true);
  return Array.from({ length: count }, (_, index) => running && settings.mark !== "bar" && index + 1 === currentBeat);
}

export type RunWord = "ready" | "running" | "paused" | "armed";

export function runWord(state: MetronomeState, armed: boolean): RunWord {
  if (armed && state.running) return "armed";
  if (state.running) return "running";
  return state.beatsBefore === 0 ? "ready" : "paused";
}

export function cockpitHint(locale: Locale, word: RunWord): string {
  if (word === "armed") return armedFooter(locale, t(locale, "g.a.pause"));
  if (word === "running") return footer(locale, { tap: t(locale, "g.a.pauseShort"), swipe: t(locale, "g.a.tempo"), hold: t(locale, "g.a.top") }, "exit");
  return footer(locale, { tap: t(locale, "g.a.start"), swipe: t(locale, "g.a.tempo") }, "exit");
}

export function cockpitCells(input: CockpitInput): CockpitCell[] {
  const { settings, locale } = input;
  const dash = "–";
  return [
    { label: t(locale, "g.cp.sig"), value: signatureLabel(settings) },
    { label: t(locale, "g.cp.mark"), value: t(locale, settings.mark === "bar" ? "g.cp.markBar" : "g.cp.markBeat") },
    { label: t(locale, "g.cp.today"), value: minutesShort(input.todaySeconds ?? 0) },
    { label: t(locale, "g.cp.time"), value: input.sessionSeconds !== undefined && input.sessionSeconds > 0 ? minutesShort(input.sessionSeconds) : dash },
    { label: t(locale, "g.cp.best"), value: input.best ? String(input.best) : dash },
    { label: t(locale, "g.cp.sessions"), value: String(input.todayCount ?? 0) },
  ];
}

export function cockpitModel(input: CockpitInput): CockpitModel {
  const { state, settings, now, locale } = input;
  const word = runWord(state, input.armed === true);
  const position = positionAt(state, settings, now);
  return {
    title: t(locale, "g.title"),
    clock: hhmm(now),
    headline: [t(locale, "g.cp.bpm", { bpm: settings.bpm }), t(locale, `g.cp.${word}`)],
    cells: cockpitCells(input),
    graphic: {
      kind: "beat",
      dots: beatDots(settings, position.beat, state.running),
      swing: pendulumSwing(state, settings, now),
      center: String(position.bar),
      sub: t(locale, "g.cp.bar"),
    },
    caption: input.item ? truncate(input.item, 24) : t(locale, "g.cp.noItem"),
    hint: cockpitHint(locale, word),
    tone: word === "armed" ? "warn" : state.running ? "ok" : "offline",
  };
}
