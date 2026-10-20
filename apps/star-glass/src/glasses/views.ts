import type { Locale } from "../i18n";
import { t } from "../messages";
import { alerts, type Alert } from "../nina/alerts";
import { availableCommands, decimal, type Command, type StarStatus } from "../nina/status";
import type { Forecast } from "../weather/forecast";
import { DEFAULT_THRESHOLDS, inMinutes, type Thresholds, type WeatherWarning } from "../weather/warnings";
import { armedFooter, footer as qisFooter } from "./footer";
import { fit, marked, MAX_BODY_ROWS } from "./screen";

/**
 * What the glasses show besides the cockpit pictures (src/cockpit): the start
 * page (at most three big entries) and the control list, as pure functions of
 * a state snapshot so both can be checked against their row widths in both
 * languages (QUS v1).
 */

export type Connection =
  | { readonly kind: "setup" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly code: string; readonly status?: number };

/** The cockpit pages. */
export type Page = "overview" | "guiding" | "equipment" | "weather" | "image";
/** The start page's entries (QUS v1: at most three). */
export type Mode = "capture" | "weather" | "image";
export const MODES: readonly Mode[] = ["capture", "weather", "image"];
/** A swipe walks through the pages of the open mode. */
export const MODE_PAGES: Readonly<Record<Mode, readonly Page[]>> = {
  capture: ["overview", "guiding", "equipment"],
  weather: ["weather"],
  image: ["image"],
};
export const PAGES: readonly Page[] = MODES.flatMap((mode) => MODE_PAGES[mode]);
export const modeOf = (page: Page): Mode => MODES.find((mode) => MODE_PAGES[mode].includes(page)) ?? "capture";

/** What is on the glasses: the start page, a cockpit page, or the control list. */
export type Screen = "start" | "run" | "control";

/** Where the forecast's coordinates came from. */
export type WeatherLocation = "nina" | "manual" | "phone" | "pending" | "none";

/** The weather part of the state (forecast, warnings). */
export interface WeatherView {
  readonly enabled: boolean;
  readonly forecast: Forecast | null;
  readonly warnings: readonly WeatherWarning[];
  readonly location: WeatherLocation;
  /** Last fetch problem: "timeout", "unreachable", "bad-reply" or "HTTP 503". */
  readonly error: string | null;
  readonly thresholds: Thresholds;
}

export const NO_WEATHER: WeatherView = { enabled: true, forecast: null, warnings: [], location: "pending", error: null, thresholds: DEFAULT_THRESHOLDS };

export type ControlRow = Command | "back";

export interface ViewState {
  readonly locale: Locale;
  readonly demo: boolean;
  readonly connection: Connection;
  readonly status: StarStatus | null;
  /** Seconds since that status arrived (the exposure is counted down locally). */
  readonly ageSeconds: number;
  readonly screen: Screen;
  /** The cockpit page of the run screen. */
  readonly page: Page;
  /** The cursor of the start page. */
  readonly startCursor: number;
  /** The cursor of the control list. */
  readonly cursor: number;
  readonly armed: Command | null;
  readonly sending: boolean;
  readonly message: string;
  /** Whether a preview picture is on hand for the image page. */
  readonly hasPreview: boolean;
  /** Wall clock, for the clock, the countdown and "x min ago". */
  readonly now: number;
  /** Forecast and warnings; missing = nothing known yet. */
  readonly weather?: WeatherView;
  /** Minutes east of UTC for clock times (default: the phone's). */
  readonly utcOffset?: number;
  /** First start without a bridge: the night is a demo and says how to set up the real one. */
  readonly demoHint?: boolean;
}

/** A text page: the start page and the control list. */
export interface PageView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

/** Characters per row. */
export const HEADER_WIDTH = 50;
export const ROW_WIDTH = 56;

export function controlRows(status: StarStatus | null): ControlRow[] {
  return [...availableCommands(status), "back"];
}

/**
 * The glasses' side menu. Off: its clicks never reach the app on the real glasses and a hold
 * opens the menu instead of reaching the app (step log of 15.10.2026).
 */
export const SIDE_MENU = false;

/**
 * Seconds left as shown (text and ring alike): 5-second steps above half a
 * minute, so the ring picture only changes every few seconds.
 */
export function shownRemaining(left: number | null): number | null {
  if (left === null) return null;
  return left > 30 ? Math.ceil(left / 5) * 5 : Math.ceil(left);
}

/**
 * Why something failed, in plain words. The glasses never show a status code;
 * the phone asks with `detail` and gets "Fehler (HTTP 503)".
 */
export function errorReason(locale: Locale, code: string, status?: number, detail = false): string {
  if (detail && code === "http") return t(locale, "p.err.httpDetail", { status: status ?? 0 });
  return t(locale, "g.err." + code, { status: status ?? 0 });
}

export function weatherError(locale: Locale, error: string): string {
  // No status code on the glasses: "HTTP 503" is just "server error" here.
  if (/^HTTP \d+$/.test(error)) return t(locale, "g.err.http");
  return t(locale, "g.err." + (["timeout", "unreachable", "bad-reply"].includes(error) ? error : "bad-reply"));
}

export function alertText(alert: Alert, locale: Locale): string {
  return t(locale, "g.alert." + alert.kind, alert.vars);
}

/** One weather warning in words: "Wolken in ~40 min (75 %)". */
export function warningText(warning: WeatherWarning, locale: Locale): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const when = inMinutes(warning.minutes);
  const value = warning.kind === "dew" ? decimal(warning.value, 1, locale) : String(warning.value);
  if (warning.kind === "rain" && warning.raining) return warning.source === "station" ? L("g.wx.rain.sensor") : L("g.wx.rain.now", { value });
  return warning.minutes === 0 ? L(`g.wx.${warning.kind}.now`, { value }) : L(`g.wx.${warning.kind}.soon`, { value, in: when });
}

// ---- header ---------------------------------------------------------------------

export type LiveWord = "live" | "offline" | "demo" | "loading";

/** `live` while N.I.N.A. answers, `demo` for the sample night, `loading` before the first answer, `offline` otherwise. */
export function liveWord(state: Pick<ViewState, "connection" | "status" | "demo" | "demoHint">): LiveWord {
  if (state.demo || state.demoHint) return "demo";
  if (state.connection.kind === "loading") return "loading";
  return state.connection.kind === "ok" && state.status?.online ? "live" : "offline";
}

/** `Star Glass · ● live` (QUS v1): the mode, a dot while live, the state as a word otherwise. */
export function headerLine(locale: Locale, title: string, word: LiveWord): string {
  const state = word === "live" ? "● " + t(locale, "g.live")
    : word === "demo" ? t(locale, "g.demoWord")
      : word === "loading" ? t(locale, "g.loadingWord")
        : t(locale, "g.offlineWord");
  return fit(`${title} · ${state}`, HEADER_WIDTH);
}

// ---- start page -------------------------------------------------------------------

/** The sequence state as a lower-case word. */
function sequenceWord(state: ViewState): string {
  const s = state.status;
  if (!s?.online) return "";
  if (s.exposure.active && s.sequence.state !== "running") return t(state.locale, "g.state.exposing");
  return t(state.locale, "g.state." + s.sequence.state);
}

/** The label of one start entry, with the one fact that tells whether to open it. */
export function startLabel(mode: Mode, state: ViewState): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const name = L("g.start." + mode);
  const s = state.status?.online ? state.status : null;
  let fact = "";
  if (mode === "capture") fact = s ? sequenceWord(state) : "";
  else if (mode === "weather") fact = (state.weather?.warnings.length ?? 0) > 0 ? L("g.start.warn") : "";
  else fact = s && s.images > 0 ? L("g.start.images", { count: s.images }) : "";
  return fact ? `${name} · ${fact}` : name;
}

/** The one line below the entries: the sign-up hint of the first start, else what needs attention. */
function startNote(state: ViewState): string {
  const L = (key: string): string => t(state.locale, key);
  if (state.demoHint) return L("g.demoHint");
  const list = alerts(state.status);
  const worst = list.find((alert) => alert.level !== "info") ?? list[0];
  if (worst) return alertText(worst, state.locale);
  const warning = state.weather?.warnings[0];
  return warning ? warningText(warning, state.locale) : "";
}

/** Start page: at most three big entries, the cursor is a dot (QUS v1.1). */
export function buildStartView(state: ViewState): PageView {
  const L = (key: string): string => t(state.locale, key);
  const at = Math.min(Math.max(0, state.startCursor), MODES.length - 1);
  const rows = MODES.map((mode, index) => fit((index === at ? "● " : "  ") + startLabel(mode, state), ROW_WIDTH));
  const note = startNote(state);
  return {
    header: headerLine(state.locale, L("g.startTitle"), liveWord(state)),
    body: note ? [...rows, "", fit(note, ROW_WIDTH)] : rows,
    footer: qisFooter(state.locale, { tap: L("g.f.open"), swipe: L("g.f.select") }, "exit"),
  };
}

// ---- control list -------------------------------------------------------------------

const rows = (list: readonly string[], width: number): string[] => list.slice(0, MAX_BODY_ROWS).map((row) => fit(row, width));

export function buildControlView(state: ViewState): PageView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const status = state.status;
  const target = status?.online ? status.sequence.target ?? "" : "";
  const list = controlRows(status);
  const body = list.map((row, index) => marked(L("g.control." + row), index === state.cursor));
  if (list.length === 1) body.unshift(L("g.control.none"), "");
  body.push("");
  const armedLabel = state.armed ? L("g.control.do." + state.armed) : "";
  if (state.sending) body.push(L("g.control.sending"));
  else body.push(state.message);
  const head = state.armed ? L("g.control.title." + state.armed) : L("g.control.header", { target });
  const foot = state.armed
    ? armedFooter(state.locale, armedLabel)
    : qisFooter(state.locale, { tap: L("g.f.ok"), swipe: L("g.f.choose") }, "back");
  return { header: fit(`${L("g.app")} · ${head}`, HEADER_WIDTH), body: rows(body, ROW_WIDTH), footer: fit(foot, ROW_WIDTH) };
}
