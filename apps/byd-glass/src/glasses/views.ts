import type { Locale } from "../i18n";
import { t } from "../messages";
import { sortWarnings, type Action, type CarState, type CarWarning } from "../car/model";
import { ageText, deg, dec, duration, km, kw, pct, volt, warningLong, warningShort } from "../format";
import { CONTROL_ITEMS, blockedReason, finalArmed, openConfirm, type Confirm, type ControlItem, type ControlState, type Page } from "../pages";
import type { Bitmap } from "./gfx";
import {
  ICON_STEP_MS, carIcon, chargeBarFrame, chargeKwFrame, chargeSocFrame, energyFrame, lockFrame, speedFrame, tyresFrame,
  type IconKind,
} from "./pics";
import { SIDE_MENU } from "../side-menu";
import { fit, MAX_BODY_ROWS, wrap } from "./screen";
import { armedFooter, footer as gestureFooter } from "./footer";

/**
 * Everything the glasses show, as pure functions of a state snapshot, so every
 * page can be checked against its row widths in both languages.
 */

export type Connection =
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly code: string; readonly status?: number };

/** drive/charge/status: pictures + rows below; plain: full-width text. */
export type Layout = "drive" | "charge" | "status" | "plain";

/** A command result the bridge never saw (refused before sending, unreachable). */
export interface LocalResult {
  readonly action: Action;
  readonly value: number | null;
  readonly reason: string;
  readonly at: number;
}

export interface ViewState {
  readonly locale: Locale;
  readonly demo: boolean;
  readonly connection: Connection;
  readonly car: CarState | null;
  readonly page: Page;
  readonly control: ControlState;
  /** Warnings shown full-screen over any page, or null. */
  readonly overlay: readonly CarWarning[] | null;
  readonly local: LocalResult | null;
  /** The help page is open (side menu). */
  readonly help?: boolean;
  readonly now: number;
}

export interface PageView {
  readonly layout: Layout;
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

export const HEADER_WIDTH = 50;
export const ROW_WIDTH = 56;
/** Rows under the pictures. */
export const ROWS: Readonly<Record<Layout, number>> = { drive: 2, charge: 2, status: 3, plain: MAX_BODY_ROWS };
/** A finished command stays on the control page this long. */
const RESULT_MS = 5 * 60_000;

const rows = (list: readonly string[], max: number): string[] => list.slice(0, max).map((row) => fit(row, ROW_WIDTH));

/**
 * Why the bridge could not be reached, in plain words. The glasses never show a
 * status code (QIS v1.2 #8); the phone passes `detail` and gets it appended.
 */
export function errorReason(locale: Locale, code: string, status?: number, detail = false): string {
  const reason = t(locale, "g.err." + code);
  return detail && code === "http" && status ? `${reason} (${status})` : reason;
}

function onOff(locale: Locale, value: boolean | null): string {
  return t(locale, value === null ? "g.unknown" : value ? "g.on" : "g.off");
}

function cells(car: CarState, locale: Locale): string {
  const { cellTMin: lo, cellTMax: hi } = car.battery;
  if (lo === null && hi === null) return "– °C";
  if (lo === null || hi === null || Math.round(lo) === Math.round(hi)) return deg(lo ?? hi, locale);
  return `${dec(lo, 0, locale)}–${dec(hi, 0, locale)} °C`;
}

export function lockWord(locale: Locale, car: CarState): string {
  const word = t(locale, car.body.locked === null ? "g.lock.unknown" : car.body.locked ? "g.lock.locked" : "g.lock.unlocked");
  return car.body.lockSrc === "cloud" ? t(locale, "g.lock.cloud", { lock: word }) : word;
}

/** The warnings that matter for the header (info only when nothing else). */
export function activeWarnings(car: CarState | null): CarWarning[] {
  return car ? sortWarnings(car.warnings) : [];
}

function pageHeader(state: ViewState, car: CarState): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  switch (state.page) {
    case "drive": return L("g.header.drive", { gear: car.drive.gear ?? "–", soc: socText(state, car), range: km(car.battery.rangeKm) });
    case "charge": return L("g.header.charge", { soc: socText(state, car), kw: car.charge.active ? kw(car.charge.kw, state.locale) : "–" });
    case "status": return L("g.header.status", { lock: lockWord(state.locale, car), soc: socText(state, car) });
    case "control": {
      const confirm = openConfirm(state.control, state.now);
      if (confirm) return L(confirm.step === "final" ? "g.header.final" : "g.header.confirm", { step: confirm.step === "final" ? 2 : 1 });
      return L("g.header.control", { ac: onOff(state.locale, car.body.acOn) });
    }
  }
}

/** Header: the worst warning pulsing, otherwise the page summary. */
function header(state: ViewState, car: CarState): string {
  const list = activeWarnings(car);
  const worst = list[0];
  let out: string;
  const confirming = state.page === "control" && openConfirm(state.control, state.now) !== null;
  if (worst && worst.level !== "info" && !confirming) {
    const text = warningShort(state.locale, worst);
    const on = Math.floor(state.now / ICON_STEP_MS) % 2 === 0;
    out = worst.level === "crit" ? (on ? `!! ${text} !!` : `   ${text}   `) : text;
  } else {
    out = pageHeader(state, car);
  }
  if (state.demo) out += " · " + t(state.locale, "g.demo");
  return fit(appHeader(out), HEADER_WIDTH);
}

/** QIS v1 header: "BYD · state". */
function appHeader(state: string): string {
  return "BYD · " + state;
}

function staleRow(state: ViewState, car: CarState): string | null {
  if (state.connection.kind === "error") {
    return t(state.locale, "g.row.server", { reason: errorReason(state.locale, state.connection.code, state.connection.status) });
  }
  return car.stale ? t(state.locale, "g.stale", { age: ageText(state.locale, car.ageS) }) : null;
}

function driveRows(state: ViewState, car: CarState): string[] {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const first = L("g.drive.cons", { cons: dec(car.drive.cons50, 1, state.locale), trip: dec(car.drive.tripKm, 1, state.locale) });
  const second = staleRow(state, car)
    ?? L("g.drive.extra", { ext: deg(car.body.extTemp, state.locale), ac: onOff(state.locale, car.body.acOn), v12: volt(car.battery.volt12, state.locale) });
  return rows([first, second], ROWS.drive);
}

function chargeRows(state: ViewState, car: CarState): string[] {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const c = car.charge;
  let first: string;
  if (c.active) first = L("g.charge.eta", { eta: duration(c.etaMin), kwh: dec(c.kwh, 1, state.locale), type: L(c.dc ? "g.charge.dc" : "g.charge.ac") });
  else if (c.done) first = L("g.charge.done", { soc: pct(car.battery.soc) });
  else first = L("g.charge.idle", { soc: pct(car.battery.soc), range: km(car.battery.rangeKm) });
  const second = staleRow(state, car) ?? L("g.charge.range", { range: km(car.battery.rangeKm), cells: cells(car, state.locale) });
  return rows([first, second], ROWS.charge);
}

/** The charge level; marked when it comes from the BYD cloud (the car itself is silent, values lag behind). */
function socText(state: ViewState, car: CarState): string {
  return pct(car.battery.soc) + (car.battery.src === "cloud" && car.battery.soc !== null ? " " + t(state.locale, "g.cloud") : "");
}

function statusRows(state: ViewState, car: CarState): string[] {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const doors = car.body.doorOpen === null ? L("g.unknown") : L(car.body.doorOpen ? "g.doors.open" : "g.doors.closed");
  const age = car.stale ? ageText(state.locale, car.ageS) : L("g.live");
  return rows([
    L("g.status.1", { lock: lockWord(state.locale, car), doors, v12: volt(car.battery.volt12, state.locale) }),
    L("g.status.2", { soh: pct(car.battery.soh), cells: cells(car, state.locale), ext: deg(car.body.extTemp, state.locale) }),
    state.connection.kind === "error" ? (staleRow(state, car) ?? "") : L("g.status.3", { ac: onOff(state.locale, car.body.acOn), setpoint: deg(car.body.setpoint, state.locale), age }),
  ], ROWS.status);
}

// ---- control ------------------------------------------------------------------

/** What pybyd-mqtt really sends without the extension: heat 26 or cool 19. */
export function mappedTemp(temp: number): number {
  return temp >= 22 ? 26 : 19;
}

export function itemLabel(locale: Locale, item: ControlItem, temp: number, car: CarState | null): string {
  if (item === "climate_on") {
    const free = car?.control.climateTemp ?? true;
    return free ? t(locale, "g.ctl.climate_on", { temp }) : t(locale, "g.ctl.climate_on.mapped", { temp, sent: mappedTemp(temp) });
  }
  return t(locale, "g.ctl." + item);
}

export function actionLabel(locale: Locale, action: Action, value: number | null): string {
  return action === "climate_on" ? t(locale, "g.ctl.climate_on", { temp: value ?? "?" }) : t(locale, "g.ctl." + action);
}

export function reasonText(locale: Locale, code: string): string {
  const key = "g.reason." + code;
  const text = t(locale, key);
  return text === key ? t(locale, "g.reason.other", { code }) : text;
}

/** The last command and how it went, newest of bridge state and local refusals. */
export function resultRow(state: ViewState): string | null {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const command = state.car?.command ?? null;
  const local = state.local;
  if (local && (!command || local.at >= command.at) && state.now - local.at < RESULT_MS) {
    return L("g.ctl.refused", { label: actionLabel(state.locale, local.action, local.value), reason: reasonText(state.locale, local.reason) });
  }
  if (command && state.now - command.at < RESULT_MS) {
    const label = actionLabel(state.locale, command.action, command.value);
    return L("g.ctl." + command.status, { label, text: command.text.replace(/^\W+\s*/u, "").slice(0, 24) });
  }
  return null;
}

function controlRows(state: ViewState): string[] {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const car = state.car;
  const available = car?.control ?? { enabled: false, lock: false, unlock: false };
  const confirm = openConfirm(state.control, state.now);
  if (confirm) return rows(confirmRows(state, confirm), ROWS.plain);
  const carOn = car?.carOn === true;
  const list = CONTROL_ITEMS.map((item, index) => {
    const label = itemLabel(state.locale, item, state.control.temp, car);
    const reason = carOn ? null : blockedReason(item, car, available);
    const text = carOn ? L("g.ctl.disabled", { label }) : reason ? L("g.ctl.blocked", { label, reason: reasonText(state.locale, reason) }) : label;
    return (index === state.control.cursor ? "> " : "  ") + text;
  });
  const top = carOn ? [L("g.ctl.carOn"), ""] : [];
  const last = resultRow(state) ?? (car ? L("g.ctl.info", { ext: deg(car.body.extTemp, state.locale), ac: onOff(state.locale, car.body.acOn), setpoint: deg(car.body.setpoint, state.locale) }) : "");
  // Seven rows: [car-on banner, gap,] four items, [gap,] last command / info.
  return rows(carOn ? [...top, ...list, last] : [...list, "", last], ROWS.plain);
}

/** Upper-case name of the command for the confirmation screens. */
function shout(locale: Locale, item: ControlItem, temp: number): string {
  return t(locale, "g.cf.name." + item, { temp }).toUpperCase();
}

/**
 * The three confirmation screens look deliberately different, so the second
 * cannot be mistaken for the first and tapped through.
 */
function confirmRows(state: ViewState, confirm: Confirm): string[] {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const temp = state.control.temp;
  if (confirm.step === "temp") {
    const free = state.car?.control.climateTemp ?? true;
    return [
      L("g.cf.temp.title"),
      "",
      "        ↑   " + L("g.cf.temp.value", { temp }) + "   ↓",
      "",
      free ? L("g.cf.temp.hint") : L("g.cf.temp.mapped", { sent: mappedTemp(temp) }),
      "",
      L("g.cf.temp.next"),
    ];
  }
  if (confirm.step === "first") {
    return [
      L("g.cf.first." + confirm.item, { temp }),
      "",
      L("g.cf.first.tap"),
      L("g.cf.first.cancel"),
    ];
  }
  const bar = "═".repeat(30);
  return [
    "",
    "   " + bar,
    "   " + L("g.cf.final.title"),
    "   >>>  " + shout(state.locale, confirm.item, temp) + "  <<<",
    "   " + bar,
    "",
    finalArmed(confirm, state.now) ? L("g.cf.final.tap") : L("g.cf.final.wait"),
  ];
}

// ---- overlay --------------------------------------------------------------------

function overlayView(state: ViewState, list: readonly CarWarning[]): PageView {
  const on = Math.floor(state.now / ICON_STEP_MS) % 2 === 0;
  const n = list.length;
  const lines = list.slice(0, MAX_BODY_ROWS - 1).map((w) => "• " + warningLong(state.locale, w));
  if (n > MAX_BODY_ROWS - 1) lines.push(t(state.locale, "g.overlay.more", { n: n - (MAX_BODY_ROWS - 1) }));
  const head = t(state.locale, on ? "g.overlay.header" : "g.overlay.headerOff", { n }) + (state.demo ? " · " + t(state.locale, "g.demo") : "");
  // Tap closes the warnings; 2× is back (it used to leave the app from here).
  return { layout: "plain", header: fit(appHeader(head), HEADER_WIDTH), body: rows(lines, MAX_BODY_ROWS), footer: gestureFooter(state.locale, { tap: t(state.locale, "g.a.ok") }, "back") };
}

// ---- assembly -------------------------------------------------------------------

function footer(state: ViewState, car: CarState): string {
  const L = (key: string): string => t(state.locale, key);
  if (state.page === "control") {
    const confirm = openConfirm(state.control, state.now);
    // The car commands keep both confirmations; a swipe, a hold or 2x cancel (QIS v1 arm-and-confirm).
    if (confirm?.step === "temp") return gestureFooter(state.locale, { tap: L("g.a.next"), swipe: L("g.a.temp") }, "back");
    if (confirm?.step === "first") return armedFooter(state.locale, L("g.a.next"));
    if (confirm) return armedFooter(state.locale, L("g.a.send"));
    return gestureFooter(state.locale, { tap: L("g.a.choose"), swipe: L("g.a.select"), ...(SIDE_MENU ? {} : { hold: L("g.a.help") }) }, "exit");
  }
  // QIS v1.2 #7: in the demo the one-line hint leads; the gestures that still fit follow.
  return gestureFooter(state.locale, {
    ...(car.warnings.length > 0 ? { tap: L("g.a.warnings") } : {}),
    swipe: L("g.a.page"),
    ...(SIDE_MENU ? {} : { hold: L("g.a.help") }),
  }, "exit", state.demo ? L("g.demoHint") : "");
}

/** The gestures, in footer order, and what the app needs. */
function helpView(state: ViewState): PageView {
  const L = (key: string): string => t(state.locale, key);
  return {
    layout: "plain",
    header: fit(appHeader(L("g.s.help") + (state.demo ? " · " + L("g.demo") : "")), HEADER_WIDTH),
    body: rows([1, 2, 3, 4, 5, 6, 7].map((n) => L("g.help." + n)), MAX_BODY_ROWS),
    footer: gestureFooter(state.locale, {}, "back"),
  };
}

export function buildView(state: ViewState): PageView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  if (state.overlay && state.overlay.length > 0) return overlayView(state, state.overlay);
  if (state.help) return helpView(state);
  const car = state.car;
  if (!car) {
    const word = state.connection.kind === "error" ? L("g.state.noServer") : L("g.state.loading");
    const reason = state.connection.kind === "error" ? errorReason(state.locale, state.connection.code, state.connection.status) : "";
    return {
      layout: "plain",
      header: fit(appHeader(word + (state.demo ? " · " + L("g.demo") : "")), HEADER_WIDTH),
      body: rows([reason, "", ...wrap(L("p.notice"), ROW_WIDTH)], MAX_BODY_ROWS),
      footer: gestureFooter(state.locale, SIDE_MENU ? {} : { hold: L("g.a.help") }, "exit"),
    };
  }
  const head = header(state, car);
  switch (state.page) {
    case "drive": return { layout: "drive", header: head, body: driveRows(state, car), footer: footer(state, car) };
    case "charge": return { layout: "charge", header: head, body: chargeRows(state, car), footer: footer(state, car) };
    case "status": return { layout: "status", header: head, body: statusRows(state, car), footer: footer(state, car) };
    case "control": return { layout: "plain", header: head, body: controlRows(state), footer: footer(state, car) };
  }
}

// ---- pictures -------------------------------------------------------------------

export function iconKind(state: ViewState): IconKind {
  const car = state.car;
  if (!car) return state.connection.kind === "error" ? "offline" : "loading";
  if (state.overlay?.length || car.warnings.some((w) => w.level === "crit")) return "alert";
  if (state.connection.kind === "error" || car.stale) return "offline";
  return car.mode === "driving" ? "drive" : car.mode === "charging" ? "charge" : "park";
}

export interface Frames {
  readonly icon: Bitmap;
  readonly a?: Bitmap;
  readonly b?: Bitmap;
  readonly c?: Bitmap;
}

export function buildFrames(state: ViewState, layout: Layout): Frames {
  const car = state.car;
  const P = (key: string): string => t(state.locale, "pic." + key);
  const icon = carIcon(iconKind(state), state.now, {
    left: !!car && car.mode === "driving" && (car.drive.turnLeft || car.drive.hazard),
    right: !!car && car.mode === "driving" && (car.drive.turnRight || car.drive.hazard),
    highBeam: !!car && car.mode === "driving" && car.drive.highBeam,
  });
  if (!car || layout === "plain") return { icon };
  if (layout === "drive") {
    return {
      icon,
      a: speedFrame({ speed: car.drive.speed, gear: car.drive.gear, limitWarn: car.drive.limitWarn, stale: car.stale, unit: P("kmh"), limitLabel: P("limit") }),
      b: energyFrame({ soc: car.battery.soc, rangeKm: car.battery.rangeKm, powerKw: car.drive.powerKw, km: P("km"), kw: P("kw"), regen: P("regen") }),
    };
  }
  if (layout === "charge") {
    const c = car.charge;
    return {
      icon,
      a: chargeSocFrame(car.battery.soc, car.battery.rangeKm, P("km")),
      b: chargeKwFrame({ kw: c.active ? c.kw : null, dc: c.dc, etaMin: c.active ? c.etaMin : null, done: c.done && !c.active, kwLabel: P("kw"), minLabel: P("min"), doneLabel: P("done") }),
      c: chargeBarFrame(car.battery.soc, state.now, c.active && !car.stale),
    };
  }
  const tyre = (w: "fl" | "fr" | "rl" | "rr") => ({
    text: car.tyres[w].kpa === null ? null : dec(car.tyres[w].kpa! / 100, 1, state.locale),
    leak: car.tyres[w].leak,
    low: car.tyres[w].low,
  });
  return {
    icon,
    a: tyresFrame({ fl: tyre("fl"), fr: tyre("fr"), rl: tyre("rl"), rr: tyre("rr") }),
    b: lockFrame({
      locked: car.body.locked,
      doorOpen: car.body.doorOpen === true,
      word: P(car.body.locked === null ? "unknown" : car.body.locked ? "locked" : "unlocked"),
      doorWord: P("door"),
    }),
  };
}

/** For the phone page: "Reifen HR …, 12 V schwach …". */
export function warningList(locale: Locale, car: CarState | null): string {
  return activeWarnings(car).map((w) => warningShort(locale, w)).join(" · ");
}

