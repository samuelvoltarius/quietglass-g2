import {
  doseLevel, formatDuration, remainingSeconds, type DoseSettings, type DoseState,
} from "../noise/dose";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { fitView } from "./fit";
import { armedFooter, footer, micFooter } from "./footer";

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
  /**
   * A risky action waits for its confirming tap (QIS v1 section 2): `reset` = a hold asked to clear
   * today's dose, `stop` = a tap asked to stop measuring. A second single tap within 4 s carries it out.
   */
  readonly armed?: "reset" | "stop" | null;
  /** Zero-based help page, or null/undefined when the help is closed. */
  readonly helpPage?: number | null;
}

/** Pages of the help. */
export const HELP_PAGES = 2;

export function buildView(
  dose: DoseState,
  settings: DoseSettings,
  options: ViewOptions,
): NoiseView {
  const locale = options.locale ?? "en";
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);

  // The help page replaces the readout; the microphone indicator stays in the footer while it is open.
  if (options.helpPage !== null && options.helpPage !== undefined) {
    const page = Math.min(HELP_PAGES, Math.max(1, options.helpPage + 1));
    return fitView({
      header: x("g.h.help", { page, pages: HELP_PAGES }),
      body: [1, 2, 3].map((row) => x(`g.help.${page}.${row}`)),
      footer: options.listening
        ? micFooter(locale, { swipe: x("g.f.page") }, "back")
        : footer(locale, { swipe: x("g.f.page") }, "back"),
    });
  }

  // The question replaces the readout's gesture line; the microphone indicator stays in front.
  if (options.armed === "reset") {
    return fitView({
      header: x("g.h.armed"),
      body: [x("g.armed.1"), x("g.armed.2")],
      footer: armedFooter(locale, x(options.listening ? "g.f.clear" : "g.f.clearDose"), options.listening === true),
    });
  }
  if (options.armed === "stop") {
    return fitView({
      header: x("g.h.armedStop"),
      body: [x("g.armedStop.1"), x("g.armedStop.2")],
      footer: armedFooter(locale, x("g.f.stopAct"), options.listening === true),
    });
  }
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
        header: x("g.h.micError"),
        body: [x("g.micError1"), x("g.micError2"), x("g.micError3")],
        footer: footer(locale, { tap: x("g.f.retry") }, "exit"),
      };
    }
    return {
      header: x("g.h.idle"),
      body: [
        dose.fraction > 0 ? x("g.idleDose", { pct: percent(dose.fraction) }) : x("g.idle"),
        x("g.hintHelp"),
        ...(options.calibrated ? [] : [x("g.estimated")]),
      ],
      footer: footer(locale, { tap: x("g.f.measure"), hold: x("g.f.clearDose") }, "exit"),
    };
  }

  const band = doseLevel(dose);
  const level = options.level;

  // The level itself is a picture of big digits (digits.ts), not a text row.
  const body: string[] = [];

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
    footer: micFooter(locale, { tap: x("g.f.stop"), hold: x("g.f.reset") }, "exit"),
  };
}

function headerFor(band: ReturnType<typeof doseLevel>, locale: Locale): string {
  switch (band) {
    case "exceeded": return t(locale, "g.h.full");
    case "high": return t(locale, "g.h.high");
    default: return t(locale, "g.h.listening");
  }
}

export function percent(fraction: number): string {
  return Math.round(Math.min(fraction, 9.99) * 100) + "%";
}
