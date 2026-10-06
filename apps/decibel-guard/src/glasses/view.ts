import {
  doseLevel, formatDuration, remainingSeconds, type DoseSettings, type DoseState,
} from "../noise/dose";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { fitView } from "./fit";

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

export interface ViewOptions {
  readonly listening: boolean;
  /** Approximate SPL (calibrated or estimated), or null before any audio arrives. */
  readonly level: number | null;
  readonly calibrated: boolean;
  /** Language for every line; English when omitted. */
  readonly locale?: Locale;
  /** The last attempt to open the microphone was refused. */
  readonly micError?: boolean;
}

export function buildView(
  dose: DoseState,
  settings: DoseSettings,
  options: ViewOptions,
): NoiseView {
  return fitView(composeView(dose, settings, options));
}

/** The view before the safety cut; tests check it never needs one. */
export function composeView(dose: DoseState, settings: DoseSettings, options: ViewOptions): NoiseView {
  const locale = options.locale ?? "en";
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);

  if (!options.listening) {
    // A refused microphone is not a dead end: say what to try, and a tap retries.
    if (options.micError) {
      return {
        header: x("g.title"),
        body: [x("g.micError1"), x("g.micError2"), x("g.micError3")],
        footer: x("g.footerRetry"),
      };
    }
    return {
      header: x("g.title"),
      body: [
        x("g.idle"),
        x("g.tapToStart"),
        ...(options.calibrated ? [] : [x("g.estimated")]),
      ],
      footer: dose.fraction > 0
        ? x("g.footerResume", { pct: percent(dose.fraction) })
        : x("g.footerStart"),
    };
  }

  const band = doseLevel(dose);
  const level = options.level;

  const body: string[] = [];
  body.push(levelLine(level, options.calibrated, locale));

  if (band !== "quiet") {
    body.push(x("g.dose", { pct: percent(dose.fraction) }));
    const left = level === null ? null : remainingSeconds(dose, level, settings);
    if (left !== null && band !== "exceeded") {
      body.push(x("g.left", { time: formatDuration(left, locale) }));
    }
    if (band === "high") body.push(x("g.adviceHigh"));
    if (band === "exceeded") body.push(x("g.adviceFull"));
  }

  return {
    header: headerFor(band, locale),
    body,
    // The microphone indicator is part of this one footer string and has no
    // code path without it.
    footer: x("g.footerListening"),
  };
}

function headerFor(band: ReturnType<typeof doseLevel>, locale: Locale): string {
  switch (band) {
    case "exceeded": return t(locale, "g.headerFull");
    case "high": return t(locale, "g.headerHigh");
    default: return "";
  }
}

function levelLine(level: number | null, calibrated: boolean, locale: Locale): string {
  if (level === null) return t(locale, "g.listening");
  const rounded = Math.round(level);
  // Estimated readings are marked, so a number is never mistaken for an
  // absolute sound pressure level it is not.
  return t(locale, calibrated ? "g.level" : "g.levelEstimate", { db: rounded });
}

export function percent(fraction: number): string {
  return Math.round(Math.min(fraction, 9.99) * 100) + "%";
}
