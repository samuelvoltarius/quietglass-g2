import type { Locale } from "../i18n";
import { t } from "../messages";
import { alerts, isCritical, type Alert, type Limits } from "../ns/alerts";
import { delta, type Direction, type PumpStatus, type Reading, type SugarData } from "../ns/model";
import { glucose, insulin, signedDelta, unitLabel, type Unit } from "../ns/units";
import { ICON_STEP_MS, curveFrame, dropFrame, valueFrame, type Mood } from "./charts";
import type { Bitmap } from "./gfx";
import { footer as qisFooter } from "./footer";
import { fit, MAX_BODY_ROWS } from "./screen";

/**
 * Everything the glasses show, as pure functions of a state snapshot, so every
 * page can be checked against its row widths in both languages.
 */

export type Connection =
  | { readonly kind: "setup" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly code: string; readonly status?: number };

export type Page = "glucose" | "pump";
export const PAGES: readonly Page[] = ["glucose", "pump"];

/** "glucose": value + curve pictures and two text rows; "plain": full-width text. */
export type Layout = "glucose" | "plain";

export interface ViewState {
  readonly locale: Locale;
  readonly demo: boolean;
  readonly connection: Connection;
  readonly data: SugarData | null;
  readonly page: Page;
  /** The help page is open (a hold, or the side menu when it is on; 2× closes it). */
  readonly help?: boolean;
  readonly unit: Unit;
  readonly limits: Limits;
  /** Wall clock (animation, "x min ago"). */
  readonly now: number;
  /** First start without a server address: the values are a demo and the glasses say how to set up the real thing (QIS v1.2 no. 7). */
  readonly demoHint?: boolean;
}

export interface PageView {
  readonly layout: Layout;
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

export const HEADER_WIDTH = 50;
export const ROW_WIDTH = 56;

/**
 * The glasses' side menu (QIS v1.2). Off: its clicks never reach the app on the real glasses and a hold
 * opens the menu instead of reaching the app (step log of 15.10.2026), so a hold opens the help again.
 */
export const SIDE_MENU = false;
/** Rows under the pictures on the glucose page. */
export const GLUCOSE_ROWS = 2;

/**
 * Why something failed, in plain words. The glasses never show a status code (QIS v1.2 no. 8);
 * the phone asks with `detail` and gets "Fehler (HTTP 503)".
 */
export function errorReason(locale: Locale, code: string, status?: number, detail = false): string {
  if (detail && code === "http") return t(locale, "p.err.httpDetail", { status: status ?? 0 });
  return t(locale, "g.err." + code, { status: status ?? 0 });
}

/** "vor 3 min", "vor 1 h 05". */
export function ageText(locale: Locale, ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return t(locale, "g.age.now");
  if (minutes < 60) return t(locale, "g.age.min", { n: minutes });
  return t(locale, "g.age.h", { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, "0") });
}

/** "3 MIN" / "2 H" for the picture. */
export function ageShort(locale: Locale, ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 100 ? t(locale, "g.ageShort", { n: minutes }) : t(locale, "g.ageShortH", { n: Math.floor(minutes / 60) });
}

/** For the phone page: Unicode arrows are fine there. */
export function arrowText(direction: Direction): string {
  const map: Partial<Record<Direction, string>> = {
    TripleUp: "⇈↑", DoubleUp: "⇈", SingleUp: "↑", FortyFiveUp: "↗", Flat: "→",
    FortyFiveDown: "↘", SingleDown: "↓", DoubleDown: "⇊", TripleDown: "⇊↓",
  };
  return map[direction] ?? "?";
}

export function currentAlerts(state: ViewState): Alert[] {
  if (!state.data) return [];
  return alerts(state.data.readings, state.limits, state.now);
}

/** Header: the worst alert, pulsing between two forms, otherwise value + age. */
function header(state: ViewState, list: readonly Alert[]): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const newest = state.data?.readings[0];
  const unit = unitLabel(state.unit);
  const value = newest ? glucose(newest.mgdl, state.unit, state.locale) : "–";
  const age = newest ? ageText(state.locale, state.now - newest.at) : "";
  const worst = list[0];
  const app = L("g.app");
  let out: string;
  if (worst && worst.kind !== "noData") {
    const text = L("g.alert." + worst.kind, { value, unit, age });
    // Pulses: the marks come and go with the sign's animation step.
    const on = Math.floor(state.now / ICON_STEP_MS) % 2 === 0;
    out = `${app} · ` + (worst.critical ? (on ? `!! ${text} !!` : `   ${text}   `) : text);
  } else if (state.page === "pump") {
    out = `${app} · ` + L("g.header.pump", { device: state.data?.pump?.device ?? "–" });
  } else if (newest) {
    out = `${app} · ` + L("g.header.value", { value, unit, age });
  } else {
    out = L("g.header.noValue", { page: app, state: L("g.state.noData") });
  }
  // An alert needs the whole row: the app name leaves first when the line would be cut.
  if (out.length > HEADER_WIDTH && out.startsWith(`${app} · `)) out = out.slice(app.length + 3);
  // The demo mark only when it still fits next to the state.
  const demo = " · " + L("g.demo");
  if ((state.demo || state.demoHint) && out.length + demo.length <= HEADER_WIDTH) out += demo;
  return fit(out, HEADER_WIDTH);
}

/** QIS v1 footer: Tippen / Wischen / Halten / 2×, page indicator in front. */
function footer(state: ViewState): string {
  const L = (key: string): string => t(state.locale, key);
  const index = PAGES.indexOf(state.page) + 1;
  return fit(qisFooter(state.locale, {
    tap: L("g.f.reload"),
    swipe: L(state.page === "glucose" ? "g.f.toPump" : "g.f.toValue"),
    hold: L(SIDE_MENU ? "g.f.menu" : "g.f.help"),
  }, "exit", `${index}/${PAGES.length}`), ROW_WIDTH);
}

/** No data yet: nothing to switch between. */
function plainFooter(state: ViewState, tap: boolean): string {
  const L = (key: string): string => t(state.locale, key);
  return fit(qisFooter(state.locale, { ...(tap ? { tap: L("g.f.reload") } : {}), hold: L(SIDE_MENU ? "g.f.menu" : "g.f.help") }, "exit"), ROW_WIDTH);
}

function helpView(state: ViewState): PageView {
  const L = (key: string): string => t(state.locale, key);
  const body = [1, 2, 3, 4, 5, 6, 7].map((n) => L("g.help." + n));
  return { layout: "plain", header: fit(`${L("g.app")} · ${L("g.h.help")}`, HEADER_WIDTH), body: rows(body), footer: qisFooter(state.locale, {}, "back") };
}

const rows = (list: readonly string[], max = MAX_BODY_ROWS): string[] => list.slice(0, max).map((row) => fit(row, ROW_WIDTH));

function modeShort(locale: Locale, pump: PumpStatus): string {
  return t(locale, "g.mode." + (pump.mode ?? "unknown"));
}

function glucoseRows(state: ViewState): string[] {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const readings = state.data?.readings ?? [];
  const unit = unitLabel(state.unit);
  const low = glucose(state.limits.targetLow, state.unit, state.locale);
  const high = glucose(state.limits.targetHigh, state.unit, state.locale);
  const stale = currentAlerts(state).some((a) => a.kind === "stale");
  const change = stale ? null : delta(readings);
  const first = state.connection.kind === "error"
    ? L("g.row.server", { reason: errorReason(state.locale, state.connection.code, state.connection.status) })
    : change === null ? L("g.row.noDelta", { low, high }) : L("g.row.delta", { delta: signedDelta(change, state.unit, state.locale), unit, low, high });
  const pump = state.data?.pump;
  // First start: the demo says how to set up the real thing (information only, as always).
  const second = state.demoHint ? L("g.demoHint") : pump
    ? L("g.row.pump", {
      iob: pump.iob === null ? "–" : insulin(pump.iob, state.locale),
      reservoir: pump.reservoir === null ? "–" : insulin(pump.reservoir, state.locale),
      mode: modeShort(state.locale, pump),
    })
    : L("g.notice2");
  return rows([first, second], GLUCOSE_ROWS);
}

function percent(value: number | null): string {
  return value === null ? "–" : `${Math.round(value)} %`;
}

function sensorRow(state: ViewState, pump: PumpStatus): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const hours = pump.sensorHours;
  const left = hours === null ? "–" : hours >= 24
    ? L("g.pump.sensorLeft", { d: Math.floor(hours / 24), h: Math.round(hours % 24) })
    : L("g.pump.sensorHours", { h: Math.round(hours) });
  const raw = pump.sensorState ?? "";
  const known = raw && t(state.locale, "g.sensor." + raw) !== "g.sensor." + raw;
  const word = !raw ? "–" : known ? L("g.sensor." + raw) : L("g.sensor.other", { state: raw.toLowerCase().replace(/_/g, " ") });
  return L("g.pump.sensor", { left, state: word });
}

function pumpRows(state: ViewState): string[] {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const pump = state.data?.pump;
  if (!pump) return rows([L("g.pump.none"), L("g.pump.none2"), "", "", "", "", L("g.pump.notice")]);
  const treatments = state.data?.treatments;
  const meal = treatments?.lastCarbs || treatments?.lastBolus
    ? L("g.pump.meal", {
      grams: treatments.lastCarbs ? Math.round(treatments.lastCarbs.grams) : "–",
      age: treatments.lastCarbs ? ageText(state.locale, state.now - treatments.lastCarbs.at) : "",
      units: treatments.lastBolus ? insulin(treatments.lastBolus.units, state.locale) : "–",
      bolusAge: treatments.lastBolus ? ageText(state.locale, state.now - treatments.lastBolus.at) : "",
    }).replace(/\s+/g, " ")
    : L("g.pump.noMeal");
  return rows([
    L("g.pump.mode", { mode: L("g.pump.mode." + (pump.mode ?? "unknown")) }),
    L("g.pump.iob", { iob: pump.iob === null ? "–" : insulin(pump.iob, state.locale) }),
    L("g.pump.reservoir", { reservoir: pump.reservoir === null ? "–" : insulin(pump.reservoir, state.locale), battery: percent(pump.battery) }),
    sensorRow(state, pump),
    state.demoHint ? L("g.demoHint") : L("g.pump.phone", { battery: percent(pump.uploaderBattery), age: pump.at === null ? "–" : ageText(state.locale, state.now - pump.at) }),
    meal,
    L("g.pump.notice"),
  ]);
}

export function buildView(state: ViewState): PageView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  if (state.help) return helpView(state);
  if (state.connection.kind === "setup") {
    return { layout: "plain", header: fit(`${L("g.app")} · ${L("g.h.setup")}`, HEADER_WIDTH), body: rows([L("g.setup.1"), L("g.setup.2"), "", L("g.notice"), L("g.notice2")]), footer: plainFooter(state, false) };
  }
  if (!state.data) {
    const word = state.connection.kind === "error" ? L("g.state.noServer") : L("g.state.loading");
    const reason = state.connection.kind === "error" ? errorReason(state.locale, state.connection.code, state.connection.status) : "";
    return {
      layout: "plain",
      header: fit(L("g.header.noValue", { page: L("g.app"), state: word }) + (state.demo ? " · " + L("g.demo") : ""), HEADER_WIDTH),
      body: rows([reason ? L("g.row.server", { reason }).replace(/ –.*$/, "") : "", "", L("g.notice"), L("g.notice2")]),
      footer: plainFooter(state, true),
    };
  }
  const list = currentAlerts(state);
  if (state.page === "pump") return { layout: "plain", header: header(state, list), body: pumpRows(state), footer: footer(state) };
  return { layout: "glucose", header: header(state, list), body: glucoseRows(state), footer: footer(state) };
}

// ---- pictures ---------------------------------------------------------------

export function moodFor(state: ViewState): Mood {
  if (state.connection.kind === "setup" || (state.connection.kind === "error" && !state.data)) return "offline";
  if (!state.data) return "loading";
  return isCritical(currentAlerts(state)) ? "alert" : "ok";
}

export interface Frames {
  readonly icon: Bitmap;
  readonly value?: Bitmap;
  readonly curve?: Bitmap;
}

/** The alarm word for the value picture: the worst critical glucose alert. */
function labelFor(state: ViewState, list: readonly Alert[]): string | null {
  const worst = list.find((a) => a.critical && a.kind !== "noData");
  return worst ? t(state.locale, "g.label." + worst.kind) : null;
}

export function buildFrames(state: ViewState, layout: Layout): Frames {
  const icon = dropFrame(moodFor(state), state.now);
  if (layout !== "glucose" || !state.data) return { icon };
  const readings: readonly Reading[] = state.data.readings;
  const newest = readings[0];
  const list = currentAlerts(state);
  const change = delta(readings);
  const stale = list.some((a) => a.kind === "stale");
  const value = valueFrame({
    value: newest ? glucose(newest.mgdl, state.unit, state.locale) : null,
    direction: newest?.direction ?? "NONE",
    delta: change === null || stale ? null : signedDelta(change, state.unit, state.locale),
    unit: state.unit === "mgdl" ? "MG/DL" : "MMOL",
    age: newest ? ageShort(state.locale, state.now - newest.at) : "",
    label: labelFor(state, list),
    stale,
  });
  // Anchored to the newest reading, not the clock: the curve only changes with a new value.
  const anchor = newest ? newest.at : Math.floor(state.now / 300_000) * 300_000;
  const curve = curveFrame({
    readings,
    now: anchor,
    hours: 3,
    targetLow: state.limits.targetLow,
    targetHigh: state.limits.targetHigh,
    urgentLow: state.limits.urgentLow,
    lowLabel: glucose(state.limits.targetLow, state.unit, state.locale),
    highLabel: glucose(state.limits.targetHigh, state.unit, state.locale),
  });
  return { icon, value, curve };
}
