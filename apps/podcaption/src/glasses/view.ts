import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import type { Caption } from "../podcast/parse";
import { BODY_ROWS, LINE_WIDTH, captionRows, errorRow } from "../podcast/view";
import { footer } from "./footer";
import type { TextView } from "./page";

/**
 * What the text pages of the glasses show (QUS v1): the start page and the
 * captions as a reading view (episode as the context head, the captions below,
 * the newest at the bottom is the one being said). The status is the cockpit
 * image (src/cockpit). Every page is a header `Mode · ● läuft`, the rows and
 * ONE footer line.
 */

export type Source = "DEMO" | "FILE" | "RSS";
export const SOURCE_TAG: Record<Source, string> = { DEMO: "tagDemo", FILE: "tagFile", RSS: "tagFeed" };

/** What is on the glasses. */
export type Screen = "start" | "captions" | "status";

/** What the views are built from. */
export interface PodState {
  readonly locale: Locale;
  readonly captions: readonly Caption[];
  readonly episode: string;
  readonly cursor: number;
  readonly source: Source;
  readonly playing: boolean;
  /** One glasses row of text about a failure ("" = none); never a status code. */
  readonly failure: string;
}

const t = (locale: Locale, key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);

/** Rows a list shows at most (QUS 1.3). */
export const VISIBLE_ROWS = 5;

/** `Untertitel · ● läuft · Datei`: the mode, the state, where the text is from. */
export function headerLine(locale: Locale, title: string, state: PodState, withSource = false): string {
  const word = t(locale, state.playing ? "stPlay" : "stPause");
  return `${title} · ${word}${withSource ? ` · ${t(locale, SOURCE_TAG[state.source])}` : ""}`.slice(0, LINE_WIDTH);
}

export type StartRow = { readonly kind: "captions" } | { readonly kind: "status" };

/** The selectable rows: at most three entries, here the captions and the status. */
export function startRows(): StartRow[] {
  return [{ kind: "captions" }, { kind: "status" }];
}

/** How far the captions are: 0..100. */
export function progress(state: Pick<PodState, "captions" | "cursor">): number {
  const last = state.captions.length - 1;
  return last <= 0 ? 0 : Math.round((Math.max(0, Math.min(last, state.cursor)) / last) * 100);
}

const cutTo = (text: string, width: number): string => (text.length <= width ? text : text.slice(0, Math.max(0, width - 1)).trimEnd() + "…");

export function startView(state: PodState, cursor: number): TextView {
  const { locale } = state;
  const rows = startRows();
  const at = Math.min(Math.max(0, cursor), rows.length - 1);
  const labels = rows.map((row) => row.kind === "captions"
    ? `${t(locale, "tabCaptions")} · ${cutTo(state.episode, 26)}`
    : `${t(locale, "modeStatus")} · ${progress(state)} %`);
  const body = labels.map((label, index) => cutTo((index === at ? "● " : "  ") + label, LINE_WIDTH));
  if (state.failure) body.push(errorRow(state.failure));
  return { header: headerLine(locale, "PodCaption", state), body, footer: footer(locale, { tap: t(locale, "actOpen"), swipe: t(locale, "actPick") }, "exit") };
}

export function captionsView(state: PodState): TextView {
  const { locale } = state;
  const rows = state.failure
    ? [...captionRows(state.episode, state.captions, state.cursor, BODY_ROWS - 1), errorRow(state.failure)]
    : captionRows(state.episode, state.captions, state.cursor);
  return {
    header: headerLine(locale, t(locale, "tabCaptions"), state, true),
    body: rows,
    footer: footer(locale, { tap: t(locale, state.playing ? "actPause" : "actPlay"), swipe: t(locale, "actScroll") }, "back"),
  };
}
