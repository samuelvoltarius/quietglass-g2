import {
  doseLevel, formatDuration, remainingSeconds, type DoseSettings, type DoseState,
} from "../noise/dose";

/**
 * What the glasses show.
 *
 * Two rules govern this display:
 *
 * 1. **The microphone indicator is never optional.** Whenever the mic is on,
 *    the display says so. There is no code path that measures silently.
 * 2. **Quiet costs no attention.** Below the threshold the readout is a single
 *    line. It grows only as the dose does.
 */
export interface NoiseView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

/** Shown whenever the microphone is open. Not suppressible. */
const MIC_ON = "● MIC";

export interface ViewOptions {
  readonly listening: boolean;
  /** Approximate SPL after calibration, or null before any audio arrives. */
  readonly level: number | null;
  readonly calibrated: boolean;
}

export function buildView(
  dose: DoseState,
  settings: DoseSettings,
  options: ViewOptions,
): NoiseView {
  if (!options.listening) {
    return {
      header: "DecibelGuard",
      body: [
        "Not listening.",
        options.calibrated ? "Tap to start measuring." : "Tap to start. Calibrate on the phone for absolute levels.",
      ],
      footer: dose.fraction > 0
        ? "dose " + percent(dose.fraction) + "  ·  tap = resume"
        : "tap = start",
    };
  }

  const band = doseLevel(dose);
  const level = options.level;

  const body: string[] = [];
  body.push(levelLine(level, options.calibrated));

  if (band !== "quiet") {
    body.push("dose " + percent(dose.fraction));
    const left = level === null ? null : remainingSeconds(dose, level, settings);
    if (left !== null && band !== "exceeded") {
      body.push(formatDuration(left) + " left at this level");
    }
  }

  return {
    header: headerFor(band),
    body,
    footer: MIC_ON + "  ·  tap = stop  ·  hold = reset",
  };
}

function headerFor(band: ReturnType<typeof doseLevel>): string {
  switch (band) {
    case "exceeded": return "DAILY DOSE REACHED";
    case "high": return "HALFWAY";
    default: return "";
  }
}

function levelLine(level: number | null, calibrated: boolean): string {
  if (level === null) return "listening…";
  const rounded = Math.round(level);
  // Uncalibrated readings are marked, so a number is never mistaken for an
  // absolute sound pressure level it is not.
  return calibrated ? rounded + " dB" : rounded + " dB (uncal.)";
}

export function percent(fraction: number): string {
  return Math.round(Math.min(fraction, 9.99) * 100) + "%";
}
