import type { Locale } from "../i18n";
import { t } from "../messages";
import { sortWarnings, type CarState, type CarWarning } from "../car/model";
import { ageText, deg, dec, km, kw, pct, warningLong, warningShort } from "../format";
import { INITIAL_CONTROL, controlItems, openArm, type ControlItem, type ControlState, type Page } from "../pages";
/** The blinking warning header changes this often. */
export const ICON_STEP_MS = 500;
import { fit, MAX_BODY_ROWS, wrap } from "./screen";
import { armedFooter, footer as gestureFooter } from "./footer";

/**
 * Everything the glasses show, as pure functions of a state snapshot, so every
 * page can be checked against its row widths in both languages.
 *
 * Commands (0.7.0): one small control page - lock, unlock, preheat 10/20/30 min -
 * shown only while the bridge reports control enabled. Every command is two taps
 * (the second within 4 s); the result line shows the bridge's words: its refusal
 * text, "gesendet", then "bestätigt" or "nicht bestätigt". No footer offers
 * "Halten/Hold": a hold reaches the app only from the R1 ring (step log 21.10.).
 */

export type Connection =
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly code: string; readonly status?: number };

/** cockpit: drive, charge and status pages are one image of four tiles (src/cockpit); plain: full-width text. */
export type Layout = "cockpit" | "plain";

export interface ViewState {
  readonly locale: Locale;
  readonly demo: boolean;
  readonly connection: Connection;
  readonly car: CarState | null;
  readonly page: Page;
  /** Warnings shown full-screen over any page, or null. */
  readonly overlay: readonly CarWarning[] | null;
  /** The help page is open (ring hold only; never offered in a footer). */
  readonly help?: boolean;
  /** The control page (cursor, open question, result). */
  readonly control?: ControlState;
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
/** Rows of the text body. */
export const ROWS: Readonly<Record<Layout, number>> = { cockpit: 0, plain: MAX_BODY_ROWS };

const rows = (list: readonly string[], max: number): string[] => list.slice(0, max).map((row) => fit(row, ROW_WIDTH));

/**
 * Why the bridge could not be reached, in plain words. The glasses never show a
 * status code (QIS v1.2 #8); the phone passes `detail` and gets it appended.
 */
export function errorReason(locale: Locale, code: string, status?: number, detail = false): string {
  const reason = t(locale, "g.err." + code);
  return detail && code === "http" && status ? `${reason} (${status})` : reason;
}

export function cells(car: CarState, locale: Locale): string {
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
    case "status":
    case "control": return car.body.locked === null
      ? L("g.header.statusNoLock", { soc: socText(state, car) })
      : L("g.header.status", { lock: lockWord(state.locale, car), soc: socText(state, car) });
  }
}

/** Header: the worst warning pulsing, otherwise the page summary. */
function header(state: ViewState, car: CarState): string {
  const list = activeWarnings(car);
  const worst = list[0];
  let out: string;
  if (worst && worst.level !== "info") {
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

export function staleRow(state: ViewState, car: CarState): string | null {
  if (state.connection.kind === "error") {
    return t(state.locale, "g.row.server", { reason: errorReason(state.locale, state.connection.code, state.connection.status) });
  }
  return car.stale ? t(state.locale, "g.stale", { age: ageText(state.locale, car.ageS) }) : null;
}

/** The charge level; marked when it comes from the BYD cloud (the car itself is silent, values lag behind). */
export function socText(state: ViewState, car: CarState): string {
  return pct(car.battery.soc) + (car.battery.src === "cloud" && car.battery.soc !== null ? " " + t(state.locale, "g.cloud") : "");
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

export function pageFooter(state: ViewState, car: CarState): string {
  const L = (key: string): string => t(state.locale, key);
  // QIS v1.2 #7: in the demo the one-line hint leads; the gestures that still fit follow.
  // Only gestures that reach the app from the temple: tap, swipe, 2x (never "Halten/Hold").
  return gestureFooter(state.locale, {
    ...(car.warnings.length > 0 ? { tap: L("g.a.warnings") } : {}),
    swipe: L("g.a.page"),
  }, "exit", state.demo ? L("g.demoHint") : "");
}

/** The gestures, in footer order, and what the app needs (opened by a ring hold; no commands). */
function helpView(state: ViewState): PageView {
  const L = (key: string): string => t(state.locale, key);
  return {
    layout: "plain",
    header: fit(appHeader(L("g.s.help") + (state.demo ? " · " + L("g.demo") : "")), HEADER_WIDTH),
    body: rows([1, 2, 3, 4, 5].map((n) => L("g.help." + n + (n === 4 && !state.car?.control.enabled ? "off" : ""))), MAX_BODY_ROWS),
    footer: gestureFooter(state.locale, {}, "back"),
  };
}

// ---- control page ---------------------------------------------------------------

export function itemLabel(locale: Locale, item: ControlItem): string {
  if (item === "lock") return t(locale, "g.ctl.lock");
  if (item === "unlock") return t(locale, "g.ctl.unlock");
  return t(locale, "g.ctl.preheat", { min: Number(item.slice("preheat".length)) });
}

const actionLabel = (locale: Locale, action: string, value: number | null): string =>
  action === "preheat" ? t(locale, "g.ctl.preheat", { min: value ?? "?" }) : t(locale, action === "unlock" ? "g.ctl.unlock" : "g.ctl.lock");

/** The one result line: what the bridge said, never more. */
export function controlLine(state: ViewState, car: CarState, control: ControlState): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  if (control.busy) return L(control.busy.step === "arm" ? "g.ctl.checking" : "g.ctl.sending", { label: itemLabel(state.locale, control.busy.item) });
  const armed = openArm(control, state.now);
  if (armed) return L("g.ctl.ask", { label: itemLabel(state.locale, armed.item) });
  const r = control.result;
  const cmd = car.command;
  if (r) {
    const label = itemLabel(state.locale, r.item);
    switch (r.kind) {
      case "refused": return r.message ? r.message[state.locale] : L("g.ctl.refused", { label });
      case "failed": return L(r.reason === "auth" ? "g.ctl.failedAuth" : "g.ctl.failed", { label });
      case "lapsed": return L("g.ctl.lapsed", { label });
      case "unknown":
        // No answer to the second tap: only the bridge's own record says whether it went out.
        if (cmd && cmd.at >= r.at - 15_000) return L("g.ctl.st." + cmd.status, { label: actionLabel(state.locale, cmd.action, cmd.value) });
        return L("g.ctl.unknown", { label });
      case "sent":
        if (cmd && r.id !== null && cmd.id === r.id) return L("g.ctl.st." + cmd.status, { label });
        return L("g.ctl.st.sent", { label });
    }
  }
  // Nothing done here yet: the bridge's last command, if any.
  if (cmd) return L("g.ctl.last", { line: L("g.ctl.st." + cmd.status, { label: actionLabel(state.locale, cmd.action, cmd.value) }) });
  return car.control.carOff ? L("g.ctl.ready") : L("g.ctl.carOn");
}

function controlView(state: ViewState, car: CarState): PageView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const control = state.control ?? INITIAL_CONTROL;
  const items = controlItems(car.control);
  const cursor = Math.min(control.cursor, Math.max(0, items.length - 1));
  const armed = openArm(control, state.now);
  const head = L("g.ctl.title") + " · " + L(car.control.carOff ? "g.ctl.off" : "g.ctl.on") + (state.demo ? " · " + L("g.demo") : "");
  const list = items.length > 0
    ? items.map((item, i) => (i === cursor ? "● " : "   ") + itemLabel(state.locale, item))
    : [L("g.ctl.none")];
  const server = staleRow(state, car);
  const body = [...list, "", ...wrap(controlLine(state, car, control), ROW_WIDTH).slice(0, 2), ...(server ? [server] : [])];
  const current = items[cursor];
  const footer = armed
    ? armedFooter(state.locale, itemLabel(state.locale, armed.item))
    : gestureFooter(state.locale, {
      ...(current && !control.busy ? { tap: itemLabel(state.locale, current) } : {}),
      swipe: L("g.a.entry"),
    }, "exit");
  return { layout: "plain", header: fit(appHeader(head), HEADER_WIDTH), body: rows(body, MAX_BODY_ROWS), footer };
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
      footer: gestureFooter(state.locale, {}, "exit"),
    };
  }
  const head = header(state, car);
  switch (state.page) {
    case "control":
      if (car.control.enabled) return controlView(state, car);
      return { layout: "cockpit", header: head, body: [], footer: pageFooter(state, car) };
    case "drive":
    case "charge":
    case "status": return { layout: "cockpit", header: head, body: [], footer: pageFooter(state, car) };
  }
}

/** For the phone page: "Reifen HR …, 12 V schwach …". */
export function warningList(locale: Locale, car: CarState | null): string {
  return activeWarnings(car).map((w) => warningShort(locale, w)).join(" · ");
}

