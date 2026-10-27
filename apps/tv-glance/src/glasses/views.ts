import type { Locale } from "../i18n";
import { t } from "../messages";
import { DPAD_KEYS, type AppEntry, type DpadKey, type TvState } from "../tv/model";
import { armedFooter, footer as qisFooter } from "./footer";
import { fit } from "./screen";
import type { TextView } from "./page";

/**
 * What the text pages of the glasses show (QUS v1): the start page with at
 * most three entries and the two lists (apps & input, D-pad). The remote
 * itself is the cockpit image (src/cockpit). Header `TV Glance · ● live`, at
 * most five list rows, ONE footer line; no footer ever offers Hold.
 */

export type Connection =
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly code: string; readonly status?: number };

export type Screen = "start" | "remote" | "apps" | "dpad";

export interface ViewState {
  readonly locale: Locale;
  /** The demo TV is in use (nothing configured, or `?demo=1`). */
  readonly demo: boolean;
  readonly connection: Connection;
  /** The last state read from the TV, or null before the first answer. */
  readonly tv: TvState | null;
  /** True when the backend can send D-pad keys. */
  readonly dpad: boolean;
  /** What "Apps & input" offers besides power and mute. */
  readonly entries: readonly AppEntry[];
  /** Volume steps swiped but not sent yet (shown at once). */
  readonly pendingVolume: number;
  /** One short line after a command ("→ Netflix", "not sent · not reachable"), or null. */
  readonly flash: string | null;
  /** Switch-off is armed: the next tap on it switches the TV off. */
  readonly armed: boolean;
  readonly now: number;
  /** The active device of the Home Assistant list; the switch and the names show only with two or more. */
  readonly device?: DeviceInfo;
}

export interface DeviceInfo {
  /** The name shown on the glasses. */
  readonly name: string;
  /** 0-based position of the active device. */
  readonly index: number;
  readonly count: number;
}

/** The glasses show the device name and the switch only when there is something to switch between. */
export const hasChoice = (state: Pick<ViewState, "device">): boolean => (state.device?.count ?? 0) >= 2;

export const HEADER_WIDTH = 50;
export const ROW_WIDTH = 56;
/** Rows a list shows at most (QUS 1.3). */
export const VISIBLE_ROWS = 5;

/** Why something failed, in plain words; the glasses never show a status code, the phone asks with `detail`. */
export function errorReason(locale: Locale, code: string, status?: number, detail = false): string {
  if (detail && code === "http") return t(locale, "p.err.httpDetail", { status: status ?? 0 });
  return t(locale, "g.err." + code);
}

export type LiveWord = "live" | "offline" | "demo";

export function liveWord(state: ViewState): LiveWord {
  if (state.demo) return "demo";
  if (!state.tv || state.connection.kind !== "ok") return "offline";
  return "live";
}

/** `TV Glance · ● live`, `Apps & Eingang · DEMO` (QUS 1.1). */
export function headerLine(locale: Locale, title: string, word: LiveWord, device?: string): string {
  const state = word === "live" ? "● " + t(locale, "g.live") : word === "demo" ? t(locale, "g.demoWord") : t(locale, "g.offlineWord");
  const tail = ` · ${state}`;
  // The live word never gets cut: the title and the device name share what is left.
  const room = HEADER_WIDTH - tail.length;
  const head = device ? `${title} · ${device}` : title;
  return fit(head.length > room ? fit(head, room) + tail : head + tail, HEADER_WIDTH);
}

/** The header of a view: the device name stands in it when there are two or more devices. */
const headerOf = (state: ViewState, title: string): string => headerLine(state.locale, title, liveWord(state), hasChoice(state) ? state.device?.name : undefined);

export type StartRow = "remote" | "apps" | "dpad" | "device";

/** Remote, apps, the D-pad when the backend can send it, and the device switch when two or more devices are set up. */
export function startRows(state: Pick<ViewState, "dpad" | "device">): StartRow[] {
  const rows: StartRow[] = state.dpad ? ["remote", "apps", "dpad"] : ["remote", "apps"];
  if (hasChoice(state)) rows.push("device");
  return rows;
}

/** The volume as shown: the TV's value plus the swipes still on their way. */
export function shownVolume(state: Pick<ViewState, "tv" | "pendingVolume">): number | null {
  const volume = state.tv?.volume ?? null;
  if (volume === null) return null;
  return Math.max(0, Math.min(100, volume + state.pendingVolume));
}

/** "an · Netflix · 18" for the start page. */
export function remoteSummary(state: ViewState): string {
  const { locale, tv } = state;
  if (!tv) return state.connection.kind === "error" ? errorReason(locale, state.connection.code) : "…";
  if (tv.unavailable) return t(locale, "g.unavailable");
  const parts = [t(locale, "g.power." + tv.power)];
  if (tv.power === "on") {
    const what = tv.app ?? tv.source;
    if (what) parts.push(what);
    const volume = shownVolume(state);
    if (tv.muted) parts.push(t(locale, "g.cp.muted").toLowerCase());
    else if (volume !== null) parts.push(String(volume));
  }
  return parts.join(" · ");
}

function marker(selected: boolean): string {
  return selected ? "● " : "  ";
}

export function startView(state: ViewState, cursor: number): TextView {
  const { locale } = state;
  const rows = startRows(state);
  const at = Math.min(Math.max(0, cursor), rows.length - 1);
  const labels = rows.map((row) => {
    if (row === "remote") return `${t(locale, "g.start.remote")} · ${remoteSummary(state)}`;
    if (row === "apps") return t(locale, "g.start.apps");
    if (row === "device") return `${t(locale, "g.start.device")}: ${state.device?.name ?? ""} (${(state.device?.index ?? 0) + 1}/${state.device?.count ?? 1})`;
    return t(locale, "g.start.dpad");
  });
  const body = labels.map((label, index) => fit(marker(index === at) + label, ROW_WIDTH));
  if (state.demo) body.push("", t(locale, "g.demoHint"));
  return {
    header: headerOf(state, t(locale, "g.app")),
    body,
    footer: fit(qisFooter(locale, { tap: t(locale, rows[at] === "device" ? "g.f.switch" : "g.f.open"), swipe: t(locale, "g.f.pick") }, "exit"), ROW_WIDTH),
  };
}

// ---- the two lists ----------------------------------------------------------------------

export type AppsItem =
  | { readonly kind: "power"; readonly on: boolean }
  | { readonly kind: "mute"; readonly on: boolean }
  | { readonly kind: "launch"; readonly entry: AppEntry };

/** Power first (switch on / off), mute when the TV is on, then the sources and apps. */
export function appsItems(state: Pick<ViewState, "tv" | "entries">): AppsItem[] {
  const isOn = state.tv?.power === "on";
  const items: AppsItem[] = [{ kind: "power", on: !isOn }];
  if (isOn) items.push({ kind: "mute", on: state.tv?.muted !== true });
  for (const entry of state.entries) items.push({ kind: "launch", entry });
  return items;
}

export function appsItemLabel(locale: Locale, item: AppsItem): string {
  switch (item.kind) {
    case "power": return t(locale, item.on ? "g.list.powerOn" : "g.list.powerOff");
    case "mute": return t(locale, item.on ? "g.list.muteOn" : "g.list.muteOff");
    case "launch": return item.entry.label;
  }
}

export const dpadItems = (): readonly DpadKey[] => DPAD_KEYS;

/** The first visible row of a list of `count` rows so that `cursor` stays in view (centred where possible). */
export function windowStart(count: number, cursor: number, rows = VISIBLE_ROWS): number {
  if (count <= rows) return 0;
  return Math.max(0, Math.min(count - rows, cursor - Math.floor(rows / 2)));
}

function listBody(labels: readonly string[], cursor: number): string[] {
  const at = Math.min(Math.max(0, cursor), Math.max(0, labels.length - 1));
  const start = windowStart(labels.length, at);
  return labels.slice(start, start + VISIBLE_ROWS).map((label, index) => fit(marker(start + index === at) + label, ROW_WIDTH));
}

export function appsView(state: ViewState, cursor: number): TextView {
  const { locale } = state;
  const items = appsItems(state);
  const body = listBody(items.map((item) => appsItemLabel(locale, item)), cursor);
  if (state.tv?.unavailable) body.push(fit(t(locale, "g.err.unavailable"), ROW_WIDTH));
  else if (state.entries.length === 0) body.push(fit(t(locale, "g.list.empty"), ROW_WIDTH));
  const armed = state.armed && items[Math.min(cursor, items.length - 1)]?.kind === "power";
  if (armed) body.push(fit(t(locale, "g.armedRow"), ROW_WIDTH));
  else if (state.flash) body.push(fit(state.flash, ROW_WIDTH));
  return {
    header: headerOf(state, t(locale, "g.start.apps")),
    body,
    footer: armed
      ? fit(armedFooter(locale, t(locale, "g.armed")), ROW_WIDTH)
      : fit(qisFooter(locale, { tap: t(locale, "g.f.send"), swipe: t(locale, "g.f.pick") }, "back"), ROW_WIDTH),
  };
}

export function dpadView(state: ViewState, cursor: number): TextView {
  const { locale } = state;
  const body = listBody(dpadItems().map((key) => t(locale, "g.key." + key)), cursor);
  if (state.flash) body.push(fit(state.flash, ROW_WIDTH));
  return {
    header: headerOf(state, t(locale, "g.start.dpad")),
    body,
    footer: fit(qisFooter(locale, { tap: t(locale, "g.f.send"), swipe: t(locale, "g.f.pick") }, "back"), ROW_WIDTH),
  };
}
