import type { Locale } from "../i18n";
import { t } from "../messages";
import { alerts, type Alert } from "../nina/alerts";
import { availableCommands, decimal, progressNow, remainingNow, clock, type Command, type OnlineStatus, type StarStatus } from "../nina/status";
import { cloudChart, panelFrame, ringFrame, telescopeFrame, type Mood } from "./charts";
import type { Forecast } from "../weather/forecast";
import {
  DEFAULT_THRESHOLDS, HORIZON_MS, STEP_MS, clockText, cloudOf, cloudSeries, inMinutes, localOffset, rainProbOf, skyWindow, spreadOf, valueAt,
  type Thresholds, type WeatherWarning,
} from "../weather/warnings";
import type { Bitmap } from "./gfx";
import { armedFooter, footer as qisFooter } from "./footer";
import { fit, marked, MAX_BODY_ROWS } from "./screen";

/**
 * Everything the glasses show, as pure functions of a state snapshot, so every
 * page can be checked against its row widths in both languages.
 */

export type Connection =
  | { readonly kind: "setup" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly code: string; readonly status?: number };

export type Page = "overview" | "weather" | "guiding" | "equipment" | "image";
export const PAGES: readonly Page[] = ["overview", "weather", "guiding", "equipment", "image"];

/** Page layouts on the 576 x 288 display; a change of layout is a page rebuild. */
export type Layout = "overview" | "guiding" | "image" | "weather" | "plain";

/** Where the forecast's coordinates came from. */
export type WeatherLocation = "nina" | "manual" | "phone" | "pending" | "none";

/** The weather part of the state (forecast, warnings, the popup showing now). */
export interface WeatherView {
  readonly enabled: boolean;
  readonly forecast: Forecast | null;
  readonly warnings: readonly WeatherWarning[];
  /** A warning that just started; shown in the header for a few seconds. */
  readonly popup: WeatherWarning | null;
  readonly location: WeatherLocation;
  /** Last fetch problem: "timeout", "unreachable", "bad-reply" or "HTTP 503". */
  readonly error: string | null;
  readonly thresholds: Thresholds;
}

export const NO_WEATHER: WeatherView = { enabled: true, forecast: null, warnings: [], popup: null, location: "pending", error: null, thresholds: DEFAULT_THRESHOLDS };

export type ControlRow = Command | "back";

export interface ViewState {
  readonly locale: Locale;
  readonly demo: boolean;
  readonly connection: Connection;
  readonly status: StarStatus | null;
  /** Seconds since that status arrived (the exposure is counted down locally). */
  readonly ageSeconds: number;
  readonly page: Page;
  readonly screen: "pages" | "control" | "help";
  readonly cursor: number;
  readonly armed: Command | null;
  readonly sending: boolean;
  readonly message: string;
  /** Whether a preview picture is on hand for the image page. */
  readonly hasPreview: boolean;
  /** Wall clock, for the animation and "x min ago". */
  readonly now: number;
  /** Forecast and warnings; missing = nothing known yet. */
  readonly weather?: WeatherView;
  /** Minutes east of UTC for clock times (default: the phone's). */
  readonly utcOffset?: number;
  /** First start without a bridge: the night is a demo and says how to set up the real one (QIS v1.2 no. 7). */
  readonly demoHint?: boolean;
}

export interface PageView {
  readonly layout: Layout;
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

/** Characters per row: header beside the sign, full width, and the side columns. */
export const HEADER_WIDTH = 50;
export const ROW_WIDTH = 56;
export const SIDE_WIDE = 40;
export const SIDE_NARROW = 26;

/** Older than this, the header says the values are stale. */
export const STALE_SECONDS = 20;

export function controlRows(status: StarStatus | null): ControlRow[] {
  return [...availableCommands(status), "back"];
}

/**
 * Seconds left as shown (text and ring alike): 5-second steps above half a
 * minute, so the ring picture only changes every few seconds.
 */
/**
 * The glasses' side menu (QIS v1.2). Off: its clicks never reach the app on the real glasses and a hold
 * opens the menu instead of reaching the app (step log of 15.10.2026), so a hold opens the help again.
 */
export const SIDE_MENU = false;

export function shownRemaining(left: number | null): number | null {
  if (left === null) return null;
  return left > 30 ? Math.ceil(left / 5) * 5 : Math.ceil(left);
}

/**
 * Why something failed, in plain words. The glasses never show a status code (QIS v1.2 no. 8);
 * the phone asks with `detail` and gets "Fehler (HTTP 503)".
 */
export function errorReason(locale: Locale, code: string, status?: number, detail = false): string {
  if (detail && code === "http") return t(locale, "p.err.httpDetail", { status: status ?? 0 });
  return t(locale, "g.err." + code, { status: status ?? 0 });
}

export function layoutFor(state: ViewState): Layout {
  if (state.screen === "control" || state.screen === "help") return "plain";
  // The weather does not need N.I.N.A.: its page works without a bridge, too.
  if (state.page === "weather") return "weather";
  if (state.connection.kind === "setup" || !state.status?.online) return "plain";
  if (state.page === "overview") return "overview";
  if (state.page === "guiding") return "guiding";
  if (state.page === "image") return "image";
  return "plain";
}

const num = (locale: Locale, value: number | null, digits = 1): string => (value === null ? "–" : decimal(value, digits, locale));

function ageText(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
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

function header(state: ViewState, list: readonly Alert[], title: string, status: string): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const first = list[0];
  const popup = state.weather?.popup ?? null;
  const app = L("g.app");
  // A warning is what the wearer must read: it keeps the app name only while it still fits.
  const alertLine = popup
    ? (list.length > 0 ? L("g.alertMore", { text: warningText(popup, state.locale), more: list.length }) : warningText(popup, state.locale))
    : first
      ? (list.length > 1 ? L("g.alertMore", { text: alertText(first, state.locale), more: list.length - 1 }) : alertText(first, state.locale))
      : null;
  let out = alertLine === null
    ? `${app} · ${title ? L("g.header", { page: title, state: status }) : status}`
    : (`${app} · ${alertLine}`.length <= HEADER_WIDTH ? `${app} · ${alertLine}` : alertLine);
  // Late is worse than demo: the stale mark goes first, the demo mark only if there is room left.
  if (state.status && state.connection.kind !== "loading" && state.ageSeconds >= STALE_SECONDS) {
    const stale = " · " + L("g.stale", { age: ageText(state.ageSeconds) });
    if (out.length + stale.length <= HEADER_WIDTH) out += stale;
  }
  const demo = " · " + L("g.demo");
  if ((state.demo || state.demoHint) && out.length + demo.length <= HEADER_WIDTH) out += demo;
  return fit(out, HEADER_WIDTH);
}

function sequenceWord(state: ViewState, s: OnlineStatus): string {
  if (s.exposure.active && s.sequence.state !== "running") return t(state.locale, "g.state.exposing");
  return t(state.locale, "g.state." + s.sequence.state);
}

/** QIS v1 footer: Tippen / Wischen / Halten / 2×, page indicator in front. */
function footer(state: ViewState): string {
  const L = (key: string): string => t(state.locale, key);
  const tap = controlRows(state.status).length > 1 && state.connection.kind === "ok" ? L("g.tap.control") : L("g.tap.refresh");
  return fit(qisFooter(state.locale, { tap, swipe: L("g.f.page"), hold: L(SIDE_MENU ? "g.f.menu" : "g.f.help") }, "exit", `${PAGES.indexOf(state.page) + 1}/${PAGES.length}`), ROW_WIDTH);
}

function helpView(state: ViewState): PageView {
  const L = (key: string): string => t(state.locale, key);
  const body = [1, 2, 3, 4, 5, 6, 7].map((n) => L("g.help." + n));
  return { layout: "plain", header: fit(`${L("g.app")} · ${L("g.h.help")}`, HEADER_WIDTH), body: rows(body, ROW_WIDTH), footer: qisFooter(state.locale, {}, "back") };
}

const rows = (list: readonly string[], width: number): string[] => list.slice(0, MAX_BODY_ROWS).map((row) => fit(row, width));

/** The page as text. Images come from `buildFrames`. */
export function buildView(state: ViewState): PageView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  if (state.screen === "control") return controlView(state);
  if (state.screen === "help") return helpView(state);
  const list = alerts(state.status);
  const pageTitle = L("g.page." + state.page);

  if (state.page === "weather") return weatherView(state, list);
  if (state.connection.kind === "setup") {
    return { layout: "plain", header: fit(`${L("g.app")} · ${L("g.h.setup")}`, HEADER_WIDTH), body: [L("g.setup.1"), L("g.setup.2")], footer: qisFooter(state.locale, { hold: L(SIDE_MENU ? "g.f.menu" : "g.f.help") }, "exit") };
  }
  const status = state.status;
  const bridgeLine = state.connection.kind === "error" ? L("g.noBridge", { reason: errorReason(state.locale, state.connection.code, state.connection.status) }) : "";
  if (!status) {
    const word = state.connection.kind === "error" ? L("g.state.noBridge") : L("g.state.loading");
    return { layout: "plain", header: header(state, [], "", word), body: rows([bridgeLine, "", state.message], ROW_WIDTH), footer: footer(state) };
  }
  if (!status.online) {
    return {
      layout: "plain",
      header: header(state, [], "", L("g.state.offline")),
      body: rows([L("g.offline." + (["nina-silent", "starting"].includes(status.reason) ? status.reason : "unknown")), L("g.offline.hint"), "", bridgeLine || state.message], ROW_WIDTH),
      footer: footer(state),
    };
  }

  const head = header(state, list, pageTitle, sequenceWord(state, status));
  const weatherHint = state.weather?.warnings[0] ? warningText(state.weather.warnings[0], state.locale) : "";
  const extraFor = (width: number): string => bridgeLine || state.message || (list[1] ? alertText(list[1], state.locale) : "") || weatherHint
    || (state.demoHint ? L(width < 30 ? "g.demoHintShort" : "g.demoHint") : "");
  switch (state.page) {
    case "overview": return { layout: "overview", header: head, body: rows(overviewLines(state, status, extraFor(SIDE_WIDE)), SIDE_WIDE), footer: footer(state) };
    case "guiding": return { layout: "guiding", header: head, body: rows(guidingLines(state, status, extraFor(SIDE_NARROW)), SIDE_NARROW), footer: footer(state) };
    case "equipment": return { layout: "plain", header: head, body: rows(equipmentLines(state, status, extraFor(ROW_WIDTH)), ROW_WIDTH), footer: footer(state) };
    case "image": return { layout: "image", header: head, body: rows(imageLines(state, status, extraFor(SIDE_NARROW)), SIDE_NARROW), footer: footer(state) };
  }
}

// ---- weather page ---------------------------------------------------------------

function weatherView(state: ViewState, list: readonly Alert[]): PageView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const s = state.status;
  const word = state.connection.kind === "setup" ? L("g.state.noBridgeSet")
    : !s ? (state.connection.kind === "error" ? L("g.state.noBridge") : L("g.state.loading"))
      : !s.online ? L("g.state.offline") : sequenceWord(state, s);
  return { layout: "weather", header: header(state, list, L("g.page.weather"), word), body: rows(weatherLines(state), SIDE_NARROW), footer: footer(state) };
}

/** The weather page text beside the cloud chart (26 characters a row). */
export function weatherLines(state: ViewState): string[] {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const w = state.weather ?? NO_WEATHER;
  // The demo night has no real weather station: the first-start demo shows only the real forecast.
  const s = state.status?.online && !state.demoHint ? state.status : null;
  const station = s?.weather ?? null;
  const safety = s?.safety ?? null;
  const offset = state.utcOffset ?? localOffset(state.now);
  const hours = w.forecast?.hours ?? [];
  const n = (value: number | null, digits = 0): string => (value === null ? "–" : decimal(value, digits, state.locale));

  const stationLine = [
    station && station.skyQuality !== null ? L("g.wx.sqm", { sqm: n(station.skyQuality, 1) }) : "",
    safety?.connected ? (safety.safe === false ? L("g.wx.unsafe") : safety.safe === true ? L("g.wx.safe") : "") : "",
  ].filter(Boolean).join(" · ");

  if (!w.enabled) return [L("g.wx.off"), L("g.wx.off2"), "", stationLine];
  const warnings = w.warnings.slice(0, 2).map((x) => warningText(x, state.locale));

  if (!w.forecast) {
    const why = w.location === "none" ? [L("g.wx.noLocation"), L("g.wx.noLocation2")]
      : w.error ? [L("g.wx.error", { reason: weatherError(state.locale, w.error) })]
        : [L("g.wx.loading")];
    const now = station ? [
      station.cloudCover !== null ? L("g.wx.cloudNow", { pct: n(station.cloudCover) }) : "",
      station.windSpeed !== null || station.windGust !== null ? L("g.wx.wind", { wind: n(station.windSpeed), gust: n(station.windGust) }) : "",
    ].filter(Boolean) : [];
    return [...why, "", ...now, stationLine, ...warnings];
  }

  const input = { now: state.now, forecast: w.forecast, station, thresholds: w.thresholds };
  const sky = skyWindow(input);
  const skyLine = sky.kind === "clear"
    ? (sky.until === null ? L("g.wx.clearAll") : L("g.wx.clearUntil", { time: clockText(sky.until, offset) }))
    : sky.kind === "cloudy"
      ? (sky.from === null ? L("g.wx.cloudyAll") : L("g.wx.cloudyUntil", { time: clockText(sky.from, offset) }))
      : L("g.wx.skyUnknown");

  const at = (get: (h: (typeof hours)[number]) => number | null): number | null => valueAt(hours, get, state.now);
  const cloudNow = station?.cloudCover ?? at(cloudOf);
  const layers = [at((h) => h.cloudLow), at((h) => h.cloudMid), at((h) => h.cloudHigh)];
  const cloudLine = L("g.wx.cloudNow", { pct: n(cloudNow) }) + (layers.every((v) => v !== null) ? " · " + layers.map((v) => n(v)).join("/") : "");
  const rain = station && station.rainRate !== null && station.rainRate > 0 ? L("g.wx.rainRate", { rate: n(station.rainRate, 1) }) : L("g.wx.rainProb", { pct: n(at(rainProbOf)) });
  const spread = station && station.temperature !== null && station.dewPoint !== null ? station.temperature - station.dewPoint : at(spreadOf);
  const wind = station && (station.windSpeed !== null || station.windGust !== null)
    ? L("g.wx.wind", { wind: n(station.windSpeed), gust: n(station.windGust) })
    : L("g.wx.wind", { wind: n(at((h) => h.wind)), gust: n(at((h) => h.gust)) });
  const age = (state.now - w.forecast.fetchedAt) / 60_000;
  return [
    skyLine,
    cloudLine,
    rain + " · " + L("g.wx.dew", { spread: n(spread === null ? null : Math.max(0, spread), 1) }),
    wind,
    stationLine || (age > 90 ? L("g.wx.old", { age: Math.round(age / 60) }) : w.error ? L("g.wx.error", { reason: weatherError(state.locale, w.error) }) : ""),
    ...(warnings.length ? warnings : [L("g.wx.calm")]),
  ];
}

export function weatherError(locale: Locale, error: string): string {
  // No status code on the glasses (QIS v1.2 no. 8): "HTTP 503" is just "server error" here.
  if (/^HTTP \d+$/.test(error)) return t(locale, "g.err.http");
  return t(locale, "g.err." + (["timeout", "unreachable", "bad-reply"].includes(error) ? error : "bad-reply"));
}

function overviewLines(state: ViewState, s: OnlineStatus, extra: string): string[] {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const left = shownRemaining(remainingNow(s, state.ageSeconds));
  const parts = [s.filter, s.exposure.total !== null ? L("g.secondsLong", { s: Math.round(s.exposure.total) }) : null,
    s.sequence.frame !== null ? (s.sequence.frames !== null ? L("g.frame", { frame: s.sequence.frame, frames: s.sequence.frames }) : L("g.frameOnly", { frame: s.sequence.frame })) : null]
    .filter((p): p is string => Boolean(p));
  const cam = !s.camera.connected ? L("g.camOff") : s.camera.temp === null ? L("g.camOn") : L("g.camTemp", { temp: num(state.locale, s.camera.temp) });
  const guide = s.guider.connected && s.guider.rms !== null ? L("g.rms", { rms: num(state.locale, s.guider.rms, 2) }) : L("g.noGuider");
  const mount = !s.mount.connected ? "" : s.mount.parked ? L("g.parked")
    : !s.mount.tracking ? L("g.tracking.off")
      : s.mount.flipMinutes !== null ? L("g.flipIn", { minutes: s.mount.flipMinutes }) : "";
  const alt = s.mount.connected && s.mount.alt !== null ? L("g.alt", { alt: Math.round(s.mount.alt) }) : "";
  return [
    s.sequence.target ?? s.last?.target ?? L("g.noTarget"),
    parts.join(" · ") || "–",
    left !== null ? L("g.left", { left: clock(left) }) + (s.sequence.step ? " · " + s.sequence.step : "") : L("g.noExposure"),
    "",
    cam + " · " + guide,
    [mount, alt].filter(Boolean).join(" · "),
    extra,
  ];
}

function guidingLines(state: ViewState, s: OnlineStatus, extra: string): string[] {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const g = s.guider;
  const lines = g.connected
    ? [g.guiding === true ? L("g.guide.on") : g.guiding === false ? L("g.guide.off") : L("g.guide.idle"),
      g.ra !== null && g.dec !== null ? L("g.guide.axes", { ra: num(state.locale, g.ra, 2), dec: num(state.locale, g.dec, 2) }) : ""]
    : [L("g.guide.none"), L("g.guide.none2")];
  const last = s.last;
  const hfr = last?.hfr ? (last.stars ? L("g.hfr", { hfr: num(state.locale, last.hfr, 2), stars: last.stars }) : L("g.hfrOnly", { hfr: num(state.locale, last.hfr, 2) })) : "";
  const f = s.focuser;
  return [
    ...lines,
    "",
    hfr,
    f.connected ? (f.moving ? L("g.focusMoving") : L("g.focus", { position: f.position ?? "–" })) : "",
    f.connected && f.temp !== null ? L("g.focusTemp", { temp: num(state.locale, f.temp) }) : "",
    extra,
  ];
}

function equipmentLines(state: ViewState, s: OnlineStatus, extra: string): string[] {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const c = s.camera;
  const camera = !c.connected ? L("g.eq.cameraOff")
    : c.temp === null ? L("g.eq.cameraNoTemp")
    : !c.canCool || c.setpoint === null ? L("g.eq.cameraNoCool", { temp: num(state.locale, c.temp) })
      : c.cooler ? L("g.eq.cameraSet", { temp: num(state.locale, c.temp), setpoint: num(state.locale, c.setpoint, 0), power: c.power ?? "–" })
        : L("g.eq.cameraWarm", { temp: num(state.locale, c.temp), setpoint: num(state.locale, c.setpoint, 0) });
  const m = s.mount;
  const tracking = m.slewing ? L("g.eq.tracking.slewing") : m.parked ? L("g.eq.tracking.parked") : m.tracking ? L("g.eq.tracking.on") : L("g.eq.tracking.off");
  const mount = m.connected
    ? L("g.eq.mount", { tracking, alt: m.alt === null ? "–" : Math.round(m.alt), az: m.az === null ? "–" : Math.round(m.az) })
    : L("g.eq.mountOff");
  const pier = L("g.pier." + (m.pier === "east" || m.pier === "west" ? m.pier : "unknown"));
  const flip = m.connected && m.flipMinutes !== null ? L("g.eq.flip", { flip: clockMinutes(m.flipMinutes), pier }) : L("g.eq.flipNone");
  const f = s.focuser;
  const focuser = f.connected ? L("g.eq.focuser", { position: f.position ?? "–", temp: num(state.locale, f.temp) }) : L("g.eq.focuserOff");
  const g = s.guider;
  const guider = L("g.eq.guider", {
    state: !g.connected ? L("g.noGuider") : g.rms !== null ? `${g.guiding === false ? L("g.guide.off") : L("g.guide.on")} · RMS ${num(state.locale, g.rms, 2)}"` : L("g.guide.idle"),
  });
  return [camera, mount, flip, focuser, L("g.eq.filter", { filter: s.filter ?? "–" }) + " · " + guider, extra || L("g.eq.version", { version: s.version || "?" })];
}

/** "42 min" or "1 h 05". */
function clockMinutes(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : clock(minutes * 60);
}

function imageLines(state: ViewState, s: OnlineStatus, extra: string): string[] {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const last = s.last;
  if (!last) return [L("g.img.none"), "", extra];
  const at = last.at ? Date.parse(last.at) : NaN;
  const age = Number.isFinite(at) && state.now - at >= 0 ? L("g.img.ago", { age: ageText((state.now - at) / 1000) }) : "";
  return [
    last.target ?? L("g.noTarget"),
    L("g.img.title", { type: last.type ?? "?", filter: last.filter ?? "–" }),
    last.exposure !== null ? L("g.img.exposure", { s: Math.round(last.exposure * 10) / 10 }) : "",
    last.hfr ? L("g.hfrOnly", { hfr: num(state.locale, last.hfr, 2) }) + (last.stars ? " · " + L("g.img.stars", { stars: last.stars }) : "") : "",
    L("g.img.count", { count: s.images }),
    age || (state.hasPreview ? "" : L("g.img.noPreview")),
    extra,
  ];
}

function controlView(state: ViewState): PageView {
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
  return { layout: "plain", header: fit(`${L("g.app")} · ${head}`, HEADER_WIDTH), body: rows(body, ROW_WIDTH), footer: fit(foot, ROW_WIDTH) };
}

// ---- pictures ---------------------------------------------------------------

export function moodFor(state: ViewState): Mood {
  if (state.connection.kind === "setup" || state.connection.kind === "error" || !state.status?.online) return "offline";
  if (alerts(state.status).some((a) => a.level === "critical")) return "error";
  return state.status.exposure.active ? "working" : "idle";
}

export interface Frames {
  readonly icon: Bitmap;
  readonly chart?: Bitmap;
  readonly ring?: Bitmap;
  readonly panelA?: Bitmap;
  readonly panelB?: Bitmap;
}

/** The pictures of the current layout; the preview bytes come separately (they are fetched). */
export function buildFrames(state: ViewState, layout: Layout): Frames {
  const icon = telescopeFrame(moodFor(state), state.now);
  if (layout === "weather") return { icon, chart: weatherChart(state) };
  const s = state.status;
  if (!s?.online) return { icon };
  if (layout === "overview") {
    // Coarser steps on long exposures: the ring crosses BLE as a whole picture.
    const shown = shownRemaining(remainingNow(s, state.ageSeconds));
    const pct = progressNow(s, state.ageSeconds);
    return { icon, ring: ringFrame(pct === null ? null : Math.floor(pct / 2) * 2, shown, s.exposure.active ? s.exposure.total : null) };
  }
  if (layout === "guiding") {
    const g = s.guider;
    const lost = alerts(s).some((a) => a.kind === "guidingLost");
    const panelA = panelFrame({
      label: "RMS",
      value: g.connected && g.rms !== null ? decimal(g.rms, 2, state.locale) : null,
      unit: '"',
      series: s.history.rms,
      mark: 1,
      minSpan: 0.6,
      alarm: lost,
    });
    const hfr = s.last?.hfr ? s.last.hfr : s.history.hfr[s.history.hfr.length - 1] ?? null;
    const panelB = panelFrame({ label: "HFR", value: hfr ? decimal(hfr, 2, state.locale) : null, unit: "PX", series: s.history.hfr, minSpan: 0.4 });
    return { icon, panelA, panelB };
  }
  return { icon };
}

/** The cloud chart; "now" moves in 10-minute steps, so the picture is resent rarely. */
export function weatherChart(state: ViewState): Bitmap {
  const w = state.weather ?? NO_WEATHER;
  const start = Math.floor(state.now / STEP_MS) * STEP_MS;
  const samples = 49;
  const offset = state.utcOffset ?? localOffset(start);
  const local = new Date(start + offset * 60_000);
  const station = state.status?.online ? state.status.weather : null;
  const clouds = cloudSeries(w.forecast, start, samples);
  return cloudChart({
    clouds,
    rain: cloudSeries(w.forecast, start, samples, rainProbOf),
    threshold: w.thresholds.cloud,
    rainThreshold: w.thresholds.rainProb,
    hours: HORIZON_MS / 3_600_000,
    startHour: local.getUTCHours() + local.getUTCMinutes() / 60,
    now: station?.cloudCover ?? clouds[0] ?? null,
  });
}
