import { heldSeconds, uprightShare, type PostureMonitor, type PostureSettings } from "../posture/monitor";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { armedFooter, footer } from "../glasses/footer";

/**
 * What the cockpit shows, in words and numbers, decided without drawing
 * (QUS v1). compose.ts only lays this out.
 *
 * The governing rule: good posture costs no attention. Upright, the headline
 * is one calm word and the gauge needle stays away (unless the wearer asked to
 * see the angle); it becomes prominent only when something needs to change.
 */
export type Tone = "ok" | "warn" | "critical" | "offline";

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  readonly alert?: boolean;
}

/** Left half: a dial from 0° (left) to 60° (right), the warning angle marked, a needle, and the angle as a big number below. */
export interface GaugeGraphic {
  readonly kind: "gauge";
  /** Quantised degrees for the needle, or null (no needle). */
  readonly angle: number | null;
  readonly warnAngle: number;
  /** Leaning or warned: bright. */
  readonly alert: boolean;
  readonly center: string;
  readonly sub: string;
}

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  readonly headline: readonly string[];
  readonly cells: readonly CockpitCell[];
  readonly graphic: GaugeGraphic;
  readonly caption: string;
  readonly hint: string;
  readonly tone: Tone;
}

export interface CockpitInput {
  readonly monitor: PostureMonitor;
  readonly settings: PostureSettings;
  readonly locale: Locale;
  readonly now: number;
  /** Show the live angle even while upright. */
  readonly showAngleWhenGood?: boolean;
  /** True for a few seconds after a calibration, so the calm display is not mistaken for a fault. */
  readonly justCalibrated?: boolean;
  /** The glasses refused IMU reporting. */
  readonly sensorOff?: boolean;
  /** Overwriting the saved posture waits for a second tap. */
  readonly confirm?: "calibrate" | null;
  /** The angle for the big number (whole degrees) and for the needle (2° steps), already quantised by the caller. */
  readonly digitsAngle?: number | null;
  readonly gaugeAngle?: number | null;
}

export function hhmm(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const DASH = "–";

/** "45 s", "2 min", "2 min 5 s" (the phone has room for the seconds). */
export function formatDuration(totalSeconds: number, locale: Locale = "en"): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return t(locale, "u.s", { s: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? t(locale, "u.m", { m: minutes }) : t(locale, "u.ms", { m: minutes, s: rest });
}

/** "45 s", "2 min" - short enough for a cell. */
export function shortTime(totalSeconds: number, locale: Locale): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return t(locale, "u.s", { s: seconds });
  const minutes = Math.floor(seconds / 60);
  return t(locale, "u.m", { m: minutes });
}

/** Minutes only, so the cell changes once a minute. */
export function minutesShort(seconds: number, locale: Locale): string {
  return t(locale, "u.m", { m: Math.floor(Math.max(0, seconds) / 60) });
}

export type PostureWord = "new" | "saved" | "resave" | "good" | "leaning" | "warned" | "off";

/** Which statement the headline makes. */
export function postureWord(input: CockpitInput): PostureWord {
  if (input.sensorOff) return "off";
  if (input.confirm === "calibrate") return "resave";
  switch (input.monitor.state) {
    case "uncalibrated": return "new";
    case "leaning": return "leaning";
    case "warned": return "warned";
    default: return input.justCalibrated ? "saved" : "good";
  }
}

const HEADLINES: Record<PostureWord, readonly string[]> = {
  new: ["g.cp.new1", "g.cp.new2"], saved: ["g.cp.saved"], resave: ["g.cp.resave1", "g.cp.resave2"],
  good: ["g.cp.good"], leaning: ["g.cp.leaning"], warned: ["g.cp.warned1", "g.cp.warned2"], off: ["g.cp.off1", "g.cp.off2"],
};

export function headlineLines(input: CockpitInput): string[] {
  return HEADLINES[postureWord(input)].map((key) => t(input.locale, key));
}

export function cockpitHint(input: CockpitInput): string {
  const { locale } = input;
  if (input.confirm === "calibrate" && !input.sensorOff) return armedFooter(locale, t(locale, "g.a.resave"));
  if (input.sensorOff) return footer(locale, {}, "exit");
  const tap = t(locale, input.monitor.state === "uncalibrated" ? "g.w.save" : "g.w.resave");
  return footer(locale, { tap, swipe: t(locale, "g.w.menu") }, "exit");
}

/** Seconds until the warning, in 5 s steps rounded up (the cell changes at most every 5 s), or null when not leaning. */
export function warningIn(input: CockpitInput): number | null {
  const held = heldSeconds(input.monitor, input.now);
  if (held === null || input.monitor.state === "warned") return null;
  const remaining = Math.max(0, input.settings.sustainSeconds - held);
  return Math.ceil(remaining / 5) * 5;
}

export function cockpitCells(input: CockpitInput): CockpitCell[] {
  const { monitor, settings, locale } = input;
  const share = uprightShare(monitor);
  const left = warningIn(input);
  const held = heldSeconds(monitor, input.now);
  return [
    { label: t(locale, "g.cp.limit"), value: t(locale, "g.cp.angle", { deg: Math.round(settings.warnAngle) }) },
    { label: t(locale, "g.cp.share"), value: share === null ? DASH : `${Math.round(share * 100)}%` },
    { label: t(locale, "g.cp.lean"), value: minutesShort(monitor.leaningSeconds, locale) },
    { label: t(locale, "g.cp.in"), value: left === null ? DASH : t(locale, "u.s", { s: left }) },
    { label: t(locale, "g.cp.held"), value: held === null ? DASH : shortTime(Math.floor(held / 5) * 5, locale), ...(monitor.state === "warned" ? { alert: true } : {}) },
    { label: t(locale, "g.cp.sensor"), value: t(locale, input.sensorOff ? "g.cp.sensorOff" : "g.cp.sensorOk"), ...(input.sensorOff ? { alert: true } : {}) },
  ];
}

export function cockpitModel(input: CockpitInput): CockpitModel {
  const { monitor, locale } = input;
  const calibrated = monitor.reference !== null && !input.sensorOff;
  const alert = monitor.state === "leaning" || monitor.state === "warned";
  // Good posture costs no attention: the angle only shows while it matters (or when asked for).
  const show = calibrated && (alert || (input.showAngleWhenGood === true && monitor.angle !== null));
  const digits = input.digitsAngle ?? (monitor.angle === null ? null : Math.round(monitor.angle));
  const needle = show ? (input.gaugeAngle ?? monitor.angle) : null;
  return {
    title: t(locale, "g.title"),
    clock: hhmm(input.now),
    headline: headlineLines(input),
    cells: cockpitCells(input),
    graphic: {
      kind: "gauge",
      angle: needle,
      warnAngle: input.settings.warnAngle,
      alert,
      center: show && digits !== null ? t(locale, "g.cp.angle", { deg: Math.max(0, digits) }) : calibrated ? t(locale, "g.cp.ok") : DASH,
      sub: t(locale, show ? "g.cp.subAngle" : "g.cp.subPosture"),
    },
    caption: t(locale, calibrated ? "g.cp.calibrated" : "g.cp.notCalibrated"),
    hint: cockpitHint(input),
    tone: input.sensorOff ? "offline" : monitor.state === "warned" ? "critical" : monitor.state === "leaning" ? "warn" : monitor.state === "uncalibrated" ? "offline" : "ok",
  };
}
