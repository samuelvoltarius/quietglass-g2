import type { Locale } from "../i18n";
import type { LumenStatus } from "../lumen/client";
import { t } from "../messages";
import { footer } from "../glasses/footer";
import { hhmm, type CockpitCell, type CockpitGraphic, type CockpitModel, type Tone } from "./compose";

/**
 * What the moth cockpit shows, in words and numbers, decided without
 * drawing (QUS v1): the headline (the moth's state), the label/value cells,
 * the graphic for the left half (a ring filled to the moth's light), the
 * caption and the hint line. compose.ts only lays this out.
 */

const DASH = "–";

export interface MothInput {
  readonly status: LumenStatus | null;
  /** The last failure (the glasses never show its technical text). */
  readonly error: string | null;
  readonly demo: boolean;
  readonly locale: Locale;
  readonly now: number;
}

/** How the moth stands: awake and shining is fine, tired is a warning, curled up (or no connection) is offline. */
export function mothTone(input: Pick<MothInput, "status" | "error">): Tone {
  if (!input.status) return "offline";
  switch (input.status.moth.state) {
    case "leuchtet": case "wach": return input.error ? "warn" : "ok";
    case "matt": case "schläfrig": return "warn";
    default: return "offline";
  }
}

/** "24 min" / "1 h 05": the time to the light window. */
export function windowTime(minutes: number, locale: Locale): string {
  const total = Math.round(minutes);
  if (!(total > 0)) return t(locale, "g.cp.now");
  if (total < 60) return t(locale, "g.onlyMinutes", { minutes: total });
  return t(locale, "g.cp.hm", { h: Math.floor(total / 60), m: String(total % 60).padStart(2, "0") });
}

/** The three cells: streak, the next light window, open quests. */
export function mothCells(status: LumenStatus | null, locale: Locale): CockpitCell[] {
  if (!status) return [];
  const kind = status.window?.kind ?? "";
  const name = kind.startsWith("golden") ? t(locale, "g.golden") : kind.startsWith("blau") || kind.startsWith("blue") ? t(locale, "g.blue") : t(locale, "g.cp.window");
  return [
    { label: t(locale, "g.cp.streak"), value: status.moth.streak > 0 ? t(locale, "g.cp.days", { days: status.moth.streak }) : DASH },
    { label: name, value: status.window ? windowTime(status.window.minutesAway, locale) : DASH },
    { label: t(locale, "g.cp.open"), value: String(status.openQuests) },
  ];
}

/** The graphic: a ring filled to the moth's light, the centre says it in percent. */
export function mothGraphic(status: LumenStatus | null, tone: Tone, locale: Locale): CockpitGraphic {
  if (!status) return { kind: "gauge", value: null, center: DASH, sub: t(locale, "g.cp.lightSub"), tone };
  const light = Math.max(0, Math.min(100, Math.round(status.moth.light)));
  return { kind: "gauge", value: light / 100, center: `${light}%`, sub: t(locale, "g.cp.lightSub"), tone };
}

/** The hint line: only the gestures that do something here. */
export function cockpitHint(locale: Locale): string {
  return footer(locale, { tap: t(locale, "g.v.reload") }, "back");
}

export function cockpitModel(input: MothInput): CockpitModel {
  const { status, locale } = input;
  const tone = mothTone(input);
  const headline = status
    // LUMEN's own word for the moth's state.
    ? [status.moth.state.toUpperCase()]
    : [t(locale, input.error ? "g.cp.offline" : "g.cp.connecting")];
  return {
    title: t(locale, "g.title").toUpperCase(),
    clock: hhmm(input.now),
    headline,
    cells: mothCells(status, locale),
    graphic: mothGraphic(status, tone, locale),
    // LUMEN's own words for what the moth does; the demo says so.
    caption: input.demo ? t(locale, "g.demoWord") : status?.moth.gesture ?? "",
    hint: cockpitHint(locale),
    tone,
  };
}
