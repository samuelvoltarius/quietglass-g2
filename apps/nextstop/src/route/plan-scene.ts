import type { Locale } from "../i18n";
import { t } from "../messages";
import { bigScene, minutesNumber } from "../glasses/board";
import { rideStopName } from "../glasses/view";
import { clock, departureOf, firstTransit, type Journey, type WalkLeg } from "./journey";
import { journeyRow } from "./view";
import type { Scene } from "./scene";

/**
 * The connections, on the same big page as the board: when to leave in big
 * digits, the first line as a badge, the arrival and the changes in bold, and
 * below it where to board plus the next two connections - instead of seven
 * rows of small text. Swiping changes which connection is big.
 */

function walkMinutes(journey: Journey): number {
  return Math.round(journey.legs
    .filter((leg): leg is WalkLeg => leg.kind === "walk")
    .reduce((sum, leg) => sum + (leg.end.getTime() - leg.start.getTime()), 0) / 60000);
}

export function planScene(journeys: readonly Journey[], selected: number, now: Date, locale: Locale): Scene {
  const shown = journeys.slice(0, 4);
  const index = Math.max(0, Math.min(selected, shown.length - 1));
  const chosen = shown[index]!;
  const transit = firstTransit(chosen);
  const arrival = t(locale, "r.arrive", { time: clock(chosen.end) });
  const others = shown
    .filter((_, i) => i !== index)
    .slice(0, 2)
    .map((journey) => journeyRow(journey, false, now, locale).trim());
  const footer = `${index + 1}/${shown.length} · ${t(locale, "r.footerPlansBig")}`;

  if (!transit) {
    const minutes = Math.max(1, Math.round((chosen.end.getTime() - chosen.start.getTime()) / 60000));
    return bigScene({
      number: { value: String(minutes), unit: "min" },
      picture: { kind: "words", lines: [{ text: t(locale, "r.onFoot"), size: 44 }] },
      strip: arrival,
      rows: others,
      footer,
    });
  }

  const boarding = transit.stops[0];
  const track = transit.boardTrack ? ` · ${t(locale, "r.track", { track: transit.boardTrack })}` : "";
  const changes = chosen.transfers > 0 ? t(locale, "r.changes", { count: chosen.transfers }) : t(locale, "r.direct");
  return bigScene({
    number: minutesNumber(departureOf(transit), now, locale),
    picture: { kind: "badge", text: transit.line },
    strip: `${arrival} · ${changes}`,
    rows: [
      `${t(locale, "r.leaveFrom", { stop: rideStopName(boarding?.stop.name ?? "", 28) })}${track} · ${t(locale, "r.walkMinutes", { minutes: walkMinutes(chosen) })}`,
      ...others,
    ],
    footer,
  });
}
