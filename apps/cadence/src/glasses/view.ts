import { positionAt, type MetronomeSettings, type MetronomeState } from "../metronome/engine";
import { formatDuration } from "../practice/log";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { fitView, LINE_COLS } from "./fit";

/**
 * What the glasses show.
 *
 * The beat has to be readable at a glance while both hands are on an
 * instrument, so it is a row of large markers rather than a number. Everything
 * else is small.
 */
export interface CadenceView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

const FILLED = "●"; // ●
const HOLLOW = "○"; // ○

/** Wider spacing makes the row readable in peripheral vision. */
const GAP = "  ";

export interface ViewOptions {
  /** What is being practised right now, if anything. */
  readonly item?: string;
  /** Seconds the current practice session has run. */
  readonly sessionSeconds?: number;
  /** Language for every line; English when omitted. */
  readonly locale?: Locale;
}

export function buildView(
  state: MetronomeState,
  settings: MetronomeSettings,
  options: ViewOptions = {},
  now = Date.now(),
): CadenceView {
  return fitView(composeView(state, settings, options, now));
}

/** The view before the safety cut; tests check it never needs one. */
export function composeView(
  state: MetronomeState,
  settings: MetronomeSettings,
  options: ViewOptions = {},
  now = Date.now(),
): CadenceView {
  const position = positionAt(state, settings, now);
  const locale = options.locale ?? "en";
  // Never started yet: one sentence saying what to do.
  const fresh = !state.running && state.beatsBefore === 0;

  return {
    // The item is the user's own text; a long one must not wrap into the body.
    header: truncate(options.item ?? t(locale, "g.title"), HEADER_WIDTH),
    body: [
      beatRow(settings, position.beat, state.running),
      t(locale, "g.info", { bpm: settings.bpm, sig: signatureLabel(settings), bar: position.bar }),
      ...(fresh ? ["", t(locale, "g.first")] : []),
    ],
    footer: footerText(state, options, locale),
  };
}

/**
 * A marker per beat in the bar. On the downbeat the whole row lights up, so the
 * top of the bar is visible out of the corner of the eye without counting from
 * the left. (A separate accent glyph is not used: the G2 font is not verified
 * to draw one.)
 */
export function beatRow(
  settings: MetronomeSettings,
  currentBeat: number,
  running: boolean,
): string {
  const count = Math.max(1, Math.round(settings.signature.beats));
  const markers: string[] = [];

  if (running && currentBeat === 1) return Array.from({ length: count }, () => FILLED).join(GAP);

  for (let beat = 1; beat <= count; beat++) {
    const isCurrent = running && beat === currentBeat;
    if (settings.mark === "bar") {
      // Marking only the bar: the other beats stay as quiet placeholders.
      markers.push(HOLLOW);
    } else {
      markers.push(isCurrent ? FILLED : HOLLOW);
    }
  }

  return markers.join(GAP);
}

/** Characters that fit one header line on the 576 px display. */
const HEADER_WIDTH = LINE_COLS;

export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)).trimEnd() + "…";
}

export function signatureLabel(settings: MetronomeSettings): string {
  return settings.signature.beats + "/" + settings.signature.unit;
}

function footerText(state: MetronomeState, options: ViewOptions, locale: Locale): string {
  const parts: string[] = [];
  parts.push(t(locale, state.running ? "g.running" : "g.paused"));

  const timed = options.sessionSeconds !== undefined && options.sessionSeconds > 0;
  if (timed) parts.push(formatDuration(options.sessionSeconds ?? 0, locale));

  parts.push(t(locale, state.running ? "g.tapPause" : "g.tapStart"));
  // The swipe hint goes where there is room; the session clock wins otherwise.
  if (!timed) parts.push(t(locale, "g.swipeTempo"));
  return parts.join(" · ");
}
