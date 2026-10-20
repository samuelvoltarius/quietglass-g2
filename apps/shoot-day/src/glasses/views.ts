import type { BoardScene, Brief, CallSheet, CustomerItem, EquipmentItem, ProjectItem, Shot, Storyboard, TakeStatus } from "../api/types";
import { scheduleNow } from "../api/types";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { armedFooter, footer, type FooterEnd, type FooterParts } from "./footer";
import { fit, marked, MAX_BODY_ROWS, ROW_WIDTH, wrap, type ScreenView } from "./screen";

/**
 * Everything the glasses show, as pure functions of a state snapshot. No SDK,
 * no network, no timers — so every screen can be checked against the 7 × 46
 * display limit in the tests, in both languages, with worst-case content.
 */

export type Mode = "customers" | "projects" | "brief" | "menu" | "board" | "day" | "takes" | "prompter" | "schedule" | "pack" | "light" | "help";
export type Module = "board" | "day" | "takes" | "prompter" | "schedule" | "pack" | "light";
/**
 * The start page (QUS v1): three big entries - the takes (what is used a hundred times on set, so the
 * cursor starts there), the teleprompter and the day (cockpit; the light view opens from it) - and
 * indented under them what belongs to them: the storyboard (server 0.5.0+, customers) under the takes,
 * the packing list under the day.
 */
export const MENU: readonly Module[] = ["takes", "prompter", "day", "pack"];
export const CUSTOMER_MENU: readonly Module[] = ["takes", "board", "prompter", "day", "pack"];
/** The entries that hang one step under a big one. */
export const SUB_ENTRIES: readonly Module[] = ["pack", "board"];
/**
 * The glasses' side menu (QIS v1.2). Off: its clicks never reach the app on the real glasses and a hold
 * opens the menu instead of reaching the app (step log of 15.10.2026). So Hilfe is a list row again
 * (last entry of the menu / the customer list), "Take löschen" is a row of the take actions, and a
 * hold dictates again.
 */
export const SIDE_MENU = false;
/** No help page on the glasses (QUS v1 1.1): the start page is the list of entries. */
export type MenuEntry = Module;
export const ROOT_MENU: readonly MenuEntry[] = MENU;
export const menuFor = (customerMode: boolean): readonly MenuEntry[] => (customerMode ? CUSTOMER_MENU : ROOT_MENU);
export type TakeScreen = "card" | "actions" | "notes";
/** "roll" starts (or, while a take is running, cancels) a take; the menu opens on "ok". */
export type TakeAction = "roll" | "ok" | "ng" | "note" | "voice" | "delTake" | "back";
/** "delTake" (armed: the second tap deletes the newest take) is here only while the side menu is off. */
export const TAKE_ACTIONS: readonly TakeAction[] = SIDE_MENU
  ? ["roll", "ok", "ng", "note", "voice", "back"]
  : ["roll", "ok", "ng", "note", "voice", "delTake", "back"];

export type LoadStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "error"; readonly code: string; readonly status?: number };

/** What waits for its confirming second tap (QIS v1: armed for 4 s). */
export type ArmKind = "roll" | "ng" | "packAll" | "packReset" | "discardRec" | "delTake" | "discardName";

export type RecTarget = "takes" | "pack" | "customer";

export interface RecView {
  readonly target: RecTarget;
  readonly via: "tap" | "hold";
  /** True once the microphone is off and the server is recognising. */
  readonly busy: boolean;
  /** What the live recogniser heard so far ("" without live speech recognition). */
  readonly live?: string;
}

export interface LastTake {
  readonly n: number;
  readonly status: TakeStatus;
  readonly note: string;
  readonly ts: number;
  readonly pending: boolean;
}

export interface ViewState {
  readonly locale: Locale;
  readonly demo: boolean;
  readonly configured: boolean;
  readonly now: Date;
  readonly mode: Mode;
  readonly menuCursor: number;
  readonly project: string;
  readonly pendingCount: number;
  /** Load state of the current module (or of the menu's project lookup). */
  readonly load: LoadStatus;
  /** A short, already localised feedback line; empty for none. */
  readonly message: string;
  readonly rec: RecView | null;
  readonly takes: {
    readonly shots: readonly Shot[];
    readonly cursor: number;
    readonly screen: TakeScreen;
    readonly actionCursor: number;
    readonly noteCursor: number;
    readonly ok: number;
    readonly ng: number;
    readonly last: LastTake | null;
    readonly nextN: number;
    /** When the running take was started (ms), null while no take runs. */
    readonly rollingSince: number | null;
    readonly notes: readonly string[];
  };
  readonly prompter: {
    readonly lines: readonly string[];
    readonly pos: number;
    readonly speed: number;
    readonly playing: boolean;
  };
  readonly schedule: {
    readonly sheet: CallSheet;
    readonly scroll: number;
  };
  readonly pack: {
    /** Only the items needed for this shoot. */
    readonly items: readonly EquipmentItem[];
    readonly cursor: number;
    readonly missing: boolean;
  };
  /** An action waiting for its second tap; replaces the gesture line. */
  readonly armed?: ArmKind;
  /** The server knows customers (0.5.0+): customer list on top, storyboard in the menu. */
  readonly customerMode: boolean;
  readonly customers: {
    readonly list: readonly CustomerItem[];
    /** 0 = "+ new customer", 1… = the customers. */
    readonly cursor: number;
    /** A name heard for a new customer, waiting for the confirming tap. */
    readonly pending: string | null;
  };
  readonly projects: {
    readonly customer: CustomerItem | null;
    readonly list: readonly ProjectItem[];
    /** 0 = the customer card, 1… = the projects. */
    readonly cursor: number;
    readonly active: string;
  };
  readonly brief: { readonly data: Brief | null; readonly page: number };
  readonly board: {
    readonly boards: readonly Storyboard[];
    readonly board: number;
    readonly cursor: number;
    /** Choosing between several storyboards. */
    readonly picking: boolean;
  };
}

/** The app name every header starts with (QIS v1: APPNAME · state). */
export const APP_NAME = "SHOOT DAY";

/** Rows of the schedule shown below the now/next lines. */
export const SCHEDULE_ROWS = 4;
/** The schedule page keeps a strip for the day bar, so its body holds one row less than the others... */
export const SCHEDULE_BODY_ROWS = 6;
/** ...and header text stops 64 px before the right edge, where the sign sits. */
export const HEADER_WIDTH = 46;
/** Rows of the packing list shown at once; the last body row is for feedback. */
export const PACK_ROWS = 6;

/** `Modus · ● live` (QUS v1 1.1): a dot while live, the state as a word otherwise. */
export type LiveWord = "live" | "demo" | "offline";
export function liveWord(state: ViewState): LiveWord {
  if (state.demo) return "demo";
  return state.load.kind === "error" ? "offline" : "live";
}
export function liveText(locale: Locale, word: LiveWord): string {
  return t(locale, word === "live" ? "g.live" : word === "demo" ? "g.demoWord" : "g.offlineWord");
}

export function buildView(state: ViewState): ScreenView {
  const view = build(state);
  // Every run view starts with the mode and the state: the mode gives way when the row is full, the state never.
  const tail = " · " + liveText(state.locale, liveWord(state));
  const header = fit(view.header, HEADER_WIDTH - tail.length) + tail;
  const withHeader = { ...view, header };
  // Whatever is armed (also from the side menu, on any screen) says what the next tap does.
  return state.armed ? { ...withHeader, footer: fit(armedFooter(state.locale, armLabel(state))) } : withHeader;
}

function build(state: ViewState): ScreenView {
  if (state.rec) return recView(state, state.rec);
  switch (state.mode) {
    case "customers":
      if (state.customers.pending !== null) return newCustomerView(state, state.customers.pending);
      return withLoad(state, t(state.locale, "g.cust.title"), () => customersView(state));
    case "projects": return withLoad(state, (state.projects.customer?.name ?? "").toUpperCase(), () => projectsView(state));
    case "brief": return withLoad(state, t(state.locale, "g.brief.title"), () => briefView(state));
    case "board": return withLoad(state, t(state.locale, "g.menu.board").toUpperCase(), () => boardView(state));
    case "menu": return menuView(state);
    // The day and the light view are full-screen pictures (src/day, src/sun); this text stands in only where no picture can be drawn.
    case "day": return screen(t(state.locale, "g.menu.day").toUpperCase(), [], footer(state.locale, { tap: t(state.locale, "g.f.light") }, "back"));
    case "takes": return withLoad(state, t(state.locale, "g.menu.takes").toUpperCase(), () => takesView(state));
    case "prompter": return withLoad(state, "TELEPROMPTER", () => prompterView(state));
    case "schedule": return withLoad(state, t(state.locale, "g.menu.schedule").toUpperCase(), () => scheduleView(state));
    case "pack": return withLoad(state, t(state.locale, "g.menu.pack").toUpperCase(), () => packView(state));
    // The light view is a full-screen picture (src/sun/compose.ts); this text stands in only where no picture can be drawn.
    case "light": return screen(t(state.locale, "g.menu.light").toUpperCase(), [], footer(state.locale, { tap: t(state.locale, "g.f.now"), swipe: t(state.locale, "g.f.time") }, "back"));
    case "help": return helpView(state.locale);
  }
}

/** Fits every row and pads nothing: what is returned is exactly what is drawn. */
function screen(header: string, body: readonly string[], foot: string): ScreenView {
  return {
    header: fit(header, HEADER_WIDTH),
    body: body.slice(0, MAX_BODY_ROWS).map((row) => fit(row)),
    footer: fit(foot),
  };
}

/** The footer of a view in the app language, labels from the message table; `end` says what 2× does. */
function foot(state: ViewState, parts: { tap?: string; swipe?: string; hold?: string }, end: FooterEnd = "back", lead = ""): string {
  const word = (key: string | undefined): string | undefined => (key === undefined ? undefined : t(state.locale, "g.f." + key));
  const out: FooterParts = {
    ...(parts.tap === undefined ? {} : { tap: word(parts.tap) ?? "" }),
    ...(parts.swipe === undefined ? {} : { swipe: word(parts.swipe) ?? "" }),
    ...(parts.hold === undefined ? {} : { hold: word(parts.hold) ?? "" }),
  };
  return footer(state.locale, out, end, lead);
}

/** "Tippen = nochmal · 2× = zurück": the footer of a screen that is loading, empty or failed. */
const retryFoot = (state: ViewState, end: FooterEnd = "back"): string => foot(state, { tap: "again" }, end);

/** The state word is added once by buildView; kept so the callers read the same. */
const demoTag = (_state: ViewState, header: string): string => header;

/** The label of the action that waits for its second tap. */
const armLabel = (state: ViewState): string => t(state.locale, "g.arm." + (state.armed ?? "roll"));

export function errorText(locale: Locale, code: string, status?: number): string {
  const reason = t(locale, "g.err." + code, { status: status ?? 0 });
  return t(locale, "g.error", { reason });
}

function withLoad(state: ViewState, title: string, ready: () => ScreenView): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  // The customer list is the root: 2× there leaves the app.
  const end: FooterEnd = state.mode === "customers" ? "exit" : "back";
  if (state.load.kind === "loading" || state.load.kind === "idle") return screen(demoTag(state, title), [L("g.loading")], retryFoot(state, end));
  if (state.load.kind === "error") {
    return screen(demoTag(state, title), [errorText(state.locale, state.load.code, state.load.status)], retryFoot(state, end));
  }
  return ready();
}

/** The start rows: the cursor is a dot, the entries that belong to a big one hang one step under it. */
export function startLines(locale: Locale, customerMode: boolean, cursor: number): string[] {
  return menuFor(customerMode).map((entry, index) =>
    fit((index === cursor ? "● " : "  ") + (SUB_ENTRIES.includes(entry) ? "  " : "") + t(locale, "g.menu." + entry)));
}

function menuView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const body = startLines(state.locale, state.customerMode, state.menuCursor);
  // One note under the entries: the most important one wins.
  let info = "";
  if (!state.configured && !state.demo) info = L("g.noServer.1");
  else if (state.load.kind === "error") info = errorText(state.locale, state.load.code, state.load.status);
  else if (state.load.kind === "loading" && !state.project) info = L("g.loading");
  else if (state.message) info = state.message;
  else if (state.pendingCount > 0) info = L("g.pending", { count: state.pendingCount });
  else if (state.demo) info = L("g.demoHint");
  body.push("", info);
  const header = state.project ? `${L("g.title")} · ${L("g.menu.projectHeader", { project: state.project })}` : L("g.title");
  return screen(header, body, foot(state, { tap: "open", swipe: "choose" }, state.customerMode ? "back" : "exit"));
}

function takesView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const { shots, cursor } = state.takes;
  const shot = shots[cursor];
  if (!shot) return screen(demoTag(state, L("g.menu.takes").toUpperCase()), [L("g.takes.empty.1"), L("g.takes.empty.2")], retryFoot(state));

  if (state.takes.screen === "actions") {
    const label = (action: TakeAction): string =>
      L("g.actions." + (action === "roll" && state.takes.rollingSince !== null ? "rollStop" : action));
    const body = TAKE_ACTIONS.map((action, index) => marked(label(action), index === state.takes.actionCursor));
    body.push("", state.message);
    const armed = state.armed === "roll" || state.armed === "ng" || state.armed === "delTake" ? armedFooter(state.locale, armLabel(state)) : foot(state, { tap: "ok", swipe: "choose" });
    return screen(L("g.actions.header", { scene: shot.scene, shot: shot.shot, n: state.takes.nextN }), body, armed);
  }

  if (state.takes.screen === "notes") {
    const last = state.takes.last;
    if (!last) return screen(L("g.notes.header", { n: "–" }), [L("g.notes.noTake")], foot(state, { tap: "ok", swipe: "choose" }));
    const body = state.takes.notes.map((note, index) => marked(note, index === state.takes.noteCursor));
    return screen(L("g.notes.header", { n: last.n }), body, foot(state, { tap: "ok", swipe: "choose" }));
  }

  const last = state.takes.last;
  const lastLine = last
    ? L("g.takes.last", { n: last.n, status: last.status, time: clock(last.ts), note: last.note }).trimEnd()
    : L("g.takes.none");
  const desc = shot.desc.trim();
  const rolling = state.takes.rollingSince === null
    ? ""
    : L("g.takes.rolling", { n: state.takes.nextN, time: stopwatch(state.now.getTime() - state.takes.rollingSince) });
  const body = [
    L("g.takes.id", { scene: shot.scene, shot: shot.shot }) + (shot.size ? " · " + shot.size : ""),
    desc,
    rolling,
    L("g.takes.counts", { ok: state.takes.ok, ng: state.takes.ng }),
    lastLine,
    "",
    state.message,
  ];
  return screen(
    demoTag(state, L("g.takes.header", { n: cursor + 1, total: shots.length, scene: shot.scene })),
    body,
    foot(state, { tap: "take", swipe: "shot", hold: "speak" }),
  );
}

function prompterView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const { lines, pos, speed, playing } = state.prompter;
  const start = Math.floor(pos);
  const atEnd = lines.length === 0 || start >= lines.length - 1;
  const stateWord = playing ? L("g.prompter.play") : atEnd && start > 0 ? L("g.prompter.end") : L("g.prompter.pause");
  const header = demoTag(state, L("g.prompter.header", { state: stateWord, speed: speed.toFixed(1) }));
  const tapWord = playing ? "pause" : "start";
  if (lines.length === 0) return screen(header, [L("g.prompter.empty.1"), L("g.prompter.empty.2")], retryFoot(state));
  return screen(header, lines.slice(start, start + MAX_BODY_ROWS), foot(state, { tap: tapWord, swipe: "speed" }));
}

function scheduleView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const { sheet, scroll } = state.schedule;
  const header = demoTag(state, L("g.sched.header", { date: sheet.date || "–", call: sheet.call || "–" }));
  const { now, next, inMinutes } = scheduleNow(sheet.schedule, state.now);
  const body: string[] = [];
  if (now) body.push(L("g.sched.now", { time: now.time, what: now.what }));
  else body.push(L("g.sched.place", { place: sheet.location || "–" }));
  if (next) body.push(L("g.sched.next", { time: next.time, what: next.what, when: minutesText(inMinutes ?? 0) }));
  else if (sheet.schedule.length > 0) body.push(L("g.sched.done"));
  if (sheet.contact) body.push(L("g.sched.contact", { contact: sheet.contact }));
  if (sheet.schedule.length === 0) {
    body.push(L("g.sched.empty"));
  } else {
    const rows = SCHEDULE_BODY_ROWS - body.length;
    const first = Math.max(0, Math.min(scroll, sheet.schedule.length - rows));
    for (const row of sheet.schedule.slice(first, first + rows)) {
      body.push(`${row === now ? "● " : "  "}${row.time.padEnd(6)}${row.what}`);
    }
  }
  return { ...screen(header, body, foot(state, { tap: "reload", swipe: "scroll" })), body: body.slice(0, SCHEDULE_BODY_ROWS).map((row) => fit(row)) };
}

function packView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const { items, cursor, missing } = state.pack;

  if (missing) {
    const open = items.filter((item) => !item.packed);
    const header = L("g.pack.missing.header", { count: open.length });
    if (open.length === 0) return screen(header, [L("g.pack.missing.none")], foot(state, { tap: "list" }));
    const shown = open.length > MAX_BODY_ROWS ? open.slice(0, MAX_BODY_ROWS - 1) : open;
    const body = shown.map((item) => "  " + item.name);
    if (shown.length < open.length) body.push(L("g.pack.missing.more", { count: open.length - shown.length }));
    return screen(header, body, foot(state, { tap: "list" }));
  }

  const done = items.filter((item) => item.packed).length;
  const header = demoTag(state, L("g.pack.header", { done, total: items.length }));
  if (items.length === 0) return screen(header, [L("g.pack.none.1"), L("g.pack.none.2"), "", state.message], retryFoot(state));
  const first = Math.max(0, Math.min(cursor - 2, items.length - PACK_ROWS));
  const body = items.slice(first, first + PACK_ROWS).map((item, offset) =>
    marked(`${item.packed ? "●" : "○"} ${item.name}`, first + offset === cursor));
  while (body.length < PACK_ROWS) body.push("");
  body.push(state.message);
  const armed = state.armed === "packAll" || state.armed === "packReset";
  return screen(header, body, armed ? armedFooter(state.locale, armLabel(state)) : foot(state, { tap: "tick", swipe: "choose", hold: "speak" }));
}

/** The newest `keep` rows of a long text; a cut is marked with a leading ellipsis. */
export function lastRows(rows: readonly string[], keep: number): string[] {
  if (rows.length <= keep) return [...rows];
  const kept = rows.slice(rows.length - Math.max(0, keep));
  if (kept.length > 0) kept[0] = fit("…" + kept[0]);
  return kept;
}

function recView(state: ViewState, rec: RecView): ScreenView {
  const L = (key: string): string => t(state.locale, key);
  // With the side menu: 2× while speaking goes back and keeps the recording (QIS v1.2 no. 2); once it is being recognised, 2× does nothing.
  // Without it nothing could send or discard a kept recording, so 2× cancels as before.
  const busyFoot = SIDE_MENU ? footer(state.locale, {}, "none", L("g.f.wait")) : footer(state.locale, {}, "back");
  const recFoot = rec.via === "hold" ? footer(state.locale, {}, "back", L("g.f.release")) : foot(state, { tap: "finish" });
  const live = (rec.live ?? "").trim();
  // Live speech recognition: the command as heard so far, newest words visible.
  if (live) {
    const rows = lastRows(wrap(live), MAX_BODY_ROWS);
    if (rec.busy) return screen(L("g.rec.busy"), rows, busyFoot);
    return screen(L("g.rec.header"), rows, recFoot);
  }
  if (rec.busy) return screen(L("g.rec.busy"), ["", L("g.rec.busy")], busyFoot);
  const prefix = rec.target === "takes" ? "g.rec.takes." : rec.target === "customer" ? "g.rec.customer." : "g.rec.pack.";
  return screen(
    L("g.rec.header"),
    [L(prefix + "1"), L(prefix + "2"), L(prefix + "3")],
    recFoot,
  );
}

/** "45 min" below two hours, "21 h 59 min" from there on (1319 minutes is not something to do sums with). */
export function minutesText(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 120) return `${total} min`;
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, "0")} min`;
}

/** m:ss, or h:mm:ss after an hour. */
export function stopwatch(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const s = String(seconds % 60).padStart(2, "0");
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${s}`;
  return `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${s}`;
}

function clock(ts: number): string {
  if (!ts) return "";
  const at = new Date(ts);
  return String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Customers → projects → modules (0.5.0)
// ---------------------------------------------------------------------------

/** Rows of a list shown at once; the last body row is for feedback. */
export const LIST_ROWS = 6;

/** The window of a long list that keeps the cursor in view; ↑ and … say where it goes on (↓ is not drawn by the G2). */
function windowed(labels: readonly string[], cursor: number, rows = LIST_ROWS): string[] {
  const first = Math.max(0, Math.min(cursor - Math.floor(rows / 2), labels.length - rows));
  const shown = labels.slice(first, first + rows).map((label, offset) => marked(label, first + offset === cursor));
  const last = shown.length - 1;
  if (first > 0 && shown[0] !== undefined && !shown[0].startsWith(">")) shown[0] = fit("↑" + shown[0].slice(1));
  if (first + rows < labels.length && shown[last] !== undefined && !shown[last].startsWith(">")) shown[last] = fit("…" + shown[last].slice(1));
  return shown;
}

function customersView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const { list, cursor } = state.customers;
  const labels = [L("g.cust.new"), ...list.map((c) => c.name + (c.company && c.company !== c.name ? " · " + c.company : "")), ];
  const body = windowed(labels, cursor);
  if (list.length === 0) body.push(L("g.cust.none"));
  while (body.length < LIST_ROWS) body.push("");
  body.push(state.message || (state.demo ? L("g.demoHint") : ""));
  return screen(demoTag(state, L("g.cust.header", { count: list.length })), body, foot(state, { tap: "open", swipe: "choose", hold: "newCustomer" }, "exit"));
}

function newCustomerView(state: ViewState, name: string): ScreenView {
  const L = (key: string): string => t(state.locale, key);
  // 2× arms "discard the name" (QIS v1.2 no. 2): it is not listed because it only asks.
  return screen(L("g.cust.newHeader"), ["", ...clip(wrap("\"" + name + "\""), 3), "", L("g.cust.confirm"), state.message], foot(state, { tap: "create", hold: "speakAgain" }, "none"));
}

/** "2026-10-14" → "14.10.2026" (de) or "2026-10-14" (en); anything else as typed. */
export function shortDate(locale: Locale, date: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!iso) return date.trim();
  return locale === "de" ? `${iso[3]}.${iso[2]}.${iso[1]}` : date.trim();
}

function projectsView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const { customer, list, cursor, active } = state.projects;
  const labels = [L("g.proj.brief"), ...list.map((p) => (p.date ? shortDate(state.locale, p.date) + " · " : "") + p.name + (p.id === active ? " ●" : ""))];
  const body = windowed(labels, cursor);
  if (list.length === 0) body.push(L("g.proj.none.1"), L("g.proj.none.2"));
  while (body.length < LIST_ROWS) body.push("");
  body.splice(LIST_ROWS);
  body.push(state.message);
  return screen(demoTag(state, L("g.proj.header", { name: customer?.name ?? "–" })), body, foot(state, { tap: "open", swipe: "choose" }));
}

/** Everything on the card before an appointment, as rows; the view pages through them. */
export function briefRows(locale: Locale, brief: Brief): string[] {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const rows: string[] = [];
  const contact = [brief.company, brief.phone, brief.email].filter(Boolean).join(" · ");
  if (contact) rows.push(...wrap(contact));
  if (brief.updated) rows.push(L("g.brief.updated", { date: dateText(locale, brief.updated) }));
  rows.push("", L("g.brief.notes"));
  rows.push(...(brief.notes.trim() ? wrap(brief.notes.trim()) : [L("g.brief.none")]));
  rows.push("", L("g.brief.ideas", { count: brief.ideas.length }));
  if (brief.ideas.length === 0) rows.push(L("g.brief.none"));
  for (const idea of brief.ideas) rows.push(...wrap("· " + idea.text + (idea.tags.length ? " #" + idea.tags.join(" #") : "")));
  if (brief.memory !== null) {
    rows.push("", L("g.brief.babel"));
    if (brief.memoryError) rows.push(L("g.brief.babelError"));
    else if (brief.memory.length === 0) rows.push(L("g.brief.none"));
    for (const note of brief.memory) {
      rows.push(...wrap([note.date.slice(0, 10), note.title].filter(Boolean).join(" · ")));
      if (note.summary) rows.push(...clip(wrap(note.summary), 4));
    }
  }
  // A page never starts with an empty row.
  return rows[0] === "" ? rows.slice(1) : rows;
}

export const briefPages = (locale: Locale, brief: Brief | null): number =>
  brief ? Math.max(1, Math.ceil(briefRows(locale, brief).length / MAX_BODY_ROWS)) : 1;

function briefView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const brief = state.brief.data;
  if (!brief) return screen(L("g.brief.title"), [L("g.loading")], retryFoot(state));
  const rows = briefRows(state.locale, brief);
  const pages = briefPages(state.locale, brief);
  const page = Math.max(0, Math.min(state.brief.page, pages - 1));
  return screen(
    demoTag(state, L("g.brief.header", { name: brief.name })),
    rows.slice(page * MAX_BODY_ROWS, (page + 1) * MAX_BODY_ROWS),
    foot(state, { swipe: "scroll" }, "back", `${page + 1}/${pages}`),
  );
}

/** "0:05–0:12", "0:05–", "–0:12" or "". */
export function sceneTime(scene: BoardScene): string {
  const clockOf = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  if (scene.from !== null && scene.to !== null) return `${clockOf(scene.from)}–${clockOf(scene.to)}`;
  if (scene.from !== null) return clockOf(scene.from) + "–";
  if (scene.to !== null) return "–" + clockOf(scene.to);
  return "";
}

/** At most `max` rows of a text; a cut is marked with an ellipsis. */
function clip(rows: readonly string[], max: number): string[] {
  if (rows.length <= max) return [...rows];
  const kept = rows.slice(0, max);
  const last = kept[max - 1] ?? "";
  kept[max - 1] = last.length >= ROW_WIDTH ? fit(last + "…") : last + "…";
  return kept;
}

/** The scene card while shooting: n/total and time on top, then title, picture, camera, text overlay, goal. */
function boardView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const { boards, board, cursor, picking } = state.board;
  if (boards.length === 0) {
    return screen(demoTag(state, L("g.menu.board").toUpperCase()), [L("g.board.empty.1"), L("g.board.empty.2"), "", state.message], retryFoot(state));
  }
  if (picking) {
    const labels = boards.map((b) => L("g.board.pickItem", { title: b.title || L("g.menu.board"), count: b.scenes.length, done: b.scenes.filter((s) => s.done).length }));
    const body = windowed(labels, board);
    while (body.length < LIST_ROWS) body.push("");
    body.push(state.message);
    return screen(demoTag(state, L("g.board.pick")), body, foot(state, { tap: "open", swipe: "choose" }));
  }
  const current = boards[Math.min(board, boards.length - 1)];
  const scene = current?.scenes[cursor];
  if (!current || !scene) return screen(L("g.menu.board").toUpperCase(), [L("g.board.empty.1"), L("g.board.empty.2")], retryFoot(state));
  const time = sceneTime(scene);
  const header = L("g.board.header", { n: cursor + 1, total: current.scenes.length }) + (time ? " · " + time : "");
  const rows = clip([
    (scene.done ? "● " : "○ ") + (scene.title || L("g.board.scene", { n: scene.n })),
    ...clip(wrap(scene.content), 2),
    ...(scene.camera ? clip(wrap(L("g.board.camera", { text: scene.camera })), 2) : []),
    ...(scene.overlay ? clip(wrap(L("g.board.overlay", { text: scene.overlay })), 2) : []),
    ...(scene.goal ? clip(wrap(L("g.board.goal", { text: scene.goal })), 1) : []),
  ], MAX_BODY_ROWS - 1);
  while (rows.length < MAX_BODY_ROWS - 1) rows.push("");
  rows.push(state.message || (scene.done ? L("g.board.done") : ""));
  return screen(demoTag(state, header), rows, foot(state, { tap: scene.done ? "reopen" : "done", swipe: "scene" }));
}

function dateText(locale: Locale, ts: number): string {
  const at = new Date(ts);
  const dd = String(at.getDate()).padStart(2, "0");
  const mm = String(at.getMonth() + 1).padStart(2, "0");
  return locale === "de" ? `${dd}.${mm}.${at.getFullYear()}` : `${at.getFullYear()}-${mm}-${dd}`;
}

/** The help page: the four gestures in footer order, then what the app needs. */
export function helpView(locale: Locale): ScreenView {
  const L = (key: string): string => t(locale, key);
  const rows = ["g.help.1", "g.help.2", "g.help.3", "g.help.4", "g.help.5", "g.help.6", "g.help.7"].map(L);
  return screen(L("g.help.header"), rows, footer(locale, { tap: L("g.f.close") }, "back"));
}
