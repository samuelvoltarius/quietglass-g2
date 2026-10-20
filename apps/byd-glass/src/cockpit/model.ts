import { t } from "../messages";
import type { CarState } from "../car/model";
import { ageText, dec, duration, km, pct, warningShort } from "../format";
import { activeWarnings, cells as cellTemps, errorReason, pageFooter, type ViewState } from "../glasses/views";

/**
 * What the car cockpit shows, in words and numbers, decided without drawing
 * (QUS v1): headline, label/value cells, the battery ring of the left half,
 * the caption and the one hint line. compose.ts only lays this out.
 * Three pages share it: drive, charge and status (parked).
 */

export type Tone = "ok" | "warn" | "critical" | "offline";

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  /** Drawn with a frame round it. */
  readonly alert?: boolean;
}

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  /** One or two lines, upper case. */
  readonly headline: readonly string[];
  /** Rows of three columns. */
  readonly cells: readonly CockpitCell[];
  readonly graphic: {
    /** 0..100 or null when the charge level is unknown: the ring's fill. */
    readonly percent: number | null;
    readonly tone: Tone;
    readonly center: string;
    readonly sub: string;
    /** Charging: the ring pulses as a dashed sweep. */
    readonly charging: boolean;
  };
  /** Left bottom: the warning, the problem or the time of the data. */
  readonly caption: string;
  /** The one footer line with the gestures. */
  readonly hint: string;
  readonly tone: Tone;
}

const DASH = "–";

/** "HH:MM" of an epoch ms in the phone's time (24 h). */
export function hhmm(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** How the battery stands: unknown/stale = offline, crit warning or 10 % = critical, warning or 20 % = warn. */
export function carTone(state: ViewState, car: CarState): Tone {
  const soc = car.battery.soc;
  if (state.connection.kind === "error" || car.stale) return "offline";
  if (activeWarnings(car).some((w) => w.level === "crit") || (soc !== null && soc <= 10)) return "critical";
  if (activeWarnings(car).some((w) => w.level === "warn") || (soc !== null && soc <= 20)) return "warn";
  return "ok";
}

const yes = (state: ViewState, value: boolean | null, on: string, off: string): string => (value === null ? DASH : t(state.locale, value ? on : off));

/** The state of the four tyres in one word; the cell is framed when one is low or leaking. */
function tyreCell(state: ViewState, car: CarState): { value: string; alert: boolean } {
  const all = Object.values(car.tyres);
  const known = all.some((tyre) => tyre.kpa !== null);
  const bad = all.some((tyre) => tyre.leak || tyre.low);
  if (!known && !bad) return { value: DASH, alert: false };
  return { value: t(state.locale, bad ? "g.cp.tyresCheck" : "g.cp.tyresOk"), alert: bad };
}

/** "3 MIN" / "1 H 05": age short, or LIVE. */
export function standText(state: ViewState, car: CarState): string {
  if (!car.stale) return t(state.locale, "g.cp.live");
  return ageText(state.locale, car.ageS).toUpperCase();
}

export function cockpitCells(state: ViewState, car: CarState): CockpitCell[] {
  const L = (key: string): string => t(state.locale, key);
  const loc = state.locale;
  const tyres = tyreCell(state, car);
  const num = (value: number | null, digits = 0): string => (value === null ? DASH : dec(value, digits, loc));
  switch (state.page) {
    case "drive":
      return [
        { label: L("g.cp.power"), value: car.drive.powerKw === null ? DASH : `${num(car.drive.powerKw, Math.abs(car.drive.powerKw) >= 10 ? 0 : 1)} kW` },
        { label: L("g.cp.cons"), value: num(car.drive.cons50, 1) },
        { label: L("g.cp.range"), value: car.battery.rangeKm === null ? DASH : `${Math.round(car.battery.rangeKm)} km` },
        { label: L("g.cp.climate"), value: yes(state, car.body.acOn, "g.cp.on", "g.cp.off") },
        { label: L("g.cp.outside"), value: car.body.extTemp === null ? DASH : `${num(car.body.extTemp)}°` },
        { label: L("g.cp.trip"), value: car.drive.tripKm === null ? DASH : `${num(car.drive.tripKm, 1)} km` },
      ];
    case "charge": {
      const c = car.charge;
      return [
        { label: L("g.cp.range"), value: car.battery.rangeKm === null ? DASH : `${Math.round(car.battery.rangeKm)} km` },
        { label: L("g.cp.charged"), value: c.kwh === null ? DASH : `${num(c.kwh, 1)} kWh` },
        { label: L("g.cp.eta"), value: c.active ? duration(c.etaMin) : DASH },
        { label: L("g.cp.type"), value: c.active ? (c.dc ? "DC" : "AC") : DASH },
        { label: L("g.cp.cells"), value: cellTemps(car, loc).replace(" °C", "°") },
        { label: L("g.cp.stand"), value: standText(state, car) },
      ];
    }
    default:
      return [
        { label: L("g.cp.km"), value: car.battery.odometerKm === null ? DASH : String(Math.round(car.battery.odometerKm)) },
        { label: L("g.cp.climate"), value: yes(state, car.body.acOn, "g.cp.on", "g.cp.off") },
        { label: L("g.cp.lock"), value: yes(state, car.body.locked, "g.cp.locked", "g.cp.unlocked"), ...(car.body.locked === false ? { alert: true } : {}) },
        { label: L("g.cp.doors"), value: yes(state, car.body.doorOpen, "g.cp.open", "g.cp.closed"), ...(car.body.doorOpen === true ? { alert: true } : {}) },
        { label: L("g.cp.tyres"), value: tyres.value, ...(tyres.alert ? { alert: true } : {}) },
        { label: L("g.cp.stand"), value: standText(state, car) },
      ];
  }
}

/** The one statement of a page. */
export function cockpitHeadline(state: ViewState, car: CarState): string[] {
  const L = (key: string): string => t(state.locale, key);
  switch (state.page) {
    case "drive": return [`${car.drive.speed === null ? DASH : Math.round(car.drive.speed)} ${L("g.cp.kmh")}`, ...(car.drive.gear ? [`${car.drive.gear}`] : [])];
    case "charge": {
      const c = car.charge;
      if (c.active) return [`${c.kw === null ? DASH : dec(c.kw, c.kw >= 10 ? 0 : 1, state.locale)} KW`, L("g.cp.charging") + (c.dc ? " DC" : " AC")];
      if (c.done) return [L("g.cp.done"), pct(car.battery.soc).replace(" ", "")];
      return [pct(car.battery.soc).replace(" ", ""), L("g.cp.idle")];
    }
    default: return [car.battery.rangeKm === null ? `${DASH} KM` : km(car.battery.rangeKm).toUpperCase(), L("g.cp.rangeHead")];
  }
}

/** The caption: what counts most right now. */
export function captionFor(state: ViewState, car: CarState): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  if (state.connection.kind === "error") return L("g.row.server", { reason: errorReason(state.locale, state.connection.code, state.connection.status) });
  const worst = activeWarnings(car).find((w) => w.level !== "info");
  if (worst) return warningShort(state.locale, worst);
  if (car.stale) return L("g.stale", { age: ageText(state.locale, car.ageS) });
  if (car.battery.src === "cloud" && car.battery.soc !== null) return L("g.cloud");
  return state.demo ? L("g.cp.demoCaption") : L("g.cp.stand") + " " + hhmm(state.now);
}

/** The cockpit of the drive, charge and status pages. */
export function cockpitModel(state: ViewState): CockpitModel {
  const car = state.car;
  if (!car) throw new Error("the car cockpit needs a car state");
  const tone = carTone(state, car);
  const soc = car.battery.soc;
  return {
    title: state.demo ? "BYD · DEMO" : "BYD",
    clock: hhmm(state.now),
    headline: cockpitHeadline(state, car),
    cells: cockpitCells(state, car),
    graphic: {
      percent: soc === null ? null : Math.max(0, Math.min(100, soc)),
      tone,
      center: soc === null ? DASH : `${Math.round(soc)}%`,
      sub: t(state.locale, "g.cp.soc"),
      charging: car.charge.active && !car.stale,
    },
    caption: captionFor(state, car),
    hint: pageFooter(state, car),
    tone,
  };
}

/** A key that changes exactly when what the cockpit would draw changes. */
export function modelKey(model: CockpitModel): string {
  return JSON.stringify([model.clock, model.headline, model.cells, model.graphic, model.caption, model.hint]);
}

