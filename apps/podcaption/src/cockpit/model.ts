import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import { footer } from "../glasses/footer";
import { SOURCE_TAG, progress, type PodState } from "../glasses/view";
import { formatTime } from "../podcast/view";
import { hhmm, type CockpitCell, type CockpitGraphic, type CockpitModel, type Tone } from "./compose";

/**
 * What the calm status cockpit shows, in words and numbers, decided without
 * drawing (QUS v1): the headline (playing or paused), the label/value cells,
 * the graphic for the left half (a ring filled to the progress through the
 * captions), the caption (the episode) and the hint line.
 */

const t = (locale: Locale, key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
const DASH = "–";

export function statusTone(state: Pick<PodState, "playing">): Tone {
  return state.playing ? "ok" : "offline";
}

/** The ring: filled to the progress, the centre says it in percent. */
export function statusGraphic(state: PodState): CockpitGraphic {
  const empty = state.captions.length === 0;
  return {
    kind: "gauge",
    value: empty ? null : progress(state) / 100,
    center: empty ? DASH : `${progress(state)}%`,
    sub: t(state.locale, "cpProgress"),
    tone: statusTone(state),
  };
}

/** Zeile, Zeit, Dauer, Quelle. */
export function statusCells(state: PodState): CockpitCell[] {
  const { captions, cursor, locale } = state;
  const current = captions[Math.min(Math.max(0, cursor), captions.length - 1)];
  const last = captions[captions.length - 1];
  return [
    { label: t(locale, "cellLine"), value: captions.length === 0 ? DASH : `${Math.min(cursor, captions.length - 1) + 1}/${captions.length}` },
    { label: t(locale, "cellTime"), value: current ? formatTime(current.start) : DASH },
    { label: t(locale, "cellLength"), value: last ? formatTime(Math.max(last.end, last.start)) : DASH },
    { label: t(locale, "cellSource"), value: t(locale, SOURCE_TAG[state.source]) },
  ];
}

/** The hint line: only the gestures that do something here. */
export function cockpitHint(locale: Locale, playing: boolean): string {
  return footer(locale, { tap: t(locale, playing ? "actPause" : "actPlay") }, "back");
}

export function cockpitModel(state: PodState, now: number): CockpitModel {
  return {
    title: "PODCAPTION",
    clock: hhmm(now),
    headline: [t(state.locale, state.playing ? "tagPlay" : "tagPause")],
    cells: statusCells(state),
    graphic: statusGraphic(state),
    caption: state.failure || state.episode,
    hint: cockpitHint(state.locale, state.playing),
    tone: statusTone(state),
  };
}
