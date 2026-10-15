import { clip, LINE_WIDTH, type NavView } from "../glasses/view";
import { formatDistance } from "../geo/geometry";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import { ft } from "../glasses/footer";
import { compassPoint, type Facing, type PeakPick, type PeakRadiusKm, type PeakSight } from "./peaks";

/**
 * The glasses texts of the peaks page.
 *
 * Two views: the compass band (images above, three lines of text below) and a
 * plain distance-sorted list (text page). Tap switches between them; on the
 * list, swipe chooses and tap navigates to the peak; on the band, swipe
 * switches between the nearest and the highest peaks.
 */

export type PeakPageState =
  | { readonly phase: "loading"; readonly key: string }
  | { readonly phase: "error"; readonly key: string; readonly vars?: Readonly<Record<string, string | number>> }
  | {
    readonly phase: "ready";
    /** Within the radius, nearest first. */
    readonly sights: readonly PeakSight[];
    readonly pick: PeakPick;
    readonly view: "band" | "list";
    readonly selected: number;
  };

/** Rows of the list visible at once. */
export const LIST_ROWS = 6;

function t(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  return tr(messages, locale, key, vars);
}

/** "245° SW · GPS-Kurs" */
export function facingText(facing: Facing, locale: Locale): string {
  return t(locale, "k.facing", { deg: Math.round(facing.deg) % 360, dir: compassPoint(facing.deg, locale), src: t(locale, "k.src." + facing.source) });
}

/** The text below the band (the band itself is an image). */
export function bandView(state: PeakPageState, facing: Facing, radiusKm: PeakRadiusKm, locale: Locale): NavView {
  const header = "";
  switch (state.phase) {
    case "loading":
      return { header, body: [t(locale, state.key), clip(facingText(facing, locale), LINE_WIDTH)], footer: ft(locale, "back") };
    case "error":
      return { header, body: [t(locale, state.key, state.vars ?? {}), t(locale, state.key + "Hint", state.vars ?? {})], footer: ft(locale, "back", { hold: "again" }) };
    case "ready": {
      const highest = state.sights.reduce<PeakSight | null>((best, s) => (!best || s.peak.ele > best.peak.ele ? s : best), null);
      const body = [
        clip(facingText(facing, locale), LINE_WIDTH),
        clip(t(locale, state.pick === "near" ? "k.countNear" : "k.countHigh", { n: state.sights.length, r: radiusKm }), LINE_WIDTH),
        highest
          ? clip(t(locale, "k.highest", { name: highest.peak.name, ele: highest.peak.ele, d: formatDistance(highest.distance, locale) }), LINE_WIDTH)
          : t(locale, "k.none", { r: radiusKm }),
      ];
      return { header, body, footer: ft(locale, "back", { tap: "list", swipe: "nearHigh" }) };
    }
  }
}

/** One row of the list: "2,3 km · NO · Gaisberg 1287 m". */
export function listRow(sight: PeakSight, selected: boolean, locale: Locale): string {
  const text = `${formatDistance(sight.distance, locale)} · ${compassPoint(sight.bearing, locale)} · ${sight.peak.name} ${sight.peak.ele} m`;
  return clip((selected ? "→ " : "   ") + text, LINE_WIDTH);
}

/** The distance-sorted list (a text page). */
export function peakListView(state: Extract<PeakPageState, { phase: "ready" }>, radiusKm: PeakRadiusKm, locale: Locale): NavView {
  const total = state.sights.length;
  const header = t(locale, "k.listHeader", { r: radiusKm, n: total ? state.selected + 1 : 0, total });
  if (!total) return { header, body: [t(locale, "k.none", { r: radiusKm })], footer: ft(locale, "back", { tap: "goThere", swipe: "choose", hold: "band" }) };
  const first = Math.max(0, Math.min(state.selected - Math.floor(LIST_ROWS / 2), total - LIST_ROWS));
  const body = state.sights.slice(first, first + LIST_ROWS).map((sight, offset) => listRow(sight, first + offset === state.selected, locale));
  return { header, body, footer: ft(locale, "back", { tap: "goThere", swipe: "choose", hold: "band" }) };
}
