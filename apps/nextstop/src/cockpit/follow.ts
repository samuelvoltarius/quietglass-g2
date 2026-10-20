import type { Locale } from "../i18n";
import { t } from "../messages";
import { armedFooter, ft } from "../footer";
import { waitText } from "../route/journey";
import { glanceHeadsign, sureness } from "../glasses/board";
import { rideStopName, stopNamer } from "../glasses/view";
import type { Follow } from "../ride/follow";
import type { Scene } from "../route/scene";
import type { Departure, RideStop } from "../transit/types";
import { delayMinutes, minutesUntil } from "../transit/types";
import { cockpitScene } from "./scene";
import { RING_MINUTES, hhmm, lineLabel, whenLabel, type CockpitCell, type CockpitModel, type CockpitRing } from "./model";

/**
 * Following a bus as the cockpit (QUS v1): the same page shape as the board,
 * so tapping a departure never rebuilds the page. The title is the mode with
 * its live mark (`FOLGEN · ● live`), the headline is the one thing to know
 * (minutes to the bus, or the next stop), the ring counts down, ONE hint line.
 */

const title = (locale: Locale): string => `${t(locale, "c.follow").toUpperCase()} · ${t(locale, "s.live")}`;

const upper = (text: string): string => text.toUpperCase();

function ringFor(minutes: number, label: string, tone: CockpitRing["tone"], span = RING_MINUTES): CockpitRing {
  const progress = Math.max(0, Math.min(1, 1 - minutes / span));
  return minutes <= 0
    ? { progress: 1, center: label, sub: "", tone }
    : { progress, center: String(minutes), sub: "MIN", tone };
}

/** Right after the tap: the bus that was picked, while its stops are being fetched. */
export function followLoadingModel(departure: Departure, now: Date, locale: Locale, stopName: string): CockpitModel {
  return {
    title: title(locale),
    clock: hhmm(now),
    headline: `${lineLabel(departure.line, locale)} · ${whenLabel(departure, now, locale)}`,
    direction: `→ ${upper(glanceHeadsign(departure.headsign))}`,
    cells: [
      { label: t(locale, "c.at"), value: departure.cancelled ? "–" : hhmm(departure.expected) },
      { label: t(locale, "c.track"), value: departure.track ? upper(departure.track) : "–" },
      { label: t(locale, "c.stop"), value: upper(rideStopName(stopName, 20)) },
    ],
    ring: ringFor(minutesUntil(departure.expected, now), upper(t(locale, "g.now")), "ok"),
    caption: t(locale, "g.followLoading"),
    hint: ft(locale, "exit", { tap: "cancel" }),
    tone: "ok",
  };
}

function comingModel(departure: Departure, follow: Extract<Follow, { phase: "coming" }>, now: Date, locale: Locale): CockpitModel {
  const minutes = minutesUntil(follow.departs, now);
  const late = delayMinutes(follow.boarding) > 0;
  const where = follow.busAt && follow.stopsAway > 0
    ? upper(rideStopName(follow.busAt.stop.name, 16))
    : upper(t(locale, "c.here"));
  const cells: CockpitCell[] = [
    { label: t(locale, "c.at"), value: hhmm(follow.departs) },
    { label: t(locale, "c.delay"), value: upper(sureness(follow.boarding, locale).replace(/^[●~]\s*/, "")), ...(late || follow.boarding.cancelled ? { alert: true } : {}) },
    { label: t(locale, "c.stop"), value: upper(rideStopName(follow.boarding.stop.name, 20)) },
    { label: t(locale, "c.busAt"), value: where },
    { label: t(locale, "c.away"), value: follow.busAt && follow.stopsAway > 0 ? String(follow.stopsAway) : "0" },
  ];
  return {
    title: title(locale),
    clock: hhmm(now),
    headline: `${lineLabel(departure.line, locale)} · ${minutes <= 0 ? upper(t(locale, "g.now")) : upper(waitText(follow.departs, now, locale))}`,
    direction: `→ ${upper(glanceHeadsign(departure.headsign))}`,
    cells,
    ring: ringFor(minutes, upper(t(locale, "g.now")), late ? "warn" : "ok"),
    caption: rideStopName(follow.boarding.stop.name, 24),
    hint: ft(locale, "exit", { tap: "end" }),
    tone: late ? "warn" : "ok",
  };
}

function ridingModel(departure: Departure, follow: Extract<Follow, { phase: "riding" }>, now: Date, locale: Locale): CockpitModel {
  const { progress, terminus } = follow;
  const short = (stop: RideStop, width: number): string => stopNamer(follow.stops.map((s) => s.stop.name), width)(stop.stop.name);
  const next = progress.next;
  const minutes = minutesUntil(next.expected, now);
  const now0 = progress.arriving || minutes <= 0;
  const then = progress.upcoming[0];
  const left = progress.upcoming.length + 1;
  const cells: CockpitCell[] = [
    { label: t(locale, "c.left"), value: String(left) },
    { label: t(locale, "c.next"), value: then ? upper(short(then, 14)) : "–" },
    { label: t(locale, "c.line"), value: upper(departure.line) },
    { label: t(locale, "c.goal"), value: upper(short(terminus, 14)) },
    { label: t(locale, "c.arrive"), value: hhmm(terminus.expected) },
    { label: t(locale, "c.basis"), value: upper(t(locale, progress.basis === "gps" ? "g.basisGps" : "g.basisClock")) },
  ];
  return {
    title: title(locale),
    clock: hhmm(now),
    headline: upper(next.cancelled ? t(locale, "g.cancelled") : short(next, 26)),
    direction: `${upper(t(locale, "c.nextStop"))} · ${now0 ? upper(t(locale, "g.now")) : upper(waitText(next.expected, now, locale))}`,
    cells,
    ring: next.cancelled ? { progress: 0, center: "–", sub: "", tone: "offline" } : ringFor(now0 ? 0 : minutes, upper(t(locale, "g.now")), "ok", 6),
    caption: upper(t(locale, "c.nextStop")),
    hint: ft(locale, "exit", { tap: "end" }, t(locale, progress.basis === "gps" ? "g.basisGps" : "g.basisClock")),
    tone: "ok",
  };
}

function finishedModel(follow: Extract<Follow, { phase: "finished" }>, now: Date, locale: Locale): CockpitModel {
  return {
    title: title(locale),
    clock: hhmm(now),
    headline: upper(t(locale, "g.rideOverTitle")),
    direction: upper(rideStopName(follow.terminus.stop.name, 28)),
    cells: [{ label: t(locale, "c.arrive"), value: hhmm(follow.terminus.expected) }],
    ring: { progress: 1, center: "OK", sub: "", tone: "ok" },
    caption: rideStopName(follow.terminus.stop.name, 24),
    hint: ft(locale, "exit", { tap: "back" }),
    tone: "ok",
  };
}

/** The model of a followed ride in whatever phase it is in. */
export function followModel(departure: Departure, follow: Follow, now: Date, locale: Locale): CockpitModel {
  if (follow.phase === "coming") return comingModel(departure, follow, now, locale);
  if (follow.phase === "finished") return finishedModel(follow, now, locale);
  return ridingModel(departure, follow, now, locale);
}

export const followLoadingScene = (departure: Departure, now: Date, locale: Locale, stopName: string): Scene =>
  cockpitScene(followLoadingModel(departure, now, locale, stopName));

/**
 * Following a bus: before it arrives, the minutes until it leaves your stop
 * and where it is now; on board, the next stop and the minutes to it.
 * Armed (QIS v1): the next single tap ends the ride; swipe, 2x or 4 s without input cancel.
 */
export function followScene(departure: Departure, follow: Follow, now: Date, locale: Locale, armed = false): Scene {
  const model = followModel(departure, follow, now, locale);
  return cockpitScene(armed ? { ...model, hint: armedFooter(locale, t(locale, "q.end")) } : model);
}
