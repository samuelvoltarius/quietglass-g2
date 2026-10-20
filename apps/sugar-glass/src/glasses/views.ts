import type { Locale } from "../i18n";
import { t } from "../messages";
import { alerts, type Alert, type Limits } from "../ns/alerts";
import type { Direction, SugarData } from "../ns/model";
import { glucose, insulin, unitLabel, type Unit } from "../ns/units";
import { footer as qisFooter } from "./footer";
import { fit } from "./screen";
import type { TextView } from "./page";

/**
 * What the text pages of the glasses show (QUS v1): only the start page. The
 * glucose and the pump page are the cockpit image (src/cockpit), not text.
 * The page is a header `Sugar Glass · ● live`, a few rows and ONE footer line.
 */

export type Connection =
  | { readonly kind: "setup" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly code: string; readonly status?: number };

export type Page = "glucose" | "pump";
export const PAGES: readonly Page[] = ["glucose", "pump"];

export interface ViewState {
  readonly locale: Locale;
  readonly demo: boolean;
  readonly connection: Connection;
  readonly data: SugarData | null;
  readonly page: Page;
  readonly unit: Unit;
  readonly limits: Limits;
  /** Wall clock ("x min ago"). */
  readonly now: number;
  /** First start without a server address: the values are a demo and the glasses say how to set up the real thing (QIS v1.2 no. 7). */
  readonly demoHint?: boolean;
}

export const HEADER_WIDTH = 50;
export const ROW_WIDTH = 56;
/** Rows a list shows at most (QUS 1.3). */
export const VISIBLE_ROWS = 5;

/**
 * Why something failed, in plain words. The glasses never show a status code (QIS v1.2 no. 8);
 * the phone asks with `detail` and gets "Fehler (HTTP 503)".
 */
export function errorReason(locale: Locale, code: string, status?: number, detail = false): string {
  if (detail && code === "http") return t(locale, "p.err.httpDetail", { status: status ?? 0 });
  return t(locale, "g.err." + code, { status: status ?? 0 });
}

/** "vor 3 min", "vor 1 h 05". */
export function ageText(locale: Locale, ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return t(locale, "g.age.now");
  if (minutes < 60) return t(locale, "g.age.min", { n: minutes });
  return t(locale, "g.age.h", { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, "0") });
}

/** "3 min" / "2 h" for a cell. */
export function ageShort(locale: Locale, ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 100 ? t(locale, "g.ageShort", { n: minutes }) : t(locale, "g.ageShortH", { n: Math.floor(minutes / 60) });
}

/** For the phone page: Unicode arrows are fine there. */
export function arrowText(direction: Direction): string {
  const map: Partial<Record<Direction, string>> = {
    TripleUp: "⇈↑", DoubleUp: "⇈", SingleUp: "↑", FortyFiveUp: "↗", Flat: "→",
    FortyFiveDown: "↘", SingleDown: "↓", DoubleDown: "⇊", TripleDown: "⇊↓",
  };
  return map[direction] ?? "?";
}

export function currentAlerts(state: ViewState): Alert[] {
  if (!state.data) return [];
  return alerts(state.data.readings, state.limits, state.now);
}

export type LiveWord = "live" | "stale" | "offline" | "demo";

/** `demo` for the sample values, `offline` without data or when the server failed, `stale` for an old value, else `live`. */
export function liveWord(state: ViewState): LiveWord {
  if (state.demo || state.demoHint) return "demo";
  if (!state.data || state.connection.kind === "error" || state.connection.kind === "loading") return "offline";
  return currentAlerts(state).some((alert) => alert.kind === "stale") ? "stale" : "live";
}

/** `Sugar Glass · ● live` (QUS 1.1). */
export function headerLine(locale: Locale, title: string, word: LiveWord): string {
  const state = word === "live" ? "● " + t(locale, "g.live") : word === "demo" ? t(locale, "g.demoWord") : word === "stale" ? t(locale, "g.staleWord") : t(locale, "g.offlineWord");
  return fit(`${title} · ${state}`, HEADER_WIDTH);
}

export type StartRow = { readonly kind: "glucose" } | { readonly kind: "pump" };

/** The selectable rows: at most three entries, here the glucose cockpit and the pump cockpit. */
export function startRows(): StartRow[] {
  return [{ kind: "glucose" }, { kind: "pump" }];
}

/** The worst alert that needs a word on the start page (critical, or rising fast), as a row. */
export function alertRow(state: ViewState): string | null {
  const list = currentAlerts(state);
  const worst = list.find((alert) => alert.kind !== "noData");
  const newest = state.data?.readings[0];
  if (!worst || !newest) return null;
  const text = t(state.locale, "g.alert." + worst.kind, {
    value: glucose(newest.mgdl, state.unit, state.locale), unit: unitLabel(state.unit), age: ageText(state.locale, state.now - newest.at),
  });
  return fit(worst.critical ? `! ${text}` : text, ROW_WIDTH);
}

export function startView(state: ViewState, cursor: number): TextView {
  const { locale } = state;
  const rows = startRows();
  const at = Math.min(Math.max(0, cursor), rows.length - 1);
  const newest = state.data?.readings[0];
  const pump = state.data?.pump;
  const labels = rows.map((row) => {
    if (row.kind === "glucose") return `${t(locale, "g.start.glucose")} · ${newest ? `${glucose(newest.mgdl, state.unit, locale)} ${unitLabel(state.unit)}` : t(locale, "g.start.noValue")}`;
    return `${t(locale, "g.start.pump")} · ${pump && pump.iob !== null ? `${t(locale, "g.cp.iob")} ${insulin(pump.iob, locale)}` : "–"}`;
  });
  const body = labels.map((label, index) => fit((index === at ? "● " : "  ") + label, ROW_WIDTH));
  const alert = alertRow(state);
  if (alert) body.push(alert);
  if (state.demoHint) body.push(t(locale, "g.demoHint"));
  return {
    header: headerLine(locale, t(locale, "g.app"), liveWord(state)),
    body,
    footer: fit(qisFooter(locale, { tap: t(locale, "g.f.open"), swipe: t(locale, "g.f.pick") }, "exit"), ROW_WIDTH),
  };
}
