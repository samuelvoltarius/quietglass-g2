import type { CallSheet, EquipmentItem, Shot, TakeStatus } from "../api/types";
import { scheduleNow } from "../api/types";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { fit, marked, MAX_BODY_ROWS, type ScreenView } from "./screen";

/**
 * Everything the glasses show, as pure functions of a state snapshot. No SDK,
 * no network, no timers — so every screen can be checked against the 7 × 46
 * display limit in the tests, in both languages, with worst-case content.
 */

export type Mode = "menu" | "takes" | "prompter" | "schedule" | "pack";
export const MENU: readonly Exclude<Mode, "menu">[] = ["takes", "prompter", "schedule", "pack"];
export type TakeScreen = "card" | "actions" | "notes";
export const TAKE_ACTIONS = ["ok", "ng", "note", "voice", "back"] as const;
export type TakeAction = (typeof TAKE_ACTIONS)[number];

export type LoadStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "error"; readonly code: string; readonly status?: number };

export interface RecView {
  readonly target: "takes" | "pack";
  readonly via: "tap" | "hold";
  /** True once the microphone is off and the server is recognising. */
  readonly busy: boolean;
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
}

/** Rows of the schedule shown below the now/next lines. */
export const SCHEDULE_ROWS = 4;
/** Rows of the packing list shown at once; the last body row is for feedback. */
export const PACK_ROWS = 6;

export function buildView(state: ViewState): ScreenView {
  if (state.rec) return recView(state, state.rec);
  switch (state.mode) {
    case "menu": return menuView(state);
    case "takes": return withLoad(state, t(state.locale, "g.menu.takes").toUpperCase(), () => takesView(state));
    case "prompter": return withLoad(state, "TELEPROMPTER", () => prompterView(state));
    case "schedule": return withLoad(state, t(state.locale, "g.menu.schedule").toUpperCase(), () => scheduleView(state));
    case "pack": return withLoad(state, t(state.locale, "g.menu.pack").toUpperCase(), () => packView(state));
  }
}

/** Fits every row and pads nothing: what is returned is exactly what is drawn. */
function screen(header: string, body: readonly string[], footer: string): ScreenView {
  return {
    header: fit(header),
    body: body.slice(0, MAX_BODY_ROWS).map((row) => fit(row)),
    footer: fit(footer),
  };
}

const demoTag = (state: ViewState, header: string): string => (state.demo ? header + " · " + t(state.locale, "g.demo") : header);

export function errorText(locale: Locale, code: string, status?: number): string {
  const reason = t(locale, "g.err." + code, { status: status ?? 0 });
  return t(locale, "g.error", { reason });
}

function withLoad(state: ViewState, title: string, ready: () => ScreenView): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  if (state.load.kind === "loading" || state.load.kind === "idle") return screen(demoTag(state, title), [L("g.loading")], L("g.retry"));
  if (state.load.kind === "error") {
    return screen(demoTag(state, title), [errorText(state.locale, state.load.code, state.load.status)], L("g.retry"));
  }
  return ready();
}

function menuView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const body = MENU.map((mode, index) => marked(L("g.menu." + mode), index === state.menuCursor));
  body.push("");
  if (!state.configured && !state.demo) {
    body.push(L("g.noServer.1"), L("g.noServer.2"));
  } else {
    if (state.load.kind === "error") body.push(errorText(state.locale, state.load.code, state.load.status));
    else if (state.project) body.push(L("g.menu.project", { project: state.project }));
    else if (state.load.kind === "loading") body.push(L("g.loading"));
    if (state.pendingCount > 0) body.push(L("g.pending", { count: state.pendingCount }));
  }
  return screen(demoTag(state, L("g.title")), body, L("g.menu.footer"));
}

function takesView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const { shots, cursor } = state.takes;
  const shot = shots[cursor];
  if (!shot) return screen(demoTag(state, L("g.menu.takes").toUpperCase()), [L("g.takes.empty.1"), L("g.takes.empty.2")], L("g.retry"));

  if (state.takes.screen === "actions") {
    const body = TAKE_ACTIONS.map((action, index) => marked(L("g.actions." + action), index === state.takes.actionCursor));
    body.push("", state.message);
    return screen(L("g.actions.header", { scene: shot.scene, shot: shot.shot, n: state.takes.nextN }), body, L("g.list.footer"));
  }

  if (state.takes.screen === "notes") {
    const last = state.takes.last;
    if (!last) return screen(L("g.notes.header", { n: "–" }), [L("g.notes.noTake")], L("g.list.footer"));
    const body = state.takes.notes.map((note, index) => marked(note, index === state.takes.noteCursor));
    return screen(L("g.notes.header", { n: last.n }), body, L("g.list.footer"));
  }

  const last = state.takes.last;
  const lastLine = last
    ? L("g.takes.last", { n: last.n, status: last.status, time: clock(last.ts), note: last.note }).trimEnd()
    : L("g.takes.none");
  const desc = shot.desc.trim();
  const body = [
    `${shot.scene} · ${shot.shot}${shot.size ? "   " + shot.size : ""}`,
    desc,
    "",
    L("g.takes.counts", { ok: state.takes.ok, ng: state.takes.ng }),
    lastLine,
    "",
    state.message,
  ];
  return screen(
    demoTag(state, L("g.takes.header", { n: cursor + 1, total: shots.length, scene: shot.scene })),
    body,
    L("g.takes.footer"),
  );
}

function prompterView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const { lines, pos, speed, playing } = state.prompter;
  const start = Math.floor(pos);
  const atEnd = lines.length === 0 || start >= lines.length - 1;
  const stateWord = playing ? L("g.prompter.play") : atEnd && start > 0 ? L("g.prompter.end") : L("g.prompter.pause");
  const header = demoTag(state, L("g.prompter.header", { state: stateWord, speed: speed.toFixed(1) }));
  if (lines.length === 0) return screen(header, [L("g.prompter.empty.1"), L("g.prompter.empty.2")], L("g.prompter.footer"));
  return screen(header, lines.slice(start, start + MAX_BODY_ROWS), L("g.prompter.footer"));
}

function scheduleView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const { sheet, scroll } = state.schedule;
  const header = demoTag(state, L("g.sched.header", { date: sheet.date || "–", call: sheet.call || "–" }));
  const { now, next, inMinutes } = scheduleNow(sheet.schedule, state.now);
  const body: string[] = [];
  if (now) body.push(L("g.sched.now", { time: now.time, what: now.what }));
  else body.push(L("g.sched.place", { place: sheet.location || "–" }));
  if (next) body.push(L("g.sched.next", { time: next.time, what: next.what, min: inMinutes ?? 0 }));
  else if (sheet.schedule.length > 0) body.push(L("g.sched.done"));
  if (sheet.contact) body.push(L("g.sched.contact", { contact: sheet.contact }));
  body.push("");
  if (sheet.schedule.length === 0) {
    body.push(L("g.sched.empty"));
  } else {
    const rows = MAX_BODY_ROWS - body.length;
    const first = Math.max(0, Math.min(scroll, sheet.schedule.length - rows));
    for (const row of sheet.schedule.slice(first, first + rows)) {
      body.push(`${row === now ? "● " : "  "}${row.time.padEnd(6)}${row.what}`);
    }
  }
  return screen(header, body, L("g.sched.footer"));
}

function packView(state: ViewState): ScreenView {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  const { items, cursor, missing } = state.pack;

  if (missing) {
    const open = items.filter((item) => !item.packed);
    const header = L("g.pack.missing.header", { count: open.length });
    if (open.length === 0) return screen(header, [L("g.pack.missing.none")], L("g.pack.missing.footer"));
    const shown = open.length > MAX_BODY_ROWS ? open.slice(0, MAX_BODY_ROWS - 1) : open;
    const body = shown.map((item) => "  " + item.name);
    if (shown.length < open.length) body.push(L("g.pack.missing.more", { count: open.length - shown.length }));
    return screen(header, body, L("g.pack.missing.footer"));
  }

  const done = items.filter((item) => item.packed).length;
  const header = demoTag(state, L("g.pack.header", { done, total: items.length }));
  if (items.length === 0) return screen(header, [L("g.pack.none.1"), L("g.pack.none.2"), "", state.message], L("g.pack.footer"));
  const first = Math.max(0, Math.min(cursor - 2, items.length - PACK_ROWS));
  const body = items.slice(first, first + PACK_ROWS).map((item, offset) =>
    marked(`${item.packed ? "●" : "○"} ${item.name}`, first + offset === cursor));
  while (body.length < PACK_ROWS) body.push("");
  body.push(state.message);
  return screen(header, body, L("g.pack.footer"));
}

function recView(state: ViewState, rec: RecView): ScreenView {
  const L = (key: string): string => t(state.locale, key);
  if (rec.busy) return screen(L("g.rec.busy"), ["", L("g.rec.busy")], L("g.rec.footer.busy"));
  const prefix = rec.target === "takes" ? "g.rec.takes." : "g.rec.pack.";
  return screen(
    L("g.rec.header"),
    [L(prefix + "1"), L(prefix + "2"), L(prefix + "3")],
    L(rec.via === "hold" ? "g.rec.footer.hold" : "g.rec.footer.tap"),
  );
}

function clock(ts: number): string {
  if (!ts) return "";
  const at = new Date(ts);
  return String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
}
