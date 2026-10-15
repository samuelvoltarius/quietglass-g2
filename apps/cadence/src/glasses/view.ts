import { positionAt, type MetronomeSettings, type MetronomeState } from "../metronome/engine";
import { formatDuration } from "../practice/log";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { fitView } from "./fit";
import { armedFooter, footer } from "./footer";

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

/**
 * Wider spacing makes the row readable in peripheral vision. Few beats get a
 * wide gap so the row spans the display instead of hugging the left edge; a
 * long bar (12/8, 7/4) stays tight enough to fit.
 */
export function gapFor(count: number): string {
  return " ".repeat(count <= 4 ? 8 : count <= 6 ? 6 : count <= 9 ? 4 : 2);
}

export interface ViewOptions {
  /** What is being practised right now, if anything. */
  readonly item?: string;
  /** Seconds the current practice session has run. */
  readonly sessionSeconds?: number;
  /** Language for every line; English when omitted. */
  readonly locale?: Locale;
  /** A running beat was tapped once: the next tap pauses it (QIS v1, arm then confirm). */
  readonly armed?: boolean;
  /** The help page is open. */
  readonly help?: boolean;
}

/** A pause must be confirmed by a second tap within this time (QIS v1). */
export const ARM_MS = 4_000;

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
  const head = (stateKey: string): string => t(locale, "g.title") + " · " + t(locale, stateKey);

  if (options.help) {
    return {
      header: head("g.s.help"),
      body: [1, 2, 3, 4].map((n) => t(locale, "g.help." + n)),
      footer: footer(locale, {}, "back"),
    };
  }

  // Never started yet: one sentence saying what to do.
  const fresh = !state.running && state.beatsBefore === 0;
  const armed = options.armed === true && state.running;
  // What is being practised and for how long; the user's own item text is cut so it cannot wrap.
  const timed = options.sessionSeconds !== undefined && options.sessionSeconds > 0;
  const practice = [
    ...(options.item ? [truncate(options.item, 30)] : []),
    ...(timed ? [formatDuration(options.sessionSeconds ?? 0, locale)] : []),
  ].join(" · ");

  return {
    header: head(armed ? "g.s.armed" : state.running ? "g.s.running" : fresh ? "g.s.ready" : "g.s.paused"),
    body: [
      beatRow(settings, position.beat, state.running),
      t(locale, "g.info", { bpm: settings.bpm, sig: signatureLabel(settings), bar: position.bar }),
      ...(practice === "" ? [] : [practice]),
      ...(fresh ? [t(locale, "g.first")] : []),
    ],
    footer: armed
      ? armedFooter(locale, t(locale, "g.a.pause"))
      : state.running
        ? footer(locale, { tap: t(locale, "g.a.pauseShort"), swipe: t(locale, "g.a.tempo"), hold: t(locale, "g.a.top") }, "exit")
        : footer(locale, { tap: t(locale, "g.a.start"), swipe: t(locale, "g.a.tempo"), hold: t(locale, "g.a.help") }, "exit"),
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
  const GAP = gapFor(count);

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

export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)).trimEnd() + "…";
}

export function signatureLabel(settings: MetronomeSettings): string {
  return settings.signature.beats + "/" + settings.signature.unit;
}
