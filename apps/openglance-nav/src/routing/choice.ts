import type { Route } from "./provider";
import { formatDuration } from "../geo/geometry";
import { clip, LINE_WIDTH, MAX_ROWS, type NavView } from "../glasses/view";
import { pickerTrafficText, type TrafficReport } from "../traffic/traffic";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import { ft } from "../glasses/footer";

/**
 * Choosing between up to three car routes before the start:
 *
 * ```
 * OPENGLANCE · Route wählen
 * → A 34 min · 41 km · A1 · +12 min Stau
 *     B 38 min · 33 km · B158 · Akku −2 %
 *     C 41 min · 39 km · Maut
 * Tippen = los · Wischen = wählen · 2× = zurück
 * ```
 *
 * Only shown when the router offered more than one way; reroutes never ask.
 */

export interface RouteChoice {
  readonly routes: readonly Route[];
  readonly selected: number;
  /** Traffic per route from the own service: undefined = still asking / not asked, null = unavailable. */
  readonly traffic: readonly (TrafficReport | null | undefined)[];
}

export interface EnergyModel {
  /** kWh per 100 km at moderate speed (the car's last value, else the default). */
  readonly consumption: number;
  readonly usableKwh: number;
}

const LETTERS = ["A", "B", "C"];
/** A road reference such as A1, B158, S10, E55, L101, M5, also "A 1". */
const REF = /^(?:[ABSLEMD]|SS|SP|SR)\s?\d{1,4}[a-z]?$/i;

/**
 * The road the route mostly follows, by metres: its reference when it has one
 * (A1, B158), else the street name. Null when the router named none.
 */
export function mainRoad(route: Route): string | null {
  const metres = new Map<string, number>();
  for (const m of route.maneuvers) {
    if (!m.street || m.type === "arrive") continue;
    metres.set(m.street, (metres.get(m.street) ?? 0) + m.length);
  }
  let best: [string, number] | null = null;
  for (const entry of metres) if (!best || entry[1] > best[1]) best = entry;
  return best ? best[0].trim() : null;
}

/**
 * Battery the route would use, in percent of the usable capacity. The
 * consumption grows with speed: above 80 km/h average about +0.6 % per km/h
 * (rough, the air drag of a small car), below it stays as measured.
 */
export function energyPercent(route: Route, energy: EnergyModel): number {
  const km = route.distance / 1000;
  if (!(km > 0) || !(energy.usableKwh > 0)) return 0;
  const avg = route.duration > 0 ? km / (route.duration / 3600) : 60;
  const factor = 1 + Math.max(0, avg - 80) * 0.006;
  return ((km * energy.consumption * factor) / 100 / energy.usableKwh) * 100;
}

function t(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  return tr(messages, locale, key, vars);
}

function km(route: Route, locale: Locale): string {
  const value = route.distance / 1000;
  const text = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return (locale === "de" ? text.replace(".", ",") : text) + " km";
}

/**
 * One row: letter, time, distance, then what tells it apart, as far as it
 * fits - the traffic (most important), the battery difference to the fastest,
 * toll, the main road (least). Parts that do not fit are dropped, not cut.
 */
export function routeRow(choice: RouteChoice, index: number, locale: Locale, energy: EnergyModel | null, width: number): string {
  const route = choice.routes[index]!;
  const head = `${LETTERS[index] ?? "?"} ${formatDuration(route.duration)} · ${km(route, locale)}`;
  const extras: { text: string; weight: number }[] = [];
  const road = mainRoad(route);
  if (road && REF.test(road)) extras.push({ text: road, weight: 1 });
  else if (route.highway) extras.push({ text: t(locale, "r.motorway"), weight: 1 });
  else if (road) extras.push({ text: road, weight: 0 });
  if (route.toll) extras.push({ text: t(locale, "r.toll"), weight: 2 });
  if (energy && index > 0) {
    const diff = Math.round(energyPercent(route, energy) - energyPercent(choice.routes[0]!, energy));
    if (diff !== 0) extras.push({ text: t(locale, "r.battery", { d: (diff > 0 ? "+" : "−") + Math.abs(diff) }), weight: 3 });
  }
  const traffic = pickerTrafficText(choice.traffic[index], locale);
  if (traffic) extras.push({ text: traffic, weight: 4 });
  // Drop the least telling part until the row fits.
  const parts = [...extras];
  const line = (): string => [head, ...parts.map((p) => p.text)].join(" · ");
  while (line().length > width && parts.length) {
    const weakest = parts.reduce((low, p, i) => (p.weight < parts[low]!.weight ? i : low), 0);
    parts.splice(weakest, 1);
  }
  return clip(line(), width);
}

/** The picker page. */
export function routeChoiceView(choice: RouteChoice, locale: Locale, destination: string | null, energy: EnergyModel | null): NavView {
  const body: string[] = [];
  choice.routes.slice(0, 3).forEach((_, index) => {
    const selected = index === choice.selected;
    body.push(clip((selected ? "→ " : "    ") + routeRow(choice, index, locale, energy, LINE_WIDTH - 4), LINE_WIDTH));
  });
  if (destination && body.length + 2 <= MAX_ROWS) body.push("", clip(t(locale, "r.dest", { to: destination }), LINE_WIDTH));
  const asking = choice.traffic.some((r) => r === undefined);
  if (asking && body.length + 1 <= MAX_ROWS) body.push(t(locale, "r.traffic"));
  return { header: t(locale, "r.header"), body, footer: ft(locale, "back", { tap: "go", swipe: "choose" }) };
}

/** Swipe moves within the routes; it never wraps round (QIS: swipe only moves). */
export function moveChoice(choice: RouteChoice, step: number): RouteChoice {
  const last = Math.min(choice.routes.length, 3) - 1;
  return { ...choice, selected: Math.max(0, Math.min(last, choice.selected + step)) };
}

/** A toll-free way is offered when it takes at most this much longer than the best one. */
export const TOLL_FREE_MAX_FACTOR = 1.5;

/**
 * The routes worth a choice: the best one plus the router's alternates, at
 * most three; one = no picker. `tollFree` (asked for separately when the best
 * way has a toll): Valhalla's own alternates leave out a way that is much
 * slower - Salzburg → Tamsweg over the Radstädter Tauern (B99) takes 98 min
 * against 77 min on the A10 with its tunnel toll, and was never offered
 * (15.10.). It gets a place (the second) when the best way has a toll, it has
 * none, it is no more than TOLL_FREE_MAX_FACTOR slower, and no alternate is
 * toll-free already.
 */
export function choicesFrom(main: Route, alternates: readonly Route[] | undefined, tollFree?: Route | null): Route[] {
  const others = [...(alternates ?? [])];
  const offer = tollFree && main.toll === true && tollFree.toll === false
    && tollFree.duration <= main.duration * TOLL_FREE_MAX_FACTOR
    && !others.some((route) => route.toll === false);
  return [main, ...(offer ? [tollFree, ...others] : others)].slice(0, 3);
}
