import type { Locale } from "../i18n";
import { t } from "../messages";
import { availableCommands, duration, progressBar, type Command, type PrinterStatus } from "../printer/status";
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
  readonly screen: "hud" | "control";
  readonly cursor: number;
  /** The command waiting for its confirming tap. */
  readonly armed: Command | null;
  readonly sending: boolean;
  /** A short, already localised feedback line. */
  readonly message: string;
}

/** Older than this, the values are marked stale in the header. */
export const STALE_SECONDS = 15;

export function controlRows(status: PrinterStatus | null): ControlRow[] {
  return [...availableCommands(status), "back"];
}

export function buildView(state: ViewState): ScreenView {
  return state.screen === "control" ? controlView(state) : hudView(state);
}

function screen(header: string, body: readonly string[], footer: string): ScreenView {
  return { header: fit(header), body: body.slice(0, MAX_BODY_ROWS).map((row) => fit(row)), footer: fit(footer) };
}

export function errorReason(locale: Locale, code: string, status?: number): string {
  return t(locale, "g.err." + code, { status: status ?? 0 });
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
    return screen(L("g.title"), [L("g.setup.1"), L("g.setup.2")], L("g.footer.setup"));
  }

  const status = state.status;
  if (!status) {
    if (state.connection.kind === "error") {
      return screen(
        L("g.header", { state: L("g.state.noBridge") }),
        [L("g.noBridge", { reason: errorReason(state.locale, state.connection.code, state.connection.status) }), "", state.message],
        L("g.footer.refresh"),
      );
    }
    return screen(tag(L("g.header", { state: L("g.state.loading") })), [], L("g.footer.refresh"));
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
    return screen(tag(L("g.header", { state: L("g.state.offline") })), body, L("g.footer.search"));
  }

  const left = duration(status.minutesLeft);
  const temp = (value: { now: number; target: number } | null): string => (value ? `${value.now}/${value.target}` : "–");
  const body = [
    status.file.replace(/\.gcode$/i, "") || "–",
    "",
    `${progressBar(status.progress)}  ${status.progress} %`,
    status.layers ? L("g.layer", { layer: status.layer ?? "?", layers: status.layers, left }) : L("g.left", { left }),
    L("g.temps", { nozzle: temp(status.nozzle), bed: temp(status.bed) }),
    L("g.speed", { speed: status.speed }),
    bridgeLine || state.message || (status.message ? L("g.message", { message: status.message }) : ""),
  ];
  const footer = availableCommands(status).length > 0 ? L("g.footer.control") : L("g.footer.refresh");
  return screen(tag(L("g.header", { state: L("g.state." + status.state) })), body, footer);
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
  return screen(L("g.control.header", { progress, file }), body, L("g.control.footer"));
}

function ageText(seconds: number): string {
  return seconds < 120 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
}

/**
 * The two page layouts: while a printer is online the HUD shows a progress ring
 * with the text beside it and the nozzle curve below ("print"); everything
 * else is the plain header / body / footer page ("plain").
 */
export type Layout = "print" | "plain";

export function layoutFor(state: ViewState): Layout {
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
    L("g.speed", { speed: status.speed }),
    bridgeLine || state.message || (status.message ? L("g.message", { message: status.message }) : ""),
  ];
  return {
    header: plain.header,
    body: side.slice(0, SIDE_ROWS).map((row) => fit(row, SIDE_WIDTH)),
    footer: plain.footer,
    temps: [L("g.nozzle", { temp: temp(status.nozzle) }), L("g.bed", { temp: temp(status.bed) })].map((row) => fit(row, 28)),
  };
}
