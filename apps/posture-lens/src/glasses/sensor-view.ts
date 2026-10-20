import { AXES, fmt2, guideStep, GUIDE_STEPS, mostChangedAxis, recordingDone, sampleRate, type Recording, type SensorStats } from "../imu/diagnostics";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { fitView } from "./fit";
import { footer as footerLine, leadFooter } from "./footer";
import type { TextView } from "./page";

export interface SensorViewOptions {
  readonly locale: Locale;
  /** The SDK pace value currently requested (100…1000, unit unknown). */
  readonly pace: number;
  readonly recording: Recording | null;
  readonly sensorOff?: boolean;
}

/**
 * The sensor test on the glasses: raw x / y / z with min/max since start,
 * magnitude and rate in the header, the axis that moved most marked with ●.
 * Updated only through text upgrades (the caller throttles to ~5 per second).
 */
export function buildSensorView(stats: SensorStats, options: SensorViewOptions, now = Date.now()): TextView {
  return fitView(composeSensorView(stats, options, now));
}

/** Before the safety cut; the budget test checks it never needs one. */
export function composeSensorView(stats: SensorStats, options: SensorViewOptions, now = Date.now()): TextView {
  const { locale } = options;
  const rate = sampleRate(stats.recent, now);
  const header = t(locale, "s.header", {
    pace: options.pace,
    hz: rate === null ? "--" : rate.toFixed(1),
    mag: fmt2(stats.lastMagnitude),
  });

  const body = stats.last === null
    ? [t(locale, options.sensorOff ? "s.noSensor" : "s.waiting")]
    : AXES.map((axis) => {
      const range = stats.range?.[axis];
      const marker = mostChangedAxis(stats) === axis ? " ●" : "";
      return `${axis} ${pad(fmt2(stats.last![axis]))}  min ${pad(fmt2(range?.min))} max ${pad(fmt2(range?.max))}${marker}`;
    });

  let footer: string;
  const rec = options.recording;
  if (rec && !recordingDone(rec, now)) {
    const elapsed = now - rec.startedAt;
    const step = GUIDE_STEPS[guideStep(elapsed)]!;
    footer = leadFooter(locale, t(locale, "s.recFooter", { s: Math.ceil((rec.durationMs - elapsed) / 1000), step: t(locale, step.key) }), {}, "back");
  } else {
    footer = footerLine(locale, { tap: t(locale, "g.w.minmax") }, "back");
  }
  return { header, body, footer };
}

/** Right-aligns numbers to 6 characters so the columns stay put while they change. */
function pad(text: string): string {
  return text.padStart(6, " ");
}
