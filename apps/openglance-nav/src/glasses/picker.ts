import type { NavView } from "./view";
import { clip, LINE_WIDTH, MAX_ROWS, ROW_WIDTH } from "./view";
import { tailLines } from "../voice/live-stt";
import type { FoundPlace } from "../geocode/photon";
import type { Destination, NavData } from "../storage/persist";
import type { SavedRoute } from "../trip/saved";
import { powerText, priceText, socketsText, type NearbyCharger } from "../chargers/chargers";
import { formatDistance, type LatLng } from "../geo/geometry";
import type { TravelMode } from "../routing/provider";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import { ft, word } from "./footer";
import { appointmentRow, type Appointment } from "../appointments/appointments";

/**
 * The glasses pages before navigation: the destination list and speaking a
 * destination. Both are plain text pages (header, body, footer), so moving
 * the cursor or a new recording phase is a text update, never a rebuild.
 */

/** Destinations visible at once on the list. */
export const VISIBLE_ITEMS = 5;

export type ListItem =
  | {
    readonly kind: "place";
    readonly place: Destination;
    /** Spoken on the glasses and not saved: shown as "recent". */
    readonly recent: boolean;
  }
  | { readonly kind: "route"; readonly route: SavedRoute }
  /** Today's appointment from the owner's daemon (private build); `leave` = "los in 12 min" once a travel time is known. */
  | { readonly kind: "appt"; readonly appt: Appointment; readonly leave: string | null }
  | { readonly kind: "chargers" }
  | { readonly kind: "peaks" }
  /** "Wo ist mein Auto": the car's last place from the BYD cloud (private build); minutes since it was reported. */
  | { readonly kind: "car"; readonly at: LatLng; readonly ageMin: number | null };

/**
 * The peaks view (compass band of the peaks nearby) is off: Alfred 15.10. -
 * without a compass the direction only follows the GPS course, so it is of
 * little use on foot. The code stays; this switch brings it back.
 */
export const PEAKS_VIEW = false;

/** Id of the car's place while it is the destination: never shown as a row of its own, replaced on every walk to the car. */
export const CAR_DESTINATION_ID = "car";

/** The parked car the list offers (null = none known); set by the app whenever the car link answers. */
let carSpot: { readonly at: LatLng; readonly ageMin: number | null } | null = null;
export function setCarSpot(spot: { readonly at: LatLng; readonly ageMin: number | null } | null): void {
  carSpot = spot;
}

/** Id of an entry, matched against the selected destination. */
export function itemId(item: ListItem): string {
  return item.kind === "place" ? item.place.id : item.kind === "route" ? item.route.id : item.kind === "appt" ? "appt:" + item.appt.key : item.kind === "car" ? CAR_DESTINATION_ID : "";
}

/** An appointment on its way to the list, with its departure text (or null while no travel time is known). */
export interface ListAppt {
  readonly appt: Appointment;
  readonly leave: string | null;
}

/**
 * Today's upcoming appointments first (private build), then the favourites,
 * the saved routes, "where is my car" (when the car link knows its place) and
 * "charging nearby" / "peaks nearby" when on. Recent destinations are no rows
 * of their own (Alfred 15.10.: favourites instead) - only the active one, so
 * a spoken destination can be started again.
 */
export function listItems(data: NavData, appts: readonly ListAppt[] = []): ListItem[] {
  const active = data.recent.find((place) => place.id === data.destinationId && place.id !== CAR_DESTINATION_ID);
  return [
    ...appts.map(({ appt, leave }) => ({ kind: "appt" as const, appt, leave })),
    ...data.places.map((place) => ({ kind: "place" as const, place, recent: false })),
    ...(active ? [{ kind: "place" as const, place: active, recent: true }] : []),
    ...data.routes.map((route) => ({ kind: "route" as const, route })),
    ...(carSpot ? [{ kind: "car" as const, at: carSpot.at, ageMin: carSpot.ageMin }] : []),
    ...(data.chargers ? [{ kind: "chargers" as const }] : []),
    ...(PEAKS_VIEW && data.peaks ? [{ kind: "peaks" as const }] : []),
  ];
}

/** Rows of the list: every destination and the travel-mode row (Help lives in the side menu, QIS v1.2). */
export function rowCount(data: NavData, appts: readonly ListAppt[] = []): number {
  return listItems(data, appts).length + 1;
}

/** Where the cursor starts: on the active destination, else the first row. */
export function cursorFor(data: NavData, appts: readonly ListAppt[] = []): number {
  const index = data.destinationId ? listItems(data, appts).findIndex((item) => itemId(item) === data.destinationId) : -1;
  return index >= 0 ? index : 0;
}

export function clampCursor(data: NavData, cursor: number, appts: readonly ListAppt[] = []): number {
  return Math.max(0, Math.min(rowCount(data, appts) - 1, cursor));
}

/**
 * Where the cursor goes when the rows change under it (appointments arrive or
 * pass): onto the same entry when it is still there, else the same position.
 */
export function followCursor(data: NavData, cursor: number, before: readonly ListAppt[], after: readonly ListAppt[]): number {
  const old = listItems(data, before);
  const now = listItems(data, after);
  if (cursor < old.length) {
    const id = itemId(old[cursor]!);
    const index = id ? now.findIndex((item) => itemId(item) === id) : -1;
    if (index >= 0) return index;
  } else {
    // The travel-mode row keeps its place at the end.
    return clampCursor(data, now.length + (cursor - old.length), after);
  }
  return clampCursor(data, cursor, after);
}

const MODES: readonly TravelMode[] = ["driving", "cycling", "walking"];

/** Car → bike → on foot → car. */
export function nextMode(mode: TravelMode): TravelMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length] ?? "walking";
}

function t(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  return tr(messages, locale, key, vars);
}

/** "→" marks the cursor, "●" the active destination, "○" the others; "↑" a saved route, "…" charging nearby. */
function row(selected: boolean, mark: string, text: string): string {
  return clip((selected ? "→ " : "    ") + mark + text, LINE_WIDTH);
}

/**
 * The destination list: at most VISIBLE_ITEMS destinations around the cursor,
 * an empty line, and the travel mode (tap on it switches).
 */
export function listView(data: NavData, cursor: number, locale: Locale, canSpeak = true, appts: readonly ListAppt[] = []): NavView {
  const items = listItems(data, appts);
  const modeRow = items.length;
  const body: string[] = [];
  if (items.length === 0) {
    body.push(t(locale, "l.empty1"), ...(canSpeak ? [t(locale, "l.empty2"), t(locale, "l.empty3")] : [t(locale, "l.emptyPhone")]));
  } else {
    const anchor = Math.min(cursor, items.length - 1);
    const first = Math.max(0, Math.min(anchor - Math.floor(VISIBLE_ITEMS / 2), items.length - VISIBLE_ITEMS));
    for (const [offset, item] of items.slice(first, first + VISIBLE_ITEMS).entries()) {
      const index = first + offset;
      body.push(item.kind === "appt" ? apptLine(index === cursor, item) : row(index === cursor, markOf(item, data), labelOf(item, locale)));
    }
  }
  // The separator only when the seven rows have room for it.
  if (body.length + 3 <= MAX_ROWS) body.push("");
  body.push(row(cursor === modeRow, "", t(locale, "l.mode", { mode: t(locale, "mode." + data.mode) })));
  const header = items.length > VISIBLE_ITEMS && cursor < items.length
    ? t(locale, "l.headerCount", { n: cursor + 1, total: items.length })
    : t(locale, "l.header");
  return { header, body, footer: canSpeak ? ft(locale, "exit", { tap: "go", hold: "speak" }) : ft(locale, "exit", { tap: "go", swipe: "choose" }) };
}

/** "5 min", "2 h", "3 d": how long ago the car reported its place. */
function ageText(minutes: number): string {
  if (minutes < 60) return Math.round(minutes) + " min";
  if (minutes < 48 * 60) return Math.round(minutes / 60) + " h";
  return Math.round(minutes / 1440) + " d";
}

/** The help page: the gestures of this app, in the order of the footers. */
export function helpView(locale: Locale): NavView {
  return {
    header: t(locale, "h.header"),
    body: [1, 2, 3, 4, 5, 6, 7].map((n) => t(locale, "h." + n)),
    footer: ft(locale, "back"),
  };
}

/** Marks an appointment row (the time follows). */
export const APPT_MARK = "▸ ";
/** An appointment row keeps its mark in the cursor gutter, so the text gets 42 characters: `10:30 Testkd … · Musterdorf · los in 12 min`. */
export const APPT_TEXT_WIDTH = LINE_WIDTH - 4;

function apptLine(selected: boolean, item: Extract<ListItem, { kind: "appt" }>): string {
  return clip((selected ? "→ " : "  ") + APPT_MARK + appointmentRow(item.appt, APPT_TEXT_WIDTH, item.leave), LINE_WIDTH);
}

function markOf(item: ListItem, data: NavData): string {
  if (item.kind === "chargers" || item.kind === "peaks") return "";
  if (item.kind === "car") return data.destinationId === CAR_DESTINATION_ID ? "● " : "";
  if (item.kind === "appt") return "";
  if (item.kind === "route") return item.route.id === data.destinationId ? "● " : "↑ ";
  return item.place.id === data.destinationId ? "● " : "○ ";
}

function labelOf(item: ListItem, locale: Locale): string {
  if (item.kind === "appt") return appointmentRow(item.appt, APPT_TEXT_WIDTH, item.leave);
  if (item.kind === "chargers") return t(locale, "l.chargers");
  if (item.kind === "car") return item.ageMin !== null && item.ageMin >= 1 ? t(locale, "l.carAge", { age: ageText(item.ageMin) }) : t(locale, "l.car");
  if (item.kind === "peaks") return t(locale, "l.peaks");
  if (item.kind === "route") {
    const stops = item.route.stops.length;
    return stops ? `${item.route.name} · ${t(locale, stops === 1 ? "l.stop1" : "l.stops", { n: stops })}` : `${item.route.name} · ${t(locale, "l.route")}`;
  }
  return item.recent ? `${item.place.label} · ${t(locale, "l.recent")}` : item.place.label;
}

export type ChargerListState =
  | { readonly phase: "loading"; readonly key: string }
  | { readonly phase: "results"; readonly list: readonly NearbyCharger[]; readonly selected: number }
  | { readonly phase: "error"; readonly key: string; readonly vars?: Readonly<Record<string, string | number>> };

/** "Charging nearby": up to three fast stations, nearest first, or why there are none. */
export function chargerView(state: ChargerListState, locale: Locale): NavView {
  const header = t(locale, "c.header");
  switch (state.phase) {
    case "loading":
      return { header, body: [t(locale, state.key)], footer: ft(locale, "back") };
    case "error":
      return { header, body: [t(locale, state.key, state.vars ?? {}), "", t(locale, state.key + "Hint", state.vars ?? {})], footer: ft(locale, "back", { hold: "again" }) };
    case "results": {
      const body: string[] = [];
      for (const [index, { charger, distance }] of state.list.entries()) {
        const power = powerText(charger);
        const name = charger.name || t(locale, "c.noName");
        body.push(row(index === state.selected, "", `${formatDistance(distance, locale)} · ${power ? power + " · " : ""}${name}`));
        const detail = [priceText(charger, locale), socketsText(charger, locale), charger.capacity ? t(locale, "c.places", { n: charger.capacity }) : "", charger.operator && charger.operator !== name ? charger.operator : ""].filter(Boolean).join(" · ");
        if (detail) body.push(clip("      " + detail, LINE_WIDTH));
      }
      return { header, body, footer: ft(locale, "back", { tap: "goThere", swipe: "choose" }) };
    }
  }
}

export type VoiceState =
  /** `live`: what the live recogniser heard so far, shown while still speaking. */
  | { readonly phase: "recording"; readonly live?: string }
  | { readonly phase: "working"; readonly heard?: string }
  | { readonly phase: "results"; readonly heard: string; readonly results: readonly FoundPlace[]; readonly selected: number; readonly saved: boolean }
  | { readonly phase: "error"; readonly key: string; readonly vars?: Readonly<Record<string, string>> };

/** Speaking a destination: recording, working, up to three hits, or what went wrong. */
export function voiceView(state: VoiceState, locale: Locale): NavView {
  const header = t(locale, "v.header");
  switch (state.phase) {
    case "recording":
      // The newest words at the bottom; the start scrolls off the top while speaking.
      if (state.live) return { header, body: [t(locale, "v.recording"), "", ...tailLines(state.live, LINE_WIDTH, MAX_ROWS - 2)], footer: ft(locale, "back", { tap: "done" }) };
      return { header, body: [t(locale, "v.recording"), "", t(locale, "v.recordingHint")], footer: ft(locale, "back", { tap: "done" }) };
    case "working":
      return {
        header,
        body: [state.heard ? t(locale, "v.searching", { text: clip(state.heard, 28) }) : t(locale, "v.working")],
        footer: "",
      };
    case "results": {
      const body: string[] = [];
      for (const [index, place] of state.results.entries()) {
        body.push(row(index === state.selected, "", place.label));
        if (place.detail) body.push(clip("      " + place.detail, LINE_WIDTH));
      }
      return {
        header: clip(t(locale, "v.heard", { text: state.heard }), ROW_WIDTH),
        body,
        footer: ft(locale, "back", { tap: "go", swipe: "choose", ...(state.saved ? {} : { hold: "save" }) }, state.saved ? word(locale, "saved") : ""),
      };
    }
    case "error":
      return {
        header,
        body: [t(locale, state.key, state.vars ?? {}), "", t(locale, state.key + "Hint", state.vars ?? {})],
        footer: ft(locale, "back", { hold: "again" }),
      };
  }
}
