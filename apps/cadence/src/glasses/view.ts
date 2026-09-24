import { positionAt, type MetronomeSettings, type MetronomeState } from "../metronome/engine";
import { formatDuration } from "../practice/log";

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
const ACCENT = "◆"; // ◆ — the downbeat, distinguishable at a glance

/** Wider spacing makes the row readable in peripheral vision. */
const GAP = "  ";

export interface ViewOptions {
  /** What is being practised right now, if anything. */
  readonly item?: string;
  /** Seconds the current practice session has run. */
  readonly sessionSeconds?: number;
}

export function buildView(
  state: MetronomeState,
  settings: MetronomeSettings,
  options: ViewOptions = {},
  now = Date.now(),
): CadenceView {
  const position = positionAt(state, settings, now);

  return {
    header: options.item ?? "Cadence",
    body: [
      beatRow(settings, position.beat, state.running),
      String(settings.bpm) + " bpm" + GAP + signatureLabel(settings) + GAP + "bar " + position.bar,
    ],
    footer: footerText(state, options),
  };
}

/**
 * A marker per beat in the bar. The downbeat keeps its own shape so the top of
 * the bar is identifiable without counting from the left.
 */
export function beatRow(
  settings: MetronomeSettings,
  currentBeat: number,
  running: boolean,
): string {
  const count = Math.max(1, Math.round(settings.signature.beats));
  const markers: string[] = [];

  for (let beat = 1; beat <= count; beat++) {
    const isCurrent = running && beat === currentBeat;
    if (beat === 1) {
      markers.push(isCurrent ? ACCENT : HOLLOW);
    } else if (settings.mark === "bar") {
      // Marking only the bar: the other beats stay as quiet placeholders.
      markers.push(HOLLOW);
    } else {
      markers.push(isCurrent ? FILLED : HOLLOW);
    }
  }

  return markers.join(GAP);
}

export function signatureLabel(settings: MetronomeSettings): string {
  return settings.signature.beats + "/" + settings.signature.unit;
}

function footerText(state: MetronomeState, options: ViewOptions): string {
  const parts: string[] = [];
  parts.push(state.running ? "running" : "paused");

  if (options.sessionSeconds !== undefined && options.sessionSeconds > 0) {
    parts.push(formatDuration(options.sessionSeconds));
  }

  parts.push(state.running ? "tap = pause" : "tap = start");
  return parts.join("  ·  ");
}
