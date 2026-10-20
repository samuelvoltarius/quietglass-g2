import type { Locale } from "../i18n";
import { t } from "../messages";
import type { Inspection, Severity } from "../log/entries";
import type { SttStatus } from "../stt/provider";
import { footer } from "../glasses/footer";
import type { FieldNotice, LiveView, Phase } from "../glasses/view";

/**
 * What the Field Log cockpit shows (QUS v1): the headline, the label/value
 * cells, the graphic on the left, the caption and the one hint line - decided
 * without drawing. compose.ts only lays this out.
 *
 *   BEREIT / AUFNAHME 0:42 / WIRD ERKANNT      cells: HEUTE  LETZTE  SYNC / LÄNGE
 *   left: a ring of the notes (resting) or the level history (recording)
 */

export type Tone = "ok" | "warn" | "critical" | "offline";

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  /** Drawn with a frame round it (something is wrong here). */
  readonly alert?: boolean;
}

export type CockpitGraphic =
  /** A ring of one segment per recent note (tone = type); the centre names a count. */
  | { readonly kind: "ring"; readonly segments: readonly Tone[]; readonly center: string; readonly sub: string }
  /** The microphone level of the last seconds, newest on the right, 0..1 each. */
  | { readonly kind: "wave"; readonly levels: readonly number[]; readonly center: string };

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  /** One line, already upper case. */
  readonly headline: readonly string[];
  readonly cells: readonly CockpitCell[];
  readonly graphic: CockpitGraphic;
  readonly caption: string;
  /** The one footer line with the gestures. */
  readonly hint: string;
  readonly tone: Tone;
}

export interface CockpitInput {
  /** `idle` (ready), `recording` or `transcribing`. */
  readonly phase: Phase;
  readonly inspections: readonly Inspection[];
  readonly active: Inspection | null;
  readonly now: number;
  readonly locale: Locale;
  readonly severity: Severity;
  readonly voice: boolean;
  readonly demo: boolean;
  readonly status: SttStatus;
  readonly live: LiveView;
  readonly notice: FieldNotice | null;
  /** How long the microphone has been on (recording). */
  readonly elapsedMs: number;
  /** Length of the last finished recording, if there was one. */
  readonly lastLengthMs: number | null;
  /** Microphone level history, 0..1, newest last. */
  readonly levels: readonly number[];
}

const DASH = "–";

/** "HH:MM" of an epoch ms in the phone's time (24 h). */
export function hhmm(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Recording time as m:ss. */
export function clockLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

/** Entries made today, over every inspection. */
export function notesToday(inspections: readonly Inspection[], now: number): number {
  return inspections.reduce((sum, inspection) => sum + inspection.entries.filter((entry) => sameDay(entry.at, now)).length, 0);
}

/** The newest entry's time over every inspection, or null. */
export function lastNoteAt(inspections: readonly Inspection[]): number | null {
  let best: number | null = null;
  for (const inspection of inspections) for (const entry of inspection.entries) if (best === null || entry.at > best) best = entry.at;
  return best;
}

const toneOfSeverity = (severity: Severity): Tone => (severity === "major" ? "critical" : severity === "minor" ? "warn" : "ok");

/** The headline: one statement. A notice (something did not happen) takes its place. */
export function headlineFor(input: Pick<CockpitInput, "phase" | "locale" | "notice" | "status" | "voice" | "elapsedMs">): string[] {
  const { locale } = input;
  if (input.phase === "recording") return [t(locale, "g.cp.rec", { time: clockLabel(input.elapsedMs) })];
  if (input.phase === "transcribing") return [t(locale, "g.cp.recognizing")];
  if (input.notice === "micDenied") return [t(locale, "g.cp.micDenied")];
  if (input.notice === "heardNothing") return [t(locale, "g.cp.heardNothing")];
  if (input.notice === "noPhoto") return [t(locale, "g.cp.noPhoto")];
  if (input.voice && input.status === "error") return [t(locale, "g.cp.serverError")];
  return [t(locale, "g.cp.ready")];
}

/** What the SYNC cell says: where the words come from. */
export function syncCell(input: Pick<CockpitInput, "phase" | "locale" | "voice" | "demo" | "status" | "live">): CockpitCell {
  const { locale } = input;
  const label = t(locale, "g.cp.sync");
  if (input.demo) return { label, value: t(locale, "g.cp.syncDemo") };
  if (!input.voice) return { label, value: t(locale, "g.cp.syncLocal") };
  if (input.status === "error") return { label, value: t(locale, "g.cp.syncError"), alert: true };
  if (input.phase === "recording") {
    if (input.live === "live") return { label, value: t(locale, "g.cp.syncLive") };
    if (input.live === "lost") return { label, value: t(locale, "g.cp.syncFile"), alert: true };
    if (input.live === "connecting") return { label, value: "…" };
  }
  return { label, value: t(locale, "g.cp.syncServer") };
}

/** The four cells: notes today, the time of the last one, where the words come from, the length of the recording. */
export function cockpitCells(input: CockpitInput): CockpitCell[] {
  const { locale, now } = input;
  const last = lastNoteAt(input.inspections);
  const length = input.phase === "recording" ? input.elapsedMs : input.lastLengthMs;
  return [
    { label: t(locale, "g.cp.today"), value: String(notesToday(input.inspections, now)) },
    { label: t(locale, "g.cp.last"), value: last === null ? DASH : hhmm(last) },
    syncCell(input),
    { label: t(locale, "g.cp.length"), value: length === null ? DASH : clockLabel(length) },
  ];
}

/** The ring of the resting screen: the last notes of the walk, one segment each. */
export function restGraphic(input: CockpitInput): CockpitGraphic {
  const entries = input.active?.entries ?? [];
  return {
    kind: "ring",
    segments: entries.slice(-12).map((entry) => toneOfSeverity(entry.severity)),
    center: String(entries.length),
    sub: t(input.locale, "g.cp.walk"),
  };
}

/** The hint line: only the gestures that do something here. */
export function cockpitHint(input: Pick<CockpitInput, "phase" | "locale" | "status" | "voice">): string {
  const { locale } = input;
  if (input.phase === "recording") return footer(locale, { tap: t(locale, "g.w.done") }, null);
  if (input.phase === "transcribing") return statusHint(input.status, locale);
  return footer(locale, { tap: t(locale, "g.w.speak") }, "back");
}

/** While the text is being recognised no gesture does anything: the hint says how far it is. */
export function statusHint(status: SttStatus, locale: Locale): string {
  switch (status) {
    case "connecting": return t(locale, "g.status.connecting");
    case "reconnecting": return t(locale, "g.status.reconnecting");
    case "error": return t(locale, "g.status.error");
    default: return t(locale, "g.status.working");
  }
}

export function cockpitModel(input: CockpitInput): CockpitModel {
  const { locale } = input;
  const recording = input.phase === "recording";
  const transcribing = input.phase === "transcribing";
  const sevWord = t(locale, "g.sev." + input.severity);
  const graphic: CockpitGraphic = recording
    ? { kind: "wave", levels: input.levels, center: clockLabel(input.elapsedMs) }
    : transcribing
      ? { kind: "ring", segments: [], center: "…", sub: "" }
      : restGraphic(input);
  const alert = input.notice !== null || (input.voice && input.status === "error");
  return {
    title: t(locale, "g.title"),
    clock: hhmm(input.now),
    headline: headlineFor(input),
    cells: cockpitCells(input),
    graphic,
    caption: t(locale, "g.cp.type", { severity: sevWord }),
    hint: cockpitHint(input),
    tone: recording ? "critical" : alert ? "warn" : "ok",
  };
}

/** A key that changes exactly when what the cockpit would draw changes (tests; the tile sender dedupes on pixels). */
export function modelKey(model: CockpitModel): string {
  return JSON.stringify([model.clock, model.headline, model.cells, model.graphic, model.caption, model.hint]);
}

/** Quantises a 0..1 level to `steps` stages, so the picture changes only when the level really moves. */
export function quantizeLevel(level: number, steps = 6): number {
  return Math.round(Math.max(0, Math.min(1, level)) * steps) / steps;
}

/** Microphone level of a block of 16-bit little-endian PCM, 0..1 (RMS, scaled so speech fills the bar). */
export function pcmLevel(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let i = 0; i < samples; i += 1) { const value = view.getInt16(i * 2, true) / 32768; sum += value * value; }
  return Math.min(1, Math.sqrt(sum / samples) * 4);
}

/** How many past seconds the level history keeps. */
export const LEVEL_HISTORY = 20;

/** Appends a level, keeping the last LEVEL_HISTORY. */
export function pushLevel(levels: readonly number[], level: number): number[] {
  return [...levels, quantizeLevel(level)].slice(-LEVEL_HISTORY);
}
