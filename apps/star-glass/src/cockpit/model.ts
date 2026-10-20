import type { Locale } from "../i18n";
import { t } from "../messages";
import { alerts, type Alert } from "../nina/alerts";
import { availableCommands, decimal, progressNow, remainingNow, clock, type OnlineStatus } from "../nina/status";
import {
  HORIZON_MS, STEP_MS, clockText, cloudOf, cloudSeries, localOffset, rainProbOf, skyWindow, spreadOf, valueAt,
  type WeatherWarning,
} from "../weather/warnings";
import { footer as qisFooter } from "../glasses/footer";
import type { CloudChartSpec, PanelSpec } from "../glasses/charts";
import {
  MODE_PAGES, NO_WEATHER, errorReason, modeOf, shownRemaining, warningText, weatherError,
  type Page, type ViewState,
} from "../glasses/views";

/**
 * What the cockpit shows, in words and numbers, decided without drawing
 * (QUS v1): the headline (the one thing that matters on the page), the six
 * label/value cells, the graphic of the left half, the caption and the hint
 * line. compose.ts only lays this out.
 */

export type Tone = "ok" | "warn" | "critical" | "offline";

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  /** Drawn with a frame round it (something is wrong here). */
  readonly alert?: boolean;
}

export type CockpitGraphic =
  /** The exposure ring: fills as the frame is exposed, the seconds left inside. */
  | { readonly kind: "exposure"; readonly percent: number | null; readonly remaining: number | null; readonly total: number | null }
  /** The RMS and HFR panels (value + the last readings as a line). */
  | { readonly kind: "panels"; readonly rms: PanelSpec; readonly hfr: PanelSpec }
  /** The cloud chart of the next 12 hours. */
  | { readonly kind: "cloud"; readonly spec: CloudChartSpec }
  /** The newest frame of the camera; `key` says which one (null = none). */
  | { readonly kind: "preview"; readonly key: string | null }
  /** A ring of one arc per device; the centre says how many are fine. */
  | { readonly kind: "ring"; readonly segments: readonly Tone[]; readonly center: string; readonly sub: string };

export interface CockpitModel {
  readonly page: Page;
  readonly title: string;
  readonly clock: string;
  /** One or two lines, already upper case. */
  readonly headline: readonly string[];
  /** Rows of three columns. */
  readonly cells: readonly CockpitCell[];
  readonly graphic: CockpitGraphic;
  /** Left, above the caption; may be empty. */
  readonly note: string;
  /** Left bottom. */
  readonly caption: string;
  /** The one footer line. */
  readonly hint: string;
}

const DASH = "–";
const upper = (text: string): string => text.toUpperCase();

/** "HH:MM" of an epoch ms in the phone's time (24 h), or in `offset` minutes east of UTC. */
export function hhmm(time: number, offset?: number): string {
  if (offset !== undefined) {
    const d = new Date(time + offset * 60_000);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  const d = new Date(time);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Upper case, no closing full stop, and split over two lines when it is long. */
export function headlineOf(text: string): string[] {
  const flat = upper(text.replace(/[\r\n]+/g, " ").trim().replace(/\.$/, ""));
  if (flat.length <= 11) return [flat];
  const spaces = [...flat].map((char, index) => (char === " " ? index : -1)).filter((index) => index > 0);
  if (spaces.length === 0) return [flat];
  const middle = flat.length / 2;
  const cut = spaces.reduce((best, index) => (Math.abs(index - middle) < Math.abs(best - middle) ? index : best));
  return [flat.slice(0, cut), flat.slice(cut + 1)];
}

const n = (locale: Locale, value: number | null | undefined, digits = 0): string => (value === null || value === undefined ? DASH : decimal(value, digits, locale));

/** "42 min" or "1 h 05". */
export function minutesText(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : clock(minutes * 60);
}

// ---- the hint line -------------------------------------------------------------------

/** Whether a tap on a capture page opens the control list. */
export function canControl(state: ViewState): boolean {
  return state.connection.kind === "ok" && availableCommands(state.status).length > 0;
}

/** The footer of a cockpit page: only the gestures that do something here. */
export function cockpitHint(state: ViewState): string {
  const L = (key: string): string => t(state.locale, key);
  const pages = MODE_PAGES[modeOf(state.page)];
  const capture = modeOf(state.page) === "capture";
  const tap = capture && canControl(state) ? L("g.tap.control") : L("g.tap.refresh");
  const lead = pages.length > 1 ? `${pages.indexOf(state.page) + 1}/${pages.length}` : "";
  return qisFooter(state.locale, { tap, ...(pages.length > 1 ? { swipe: L("g.f.page") } : {}) }, "back", lead);
}

// ---- alerts and the headline ---------------------------------------------------------

/** The short, loud form of an alert for the headline. */
export function alertHeadline(alert: Alert, locale: Locale): string {
  return t(locale, "g.cp.alert." + alert.kind, alert.vars);
}

/** The thing that needs attention first: an alert, else a weather warning, else a finished sequence. */
function attention(state: ViewState): string[] | null {
  const list = alerts(state.status);
  const urgent = list.find((alert) => alert.level !== "info");
  if (urgent) return headlineOf(alertHeadline(urgent, state.locale));
  const warning = state.weather?.warnings[0];
  if (warning) return headlineOf(warningText(warning, state.locale));
  if (list[0]) return headlineOf(alertHeadline(list[0], state.locale));
  return null;
}

/** True while something wants attention on a page that is not about it: the title carries a mark. */
function flagged(state: ViewState): boolean {
  return alerts(state.status).some((alert) => alert.level !== "info") || (state.weather?.warnings.length ?? 0) > 0;
}

/** Why there is no data: the headline and the caption. */
function noData(state: ViewState): { headline: string[]; caption: string } {
  const L = (key: string): string => t(state.locale, key);
  const s = state.status;
  if (state.connection.kind === "setup") return { headline: headlineOf(L("g.state.noBridgeSet")), caption: "" };
  if (s && !s.online) {
    const reason = ["nina-silent", "starting"].includes(s.reason) ? s.reason : "unknown";
    return { headline: headlineOf(L("g.state.offline")), caption: L("g.offline." + reason) };
  }
  if (state.connection.kind === "error") {
    return { headline: headlineOf(L("g.state.noBridge")), caption: t(state.locale, "g.noBridge", { reason: errorReason(state.locale, state.connection.code, state.connection.status) }) };
  }
  return { headline: headlineOf(L("g.state.loading")), caption: "" };
}

const online = (state: ViewState): OnlineStatus | null => (state.status?.online ? state.status : null);

// ---- cells ----------------------------------------------------------------------------

const cell = (label: string, value: string, alert = false): CockpitCell => (alert ? { label, value, alert: true } : { label, value });

/** The six labels of a capture/guiding/... page, with dashes when there is no data. */
function overviewCells(state: ViewState, s: OnlineStatus | null): CockpitCell[] {
  const L = (key: string): string => t(state.locale, key);
  const list = alerts(s ? state.status : null);
  const has = (...kinds: Alert["kind"][]): boolean => list.some((alert) => kinds.includes(alert.kind));
  const c = s?.camera; const g = s?.guider; const m = s?.mount;
  return [
    cell(L("g.cp.l.filter"), s?.filter ?? DASH),
    cell(L("g.cp.l.exposure"), s?.exposure.total ? `${Math.round(s.exposure.total)} s` : DASH),
    cell(L("g.cp.l.camera"), c?.connected && c.temp !== null ? `${n(state.locale, c.temp, 1)}°` : DASH, has("coolingOff", "coolingDrift", "cameraLost")),
    cell(L("g.cp.l.guiding"), g?.connected && g.rms !== null ? `${n(state.locale, g.rms, 2)}"` : DASH, has("guidingLost")),
    cell(L("g.cp.l.flip"), m?.connected && m.tracking && m.flipMinutes !== null ? minutesText(m.flipMinutes) : DASH, has("flipSoon", "flipNow")),
    cell(L("g.cp.l.alt"), m?.connected && m.alt !== null ? `${Math.round(m.alt)}°` : DASH, has("mountLost")),
  ];
}

function overviewModel(state: ViewState): Pick<CockpitModel, "headline" | "cells" | "graphic" | "note" | "caption"> {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const s = online(state);
  const cells = overviewCells(state, s);
  if (!s || state.connection.kind === "error") {
    const why = noData(state);
    return { headline: why.headline, cells, graphic: { kind: "exposure", percent: null, remaining: null, total: null }, note: "", caption: why.caption };
  }
  const left = shownRemaining(remainingNow(s, state.ageSeconds));
  const pct = progressNow(s, state.ageSeconds);
  const frame = s.sequence.frame !== null
    ? headlineOf(s.sequence.frames !== null ? L("g.cp.frame", { frame: s.sequence.frame, frames: s.sequence.frames }) : L("g.cp.frameOnly", { frame: s.sequence.frame }))
    : headlineOf(s.exposure.active && s.sequence.state !== "running" ? L("g.state.exposing") : L("g.state." + s.sequence.state));
  return {
    headline: attention(state) ?? frame,
    cells,
    // Coarser steps: the ring crosses Bluetooth as a picture.
    graphic: { kind: "exposure", percent: pct === null ? null : Math.floor(pct / 2) * 2, remaining: left, total: s.exposure.active ? s.exposure.total : null },
    note: s.sequence.step ?? "",
    caption: s.sequence.target ?? s.last?.target ?? L("g.noTarget"),
  };
}

function guidingModel(state: ViewState): Pick<CockpitModel, "headline" | "cells" | "graphic" | "note" | "caption"> {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const s = online(state);
  const labels = (values: string[]): CockpitCell[] => [
    cell("RA", values[0] ?? DASH), cell("DEC", values[1] ?? DASH), cell("HFR", values[2] ?? DASH),
    cell(L("g.cp.l.stars"), values[3] ?? DASH), cell(L("g.cp.l.focus"), values[4] ?? DASH), cell(L("g.cp.l.focusTemp"), values[5] ?? DASH),
  ];
  if (!s || state.connection.kind === "error") {
    const why = noData(state);
    const empty: PanelSpec = { label: "RMS", value: null, unit: '"', series: [], minSpan: 0.6 };
    return { headline: why.headline, cells: labels([]), graphic: { kind: "panels", rms: empty, hfr: { label: "HFR", value: null, unit: "PX", series: [], minSpan: 0.4 } }, note: "", caption: why.caption };
  }
  const g = s.guider; const f = s.focuser;
  const running = s.sequence.state === "running";
  const lost = alerts(s).some((alert) => alert.kind === "guidingLost");
  const hfr = s.last?.hfr ? s.last.hfr : s.history.hfr[s.history.hfr.length - 1] ?? null;
  const headline = !g.connected ? L("g.cp.guide.none")
    : g.guiding === false && running ? L("g.cp.alert.guidingLost")
      : g.guiding === true && g.rms !== null ? L("g.cp.guide.rms", { rms: n(state.locale, g.rms, 2) })
        : L("g.cp.guide.idle");
  const caption = !g.connected ? L("g.guide.none") : g.guiding === true ? L("g.guide.on") : g.guiding === false ? L("g.guide.off") : L("g.guide.idle");
  return {
    headline: headlineOf(headline),
    cells: labels([
      g.connected && g.ra !== null ? `${n(state.locale, g.ra, 2)}"` : DASH,
      g.connected && g.dec !== null ? `${n(state.locale, g.dec, 2)}"` : DASH,
      hfr ? n(state.locale, hfr, 2) : DASH,
      s.last?.stars ? String(s.last.stars) : DASH,
      f.connected && f.position !== null ? String(f.position) : DASH,
      f.connected && f.temp !== null ? `${n(state.locale, f.temp, 1)}°` : DASH,
    ]),
    graphic: {
      kind: "panels",
      rms: { label: "RMS", value: g.connected && g.rms !== null ? decimal(g.rms, 2, state.locale) : null, unit: '"', series: s.history.rms, mark: 1, minSpan: 0.6, alarm: lost },
      hfr: { label: "HFR", value: hfr ? decimal(hfr, 2, state.locale) : null, unit: "PX", series: s.history.hfr, minSpan: 0.4 },
    },
    note: "",
    caption,
  };
}

/** How each device stands: not connected = offline, connected but not doing its job = warn. */
export function deviceTones(s: OnlineStatus): Tone[] {
  const running = s.sequence.state === "running";
  const camera: Tone = !s.camera.connected ? "offline" : s.camera.canCool && s.camera.setpoint !== null && !s.camera.cooler ? "warn" : "ok";
  const mount: Tone = !s.mount.connected ? "offline" : running && !s.mount.tracking && !s.mount.parked && !s.mount.slewing ? "warn" : "ok";
  const focuser: Tone = !s.focuser.connected ? "offline" : "ok";
  const guider: Tone = !s.guider.connected ? "offline" : running && s.guider.guiding === false ? "warn" : "ok";
  return [camera, mount, focuser, guider];
}

function equipmentModel(state: ViewState): Pick<CockpitModel, "headline" | "cells" | "graphic" | "note" | "caption"> {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const s = online(state);
  if (!s || state.connection.kind === "error") {
    const why = noData(state);
    const cells = [L("g.cp.l.camera"), L("g.cp.l.cooling"), L("g.cp.l.mount"), L("g.cp.l.focuser"), L("g.cp.l.guider"), L("g.cp.l.filter")].map((label) => cell(label, DASH));
    return { headline: why.headline, cells, graphic: { kind: "ring", segments: [], center: DASH, sub: L("g.cp.ringSub") }, note: "", caption: why.caption };
  }
  const tones = deviceTones(s);
  const fine = tones.filter((tone) => tone === "ok").length;
  const missing = tones.filter((tone) => tone === "offline").length;
  const check = tones.filter((tone) => tone === "warn").length;
  const headline = missing === 1 ? L("g.cp.eq.missing1")
    : missing > 1 ? L("g.cp.eq.missingN", { n: missing })
      : check > 0 ? L("g.cp.eq.check", { n: check })
        : L("g.cp.eq.allOk");
  const c = s.camera; const m = s.mount; const f = s.focuser; const g = s.guider;
  const mountWord = !m.connected ? DASH : m.slewing ? L("g.cp.v.slew") : m.parked ? L("g.cp.v.parked") : m.tracking ? L("g.cp.v.tracks") : L("g.cp.v.off");
  const coolWord = !c.connected || !c.canCool ? DASH : c.cooler ? (c.power !== null ? `${Math.round(c.power)}%` : L("g.cp.v.on")) : L("g.cp.v.off");
  const guiderWord = !g.connected ? DASH : g.guiding === true ? L("g.cp.v.active") : g.guiding === false ? L("g.cp.v.off") : L("g.cp.v.ready");
  return {
    headline: headlineOf(headline),
    cells: [
      cell(L("g.cp.l.camera"), c.connected && c.temp !== null ? `${n(state.locale, c.temp, 1)}°` : DASH, tones[0] !== "ok"),
      cell(L("g.cp.l.cooling"), coolWord, c.connected && c.canCool && !c.cooler),
      cell(L("g.cp.l.mount"), mountWord, tones[1] !== "ok"),
      cell(L("g.cp.l.focuser"), !f.connected ? DASH : f.moving ? L("g.cp.v.moving") : f.position !== null ? String(f.position) : L("g.cp.v.ready"), tones[2] !== "ok"),
      cell(L("g.cp.l.guider"), guiderWord, tones[3] !== "ok"),
      cell(L("g.cp.l.filter"), s.filter ?? DASH),
    ],
    graphic: { kind: "ring", segments: tones, center: `${fine}/${tones.length}`, sub: L("g.cp.ringSub") },
    note: "",
    caption: L("g.eq.version", { version: s.version || "?" }),
  };
}

/** The cloud chart's inputs; "now" moves in 10-minute steps, so the picture is resent rarely. */
export function cloudSpec(state: ViewState): CloudChartSpec {
  const w = state.weather ?? NO_WEATHER;
  const start = Math.floor(state.now / STEP_MS) * STEP_MS;
  const samples = 49;
  const offset = state.utcOffset ?? localOffset(start);
  const local = new Date(start + offset * 60_000);
  const station = state.status?.online ? state.status.weather : null;
  const clouds = cloudSeries(w.forecast, start, samples);
  return {
    clouds,
    rain: cloudSeries(w.forecast, start, samples, rainProbOf),
    threshold: w.thresholds.cloud,
    rainThreshold: w.thresholds.rainProb,
    hours: HORIZON_MS / 3_600_000,
    startHour: local.getUTCHours() + local.getUTCMinutes() / 60,
    now: station?.cloudCover ?? clouds[0] ?? null,
  };
}

function weatherModel(state: ViewState): Pick<CockpitModel, "headline" | "cells" | "graphic" | "note" | "caption"> {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const w = state.weather ?? NO_WEATHER;
  const s = online(state);
  // The first-start demo night has no real weather station: it shows only the real forecast.
  const station = s && !state.demoHint ? s.weather : null;
  const safety = s && !state.demoHint ? s.safety : null;
  const offset = state.utcOffset ?? localOffset(state.now);
  const hours = w.forecast?.hours ?? [];
  const at = (get: (h: (typeof hours)[number]) => number | null): number | null => valueAt(hours, get, state.now);
  const warned = (kind: WeatherWarning["kind"]): boolean => w.warnings.some((warning) => warning.kind === kind);
  const graphic: CockpitGraphic = { kind: "cloud", spec: cloudSpec(state) };

  const cloud = station?.cloudCover ?? at(cloudOf);
  const rainRate = station && station.rainRate !== null && station.rainRate > 0 ? station.rainRate : null;
  const spread = station && station.temperature !== null && station.dewPoint !== null ? station.temperature - station.dewPoint : at(spreadOf);
  const wind = station && station.windSpeed !== null ? station.windSpeed : at((h) => h.wind);
  const gust = station && station.windGust !== null ? station.windGust : at((h) => h.gust);
  const sixth = station && station.skyQuality !== null
    ? cell(L("g.cp.l.sqm"), n(state.locale, station.skyQuality, 1))
    : safety?.connected && safety.safe !== null
      ? cell(L("g.cp.l.safe"), safety.safe ? L("g.cp.v.yes") : L("g.cp.v.no"), safety.safe === false)
      : cell(L("g.cp.l.sqm"), DASH);
  const cells = [
    cell(L("g.cp.l.clouds"), cloud === null ? DASH : `${Math.round(cloud)}%`, warned("clouds")),
    cell(L("g.cp.l.rain"), rainRate !== null ? `${n(state.locale, rainRate, 1)} mm/h` : at(rainProbOf) === null ? DASH : `${Math.round(at(rainProbOf)!)}%`, warned("rain")),
    cell(L("g.cp.l.dew"), spread === null ? DASH : `${n(state.locale, Math.max(0, spread), 1)}°`, warned("dew")),
    cell(L("g.cp.l.wind"), wind === null ? DASH : String(Math.round(wind)), warned("wind")),
    cell(L("g.cp.l.gust"), gust === null ? DASH : String(Math.round(gust)), warned("wind")),
    sixth,
  ];
  const base = { cells, graphic, note: "" };

  if (!w.enabled) return { ...base, headline: headlineOf(L("g.wx.off")), note: "", caption: L("g.wx.off2") };
  if (!w.forecast) {
    const headline = w.location === "none" ? L("g.cp.wx.noLocation") : w.error ? L("g.cp.wx.noData") : L("g.cp.wx.loading");
    const caption = w.location === "none" ? L("g.wx.noLocation2") : w.error ? weatherError(state.locale, w.error) : "";
    // The station alone can still say how the sky is.
    return { ...base, headline: station && cloud !== null && w.location !== "none" && !w.error ? headlineOf(L("g.wx.cloudNow", { pct: n(state.locale, cloud) })) : headlineOf(headline), note: "", caption };
  }
  const input = { now: state.now, forecast: w.forecast, station, thresholds: w.thresholds };
  const sky = skyWindow(input);
  const skyLine = sky.kind === "clear"
    ? (sky.until === null ? L("g.wx.clearAll") : L("g.wx.clearUntil", { time: clockText(sky.until, offset) }))
    : sky.kind === "cloudy"
      ? (sky.from === null ? L("g.wx.cloudyAll") : L("g.wx.cloudyUntil", { time: clockText(sky.from, offset) }))
      : L("g.wx.skyUnknown");
  const warning = w.warnings[0];
  const age = (state.now - w.forecast.fetchedAt) / 60_000;
  return {
    ...base,
    headline: headlineOf(warning ? warningText(warning, state.locale) : skyLine),
    caption: age > 90 ? L("g.wx.old", { age: Math.round(age / 60) }) : L("g.cp.wx.at", { time: hhmm(w.forecast.fetchedAt, state.utcOffset) }),
  };
}

/** "5 min", "2 h": how long ago, coarse. */
export function agoText(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

function imageModel(state: ViewState): Pick<CockpitModel, "headline" | "cells" | "graphic" | "note" | "caption"> {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const s = online(state);
  const labels = (values: string[]): CockpitCell[] => [
    cell(L("g.cp.l.filter"), values[0] ?? DASH), cell(L("g.cp.l.exposure"), values[1] ?? DASH), cell(L("g.cp.l.stars"), values[2] ?? DASH),
    cell(L("g.cp.l.count"), values[3] ?? DASH), cell(L("g.cp.l.type"), values[4] ?? DASH), cell(L("g.cp.l.ago"), values[5] ?? DASH),
  ];
  if (!s || state.connection.kind === "error") {
    const why = noData(state);
    return { headline: why.headline, cells: labels([]), graphic: { kind: "preview", key: null }, note: "", caption: why.caption };
  }
  const last = s.last;
  const key = s.preview;
  if (!last) {
    return { headline: headlineOf(L("g.cp.img.none")), cells: labels([DASH, DASH, DASH, String(s.images)]), graphic: { kind: "preview", key: null }, note: "", caption: s.sequence.target ?? L("g.noTarget") };
  }
  const time = last.at ? Date.parse(last.at) : NaN;
  const ago = Number.isFinite(time) && state.now - time >= 0 ? agoText((state.now - time) / 1000) : DASH;
  return {
    headline: headlineOf(last.hfr ? L("g.hfrOnly", { hfr: n(state.locale, last.hfr, 2) }) : L("g.cp.img.noHfr")),
    cells: labels([
      last.filter ?? DASH,
      last.exposure !== null ? `${Math.round(last.exposure * 10) / 10} s` : DASH,
      last.stars ? String(last.stars) : DASH,
      String(s.images),
      last.type ?? DASH,
      ago,
    ]),
    graphic: { kind: "preview", key },
    note: state.hasPreview || !key ? "" : L("g.img.noPreview"),
    caption: last.target ?? L("g.noTarget"),
  };
}

/** Everything the cockpit page `state.page` shows. */
export function cockpitModel(state: ViewState): CockpitModel {
  const parts = state.page === "overview" ? overviewModel(state)
    : state.page === "guiding" ? guidingModel(state)
      : state.page === "equipment" ? equipmentModel(state)
        : state.page === "weather" ? weatherModel(state)
          : imageModel(state);
  // The first start is a demo: the caption says how to set up the real night.
  const caption = state.demoHint && state.page !== "weather" ? t(state.locale, "g.demoHintShort") : parts.caption;
  const mark = flagged(state) && state.page !== "overview" && state.page !== "weather" ? " !" : "";
  return {
    page: state.page,
    title: t(state.locale, "g.cp.title") + mark,
    clock: hhmm(state.now, state.utcOffset),
    ...parts,
    caption,
    hint: cockpitHint(state),
  };
}

/** A key that changes exactly when what the cockpit would draw changes (the tile sender dedupes on pixels; this is for tests and callers). */
export function modelKey(model: CockpitModel): string {
  return JSON.stringify([model.page, model.title, model.clock, model.headline, model.cells, model.graphic, model.note, model.caption, model.hint]);
}
