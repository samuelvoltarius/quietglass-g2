import type { Locale } from "../i18n";
import { t } from "../messages";
import { alerts, type Alert } from "../nina/alerts";
import { availableCommands, decimal, progressNow, remainingNow, clock, type Command, type OnlineStatus, type StarStatus } from "../nina/status";
import { panelFrame, ringFrame, telescopeFrame, type Mood } from "./charts";
import type { Bitmap } from "./gfx";
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

export type Page = "overview" | "guiding" | "equipment" | "image";
export const PAGES: readonly Page[] = ["overview", "guiding", "equipment", "image"];

/** Page layouts on the 576 x 288 display; a change of layout is a page rebuild. */
export type Layout = "overview" | "guiding" | "image" | "plain";

export type ControlRow = Command | "back";

export interface ViewState {
  readonly locale: Locale;
  readonly demo: boolean;
  readonly connection: Connection;
  readonly status: StarStatus | null;
  /** Seconds since that status arrived (the exposure is counted down locally). */
  readonly ageSeconds: number;
  readonly page: Page;
  readonly screen: "pages" | "control";
  readonly cursor: number;
  readonly armed: Command | null;
  readonly sending: boolean;
  readonly message: string;
  /** Whether a preview picture is on hand for the image page. */
  readonly hasPreview: boolean;
  /** Wall clock, for the animation and "x min ago". */
  readonly now: number;
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
export function shownRemaining(left: number | null): number | null {
  if (left === null) return null;
  return left > 30 ? Math.ceil(left / 5) * 5 : Math.ceil(left);
}

export function errorReason(locale: Locale, code: string, status?: number): string {
  return t(locale, "g.err." + code, { status: status ?? 0 });
}

export function layoutFor(state: ViewState): Layout {
  if (state.screen === "control" || state.connection.kind === "setup" || !state.status?.online) return "plain";
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

function header(state: ViewState, list: readonly Alert[], title: string, status: string): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const first = list[0];
  let out = first
    ? (list.length > 1 ? L("g.alertMore", { text: alertText(first, state.locale), more: list.length - 1 }) : alertText(first, state.locale))
    : L("g.header", { page: title, state: status });
  if (state.demo) out += " · " + L("g.demo");
  if (state.status && state.connection.kind !== "loading" && state.ageSeconds >= STALE_SECONDS) out += " · " + L("g.stale", { age: ageText(state.ageSeconds) });
  return fit(out, HEADER_WIDTH);
}

function sequenceWord(state: ViewState, s: OnlineStatus): string {
  if (s.exposure.active && s.sequence.state !== "running") return t(state.locale, "g.state.exposing");
  return t(state.locale, "g.state." + s.sequence.state);
}

function footer(state: ViewState): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const tap = controlRows(state.status).length > 1 && state.connection.kind === "ok" ? L("g.tap.control") : L("g.tap.refresh");
  return fit(L("g.footer", { page: PAGES.indexOf(state.page) + 1, tap }), ROW_WIDTH);
}

const rows = (list: readonly string[], width: number): string[] => list.slice(0, MAX_BODY_ROWS).map((row) => fit(row, width));

/** The page as text. Images come from `buildFrames`. */
export function buildView(state: ViewState): PageView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  if (state.screen === "control") return controlView(state);
  const list = alerts(state.status);
  const pageTitle = L("g.page." + state.page);

  if (state.connection.kind === "setup") {
    return { layout: "plain", header: fit(L("g.title"), HEADER_WIDTH), body: [L("g.setup.1"), L("g.setup.2")], footer: L("g.footer.setup") };
  }
  const status = state.status;
  const bridgeLine = state.connection.kind === "error" ? L("g.noBridge", { reason: errorReason(state.locale, state.connection.code, state.connection.status) }) : "";
  if (!status) {
    const word = state.connection.kind === "error" ? L("g.state.noBridge") : L("g.state.loading");
    return { layout: "plain", header: header(state, [], L("g.title"), word), body: rows([bridgeLine, "", state.message], ROW_WIDTH), footer: footer(state) };
  }
  if (!status.online) {
    return {
      layout: "plain",
      header: header(state, [], L("g.title"), L("g.state.offline")),
      body: rows([L("g.offline." + (["nina-silent", "starting"].includes(status.reason) ? status.reason : "unknown")), L("g.offline.hint"), "", bridgeLine || state.message], ROW_WIDTH),
      footer: footer(state),
    };
  }

  const head = header(state, list, pageTitle, sequenceWord(state, status));
  const extra = bridgeLine || state.message || (list[1] ? alertText(list[1], state.locale) : "");
  switch (state.page) {
    case "overview": return { layout: "overview", header: head, body: rows(overviewLines(state, status, extra), SIDE_WIDE), footer: footer(state) };
    case "guiding": return { layout: "guiding", header: head, body: rows(guidingLines(state, status, extra), SIDE_NARROW), footer: footer(state) };
    case "equipment": return { layout: "plain", header: head, body: rows(equipmentLines(state, status, extra), ROW_WIDTH), footer: footer(state) };
    case "image": return { layout: "image", header: head, body: rows(imageLines(state, status, extra), SIDE_NARROW), footer: footer(state) };
  }
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
  if (state.sending) body.push(L("g.control.sending"));
  else if (state.armed) body.push(L("g.control.confirm." + state.armed));
  else body.push(state.message);
  return { layout: "plain", header: fit(L("g.control.header", { target }), HEADER_WIDTH), body: rows(body, ROW_WIDTH), footer: fit(L("g.control.footer"), ROW_WIDTH) };
}

// ---- pictures ---------------------------------------------------------------

export function moodFor(state: ViewState): Mood {
  if (state.connection.kind === "setup" || state.connection.kind === "error" || !state.status?.online) return "offline";
  if (alerts(state.status).some((a) => a.level === "critical")) return "error";
  return state.status.exposure.active ? "working" : "idle";
}

export interface Frames {
  readonly icon: Bitmap;
  readonly ring?: Bitmap;
  readonly panelA?: Bitmap;
  readonly panelB?: Bitmap;
}

/** The pictures of the current layout; the preview bytes come separately (they are fetched). */
export function buildFrames(state: ViewState, layout: Layout): Frames {
  const icon = telescopeFrame(moodFor(state), state.now);
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
