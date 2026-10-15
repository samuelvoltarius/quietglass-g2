import type { Locale } from "../i18n";
import { t } from "../messages";
import { availableCommands, duration, finishClock, progressBar, spoolLine, type Command, type PrinterStatus } from "../printer/status";
import { armedFooter, footer } from "./footer";
import { fit, marked, MAX_BODY_ROWS, type ScreenView } from "./screen";

/**
 * Everything the glasses show, as pure functions of a state snapshot, so every
 * screen can be checked against the 7 × 56 display limit in both languages.
 */

export type Connection =
  | { readonly kind: "setup" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly code: string; readonly status?: number };

/** One row of the control screen: a printer command, or "back". */
export type ControlRow = Command | "back";

export interface ViewState {
  readonly locale: Locale;
  readonly demo: boolean;
  readonly connection: Connection;
  /** Last status received; kept while the bridge is briefly unreachable. */
  readonly status: PrinterStatus | null;
  /** Seconds since that status arrived. */
  readonly ageSeconds: number;
  readonly screen: "hud" | "control" | "model" | "help";
  readonly cursor: number;
  /** The command waiting for its confirming tap. */
  readonly armed: Command | null;
  readonly sending: boolean;
  /** A short, already localised feedback line. */
  readonly message: string;
  /** Wall clock (ms) for the finish time; omitted in older callers = no finish time. */
  readonly now?: number;
  /** The page carries the glasses' side menu (SIDE_MENU in main.ts). Off by default: the hold opens the help and the footer says so. */
  readonly sideMenu?: boolean;
  /** State of the layer model for the model screen. */
  readonly model?: "none" | "preparing" | "ready" | "failed";
}

/** Without a side menu the HUD footers name the hold: it opens the help. */
function holdHelp(state: ViewState): { hold?: string } {
  return state.sideMenu === true ? {} : { hold: t(state.locale, "g.v.help") };
}

/** "Tempo 100 % · fertig 23:40" — the speed row, with the finish clock when it is known. */
function speedRow(state: ViewState, speed: number, minutesLeft: number | null): string {
  const time = state.now === undefined ? null : finishClock(minutesLeft, state.now, state.locale);
  return time ? t(state.locale, "g.speedFinish", { speed, time }) : t(state.locale, "g.speed", { speed });
}

/** Older than this, the values are marked stale in the header. */
export const STALE_SECONDS = 15;

export function controlRows(status: PrinterStatus | null): ControlRow[] {
  return [...availableCommands(status), "back"];
}

export function buildView(state: ViewState): ScreenView {
  if (state.screen === "help") return helpView(state);
  if (state.screen === "model") return modelView(state);
  return state.screen === "control" ? controlView(state) : hudView(state);
}

/** The layer view: header with layer and progress, footer with the gestures; the picture is drawn separately. */
export function modelView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const status = state.status?.online ? state.status : null;
  let header: string;
  if (!status) header = L("g.model.header", { info: L("g.state.offline") });
  else if (state.model === "ready") {
    header = L("g.model.header", {
      info: (status.layers ? L("g.model.layer", { layer: status.layer ?? "?", layers: status.layers }) + " · " : "") + status.progress + " %",
    });
  } else header = L("g.model.header", { info: L("g.model." + (state.model ?? "none")) });
  // Without a model there is nothing to turn: the swipe goes back (as 2× does).
  const swipe = state.model === "ready" ? L("g.v.rotate") : L("g.v.back");
  return screen(header, [], footer(state.locale, { tap: L("g.v.reload"), swipe }, "back"));
}

/** The help page (QIS v1; opened from the side menu, v1.2): the gestures in footer order, what the control screen does, what the app needs. */
export function helpView(state: ViewState): ScreenView {
  const L = (key: string): string => t(state.locale, key);
  const rows = ["g.help.1", "g.help.2", "g.help.3", "g.help.4", "g.help.5", "g.help.6"].map(L);
  return screen(L("g.help.header"), rows, footer(state.locale, { tap: L("g.v.back") }, "back"));
}

function screen(header: string, body: readonly string[], footer: string): ScreenView {
  return { header: fit(header), body: body.slice(0, MAX_BODY_ROWS).map((row) => fit(row)), footer: fit(footer) };
}

/**
 * Why the bridge could not be reached, in plain words. The glasses never show a
 * status code (QIS v1.2 #8); the phone passes `detail` and gets it appended.
 */
export function errorReason(locale: Locale, code: string, status?: number, detail = false): string {
  const reason = t(locale, "g.err." + code);
  return detail && code === "http" && status ? `${reason} (${status})` : reason;
}

function hudView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const tag = (header: string): string => {
    let out = header;
    if (state.demo) out += " · " + L("g.demo");
    if (state.status && state.connection.kind !== "loading" && state.ageSeconds >= STALE_SECONDS) out += " · " + L("g.stale", { age: ageText(state.ageSeconds) });
    return out;
  };

  if (state.connection.kind === "setup") {
    return screen(L("g.title"), [L("g.setup.1"), L("g.setup.2")], footer(state.locale, holdHelp(state), "exit"));
  }

  const status = state.status;
  if (!status) {
    if (state.connection.kind === "error") {
      return screen(
        L("g.header", { state: L("g.state.noBridge") }),
        [L("g.noBridge", { reason: errorReason(state.locale, state.connection.code, state.connection.status) }), "", state.message],
        footer(state.locale, { tap: L("g.v.refresh"), ...holdHelp(state) }, "exit"),
      );
    }
    return screen(tag(L("g.header", { state: L("g.state.loading") })), state.demo ? [L("g.demoHint")] : [], footer(state.locale, { tap: L("g.v.refresh"), ...holdHelp(state) }, "exit"));
  }

  // The bridge failed this round, but older values exist: show them, marked stale, with the reason.
  const bridgeLine = state.connection.kind === "error"
    ? L("g.noBridge", { reason: errorReason(state.locale, state.connection.code, state.connection.status) })
    : "";

  if (!status.online) {
    const body = [L("g.offline." + status.reason)];
    if (status.reason !== "searching") body.push(L("g.offline.hint"));
    if (status.nextScanSeconds) body.push(L("g.offline.next", { seconds: status.nextScanSeconds }));
    body.push("", bridgeLine || state.message);
    return screen(tag(L("g.header", { state: L("g.state.offline") })), body, footer(state.locale, { tap: L("g.v.search"), ...holdHelp(state) }, "exit"));
  }

  const left = duration(status.minutesLeft);
  const temp = (value: { now: number; target: number } | null): string => (value ? `${value.now}/${value.target}` : "–");
  const body = [
    status.file.replace(/\.gcode$/i, "") || "–",
    "",
    `${progressBar(status.progress)}  ${status.progress} %`,
    status.layers ? L("g.layer", { layer: status.layer ?? "?", layers: status.layers, left }) : L("g.left", { left }),
    L("g.temps", { nozzle: temp(status.nozzle), bed: temp(status.bed) }),
    speedRow(state, status.speed, status.minutesLeft),
    bridgeLine || state.message || (status.message ? L("g.message", { message: status.message }) : "") || (state.demo ? L("g.demoHint") : ""),
  ];
  return screen(tag(L("g.header", { state: L("g.state." + status.state) })), body, hudFooter(state, status));
}

function controlView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const status = state.status;
  const progress = status?.online ? status.progress : 0;
  const file = status?.online ? status.file.replace(/\.gcode$/i, "") : "";
  const rows = controlRows(status);
  const body = rows.map((row, index) => marked(L("g.control." + row), index === state.cursor));
  if (rows.length === 1) body.unshift(L("g.control.none"), "");
  body.push("");
  if (state.sending) body.push(L("g.control.sending"));
  else if (state.armed) body.push(L("g.control.confirm." + state.armed));
  else body.push(state.message);
  // Armed: "Nochmal tippen = Pause · Wischen/2× = abbrechen" (QIS v1, section 2).
  const row = state.armed
    ? armedFooter(state.locale, L("g.v." + state.armed))
    : footer(state.locale, { tap: L("g.v.select"), swipe: L("g.v.move") }, "back");
  return screen(L("g.control.header", { progress, file }), body, row);
}

/** The online HUD footer: tap opens control when something can be controlled, else refreshes; a swipe shows the model. */
function hudFooter(state: ViewState, status: PrinterStatus): string {
  const L = (key: string): string => t(state.locale, key);
  const control = availableCommands(status).length > 0;
  return footer(state.locale, { tap: L(control ? "g.v.control" : "g.v.refresh"), swipe: L("g.v.model"), ...holdHelp(state) }, "exit");
}

function ageText(seconds: number): string {
  return seconds < 120 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
}

/**
 * The two page layouts: while a printer is online the HUD shows a progress ring
 * with the text beside it and the nozzle curve below ("print"); everything
 * else is the plain header / body / footer page ("plain").
 */
export type Layout = "print" | "plain" | "model";

export function layoutFor(state: ViewState): Layout {
  if (state.screen === "model") return "model";
  return state.screen === "hud" && state.connection.kind !== "setup" && state.status?.online === true ? "print" : "plain";
}

/** What the print layout writes: the usual three rows plus two temperature lines under the ring. */
export interface PrintView extends ScreenView {
  readonly temps: readonly string[];
}

/** Characters of the text column beside the ring (424 px wide). */
export const SIDE_WIDTH = 40;
/** Rows beside the ring. */
export const SIDE_ROWS = 4;

/** The online HUD for the print layout. Only valid when `layoutFor(state)` is "print". */
export function buildPrintView(state: ViewState): PrintView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const status = state.status;
  if (!status?.online) return { ...buildView(state), temps: [] };
  const plain = hudView(state);
  const left = duration(status.minutesLeft);
  const temp = (value: { now: number; target: number } | null): string => (value ? `${value.now}/${value.target}` : "–");
  const bridgeLine = state.connection.kind === "error"
    ? L("g.noBridge", { reason: errorReason(state.locale, state.connection.code, state.connection.status) })
    : "";
  const side = [
    status.file.replace(/\.gcode$/i, "") || "–",
    status.layers ? L("g.layer", { layer: status.layer ?? "?", layers: status.layers, left }) : L("g.left", { left }),
    speedRow(state, status.speed, status.minutesLeft),
    bridgeLine || state.message || (status.message ? L("g.message", { message: status.message }) : "") || (state.demo ? L("g.demoHint") : ""),
  ];
  const spool = spoolLine(status.spool);
  return {
    header: plain.header,
    body: side.slice(0, SIDE_ROWS).map((row) => fit(row, SIDE_WIDTH)),
    footer: hudFooter(state, status),
    temps: [L("g.nozzle", { temp: temp(status.nozzle) }), L("g.bed", { temp: temp(status.bed) }), ...(spool ? [spool] : [])].map((row) => fit(row, 28)),
  };
}
