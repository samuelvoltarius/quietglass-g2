import type { Departure, Stop } from "../transit/types";
import { delayMinutes } from "../transit/types";
import type { RideProgress } from "../ride/tracker";
import { etaLabel } from "../ride/tracker";

/**
 * What the glasses show.
 *
 * The app has exactly two things to say, and they are wanted at different
 * moments: standing at a stop, "what leaves from here"; sitting in the
 * vehicle, "where do I get off". Both are one glance, so neither screen
 * carries anything the other needs.
 *
 * The rule running through this file: a time the operator has not confirmed
 * must never look like one it has. A board that prints "4 min" identically
 * whether it is measured or merely printed in a timetable is worse than no
 * board, because it is trusted just as much and is wrong just as often.
 */

export interface StopView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

/**
 * Roughly the characters that fit across the 576 px display.
 *
 * Only roughly, because the display font is **proportional**, not monospaced:
 * "0-Bus 5" is visibly wider than "Bus 22". Padding text into columns
 * therefore does not line anything up — an earlier version did exactly that
 * and produced a ragged staircase of times on real output. Everything here
 * uses explicit separators instead, which read correctly at any width.
 */
export const LINE_WIDTH = 46;
/** Rows the body container can show without clipping. */
export const BODY_ROWS = 7;

/**
 * The selection marker.
 *
 * Plain ASCII on purpose: "▸" was tried first and the glasses drew nothing at
 * all for it, which silently removed the only indication of which departure a
 * tap would follow.
 */
export const CURSOR = ">";

/**
 * How certain a time is, in one character.
 *
 *   `+7`  the operator says seven minutes late
 *   `-1`  running early, which happens and should not be hidden
 *   `●`   the operator says it is on time
 *   `~`   timetable only — nobody has confirmed anything
 *
 * The tilde is the important one. Most boards silently show a planned time as
 * though it were live, and the passenger has no way to tell the difference.
 */
export function certainty(departure: Departure): string {
  if (departure.cancelled) return "X";
  if (departure.source !== "realtime") return "~";
  const delay = delayMinutes(departure);
  if (delay === 0) return "●";
  return delay > 0 ? `+${delay}` : String(delay);
}

/** Waiting time as a passenger reads it off a board. */
export function waitLabel(departure: Departure): string {
  if (departure.cancelled) return "fällt aus";
  if (departure.inMinutes <= 0) return "jetzt";
  if (departure.inMinutes >= 60) {
    return `${Math.floor(departure.inMinutes / 60)}h${departure.inMinutes % 60}`;
  }
  return `${departure.inMinutes} min`;
}

/** Cuts a word-wrapped line to the display width. */
export function wrap(text: string, width: number = LINE_WIDTH): readonly string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * A stop name as it should appear while riding.
 *
 * The stand in brackets is dropped first, then the name is cut. Cutting
 * straight to length instead produced "Salzburg Makartplatz (Aicherpass" on
 * real output — an unclosed bracket that reads like a bug and costs the
 * characters that would have shown the actual name. Which stand the vehicle
 * uses matters on the pavement, never from inside it.
 */
export function rideStopName(name: string, width = 32): string {
  const withoutStand = name.replace(/\s*\([^()]*\)\s*$/, "").trim();
  return withoutStand.length <= width ? withoutStand : withoutStand.slice(0, width - 1) + "…";
}

/** The board at a stop: what leaves from here, soonest first. */
export function departureBoard(
  stop: Stop,
  departures: readonly Departure[],
  metresAway: number | null,
  selected = 0,
): StopView {
  const distance = metresAway === null
    ? ""
    : ` · ${metresAway < 1000 ? `${Math.round(metresAway)} m` : `${(metresAway / 1000).toFixed(1)} km`}`;

  if (departures.length === 0) {
    return {
      header: stop.name + distance,
      body: [
        "",
        "Keine Abfahrten in der nächsten Stunde.",
        "",
        "Betriebsschluss, oder diese Haltestelle",
        "wird gerade nicht bedient.",
      ],
      footer: "halten = andere Haltestelle",
    };
  }

  const anyLive = departures.some((d) => d.source === "realtime");

  // Scroll the window so the selected row stays visible on a long board,
  // rather than selecting something that has been cut off the bottom.
  const first = Math.max(0, Math.min(selected - BODY_ROWS + 1, departures.length - BODY_ROWS));
  const window = departures.slice(Math.max(0, first), Math.max(0, first) + BODY_ROWS);

  const rows = window.map((departure, offset) => {
    const isSelected = Math.max(0, first) + offset === selected;
    const cursor = isSelected ? CURSOR : " ";
    // Destination is the field that can be arbitrarily long, so it is the one
    // that gives way; the line number and the time never truncate.
    const to = departure.headsign.slice(0, 22);
    const mark = certainty(departure);
    const track = departure.track ? ` ${departure.track}` : "";
    return `${cursor} ${departure.line}  ${to} · ${waitLabel(departure)} ${mark}${track}`
      .slice(0, LINE_WIDTH);
  });

  return {
    header: stop.name + distance,
    body: rows,
    // Saying where the numbers come from is not decoration. Without it a
    // board of pure timetable times is indistinguishable from a live one.
    footer: anyLive
      ? "tippen = verfolgen · ● live  ~ Fahrplan"
      : "tippen = verfolgen · nur Fahrplan",
  };
}

/** The ride: where am I, and when do I get off. */
export function ridingView(progress: RideProgress, now: Date, line: string, headsign: string): StopView {
  if (progress.finished) {
    return {
      header: `${line} → ${headsign}`,
      body: ["", `Endstation ${progress.next.stop.name}.`, "", "Die Fahrt ist zu Ende."],
      footer: "tippen = zurück zur Haltestelle",
    };
  }

  const body: string[] = [];

  // The next stop gets a marker and the whole first line, because it is the
  // only thing on this screen that can make someone stand up.
  const eta = progress.arriving ? "gleich" : etaLabel(progress.next, now);
  body.push(`${CURSOR} ${rideStopName(progress.next.stop.name)} · ${eta}`);

  for (const stop of progress.upcoming.slice(0, BODY_ROWS - 3)) {
    const mark = stop.cancelled ? "X" : " ";
    body.push(`${mark} ${rideStopName(stop.stop.name)} · ${etaLabel(stop, now)}`);
  }

  const remaining = progress.upcoming.length;
  const terminus = progress.upcoming[remaining - 1] ?? progress.next;
  body.push("");
  body.push(remaining === 0
    ? "letzter Halt"
    : `noch ${remaining} ${remaining === 1 ? "Halt" : "Halte"}`
      + ` · Ziel ${etaLabel(terminus, now)}`);

  return {
    header: `${line} → ${headsign}`,
    body,
    // Which of the two sources is speaking. On GPS the next stop is measured;
    // on the clock it is an estimate, and after a long hold-up it can be
    // several stops optimistic. The passenger is entitled to know which.
    footer: progress.basis === "gps"
      ? `GPS${progress.metresToNext === undefined ? "" : ` · ${Math.round(progress.metresToNext)} m`}`
        + " · tippen = zurück"
      : "nach Fahrplan geschätzt · tippen = zurück",
  };
}

/** Something went wrong, said plainly rather than as a blank screen. */
export function errorView(message: string, hint: string): StopView {
  return {
    header: "NextStop",
    body: ["", ...wrap(message), "", ...wrap(hint)],
    footer: "tippen = nochmal versuchen",
  };
}

/** Shown while the first request is in flight, so the screen is never blank. */
export function loadingView(what: string): StopView {
  return { header: "NextStop", body: ["", what], footer: "" };
}
