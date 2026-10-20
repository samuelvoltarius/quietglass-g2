import type { Locale } from "../i18n";
import { defaultProject, t } from "../messages";
import type { TimeEntry } from "../tracking/clock";
import { footer } from "./footer";

/**
 * The text page of the glasses (QUS v1): the start page. The running shift,
 * the pause and the finish are the cockpit image (src/cockpit), not text.
 *
 * The page is the same three parts as everywhere: a header `Schicht · ● live`,
 * a body of at most three big entries and ONE footer line with the gestures
 * that do something.
 */
export interface ClockView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

/** Entries the start page shows at most (QUS 1.1: three big entries). */
export const VISIBLE_ROWS = 3;
/** Characters one row holds across the 576 px display in its proportional font. */
export const LINE_WIDTH = 56;
export const HEADER_WIDTH = LINE_WIDTH;
export const FOOTER_WIDTH = LINE_WIDTH;

/** A stop must be confirmed by a second tap within this time (QIS v1, section 2). */
export const ARM_MS = 4_000;

export type StartRow =
  /** Starts this project. */
  | { readonly kind: "project"; readonly name: string }
  /** No project yet: one tap creates the default one, so the glasses are never a dead end. */
  | { readonly kind: "create"; readonly name: string };

/**
 * The selectable rows: the projects, the most recently used first (the one
 * wanted again is nearly always on top). Without a project the one row that
 * creates it.
 */
export function startRows(projects: readonly string[], entries: readonly TimeEntry[], locale: Locale): StartRow[] {
  if (projects.length === 0) return [{ kind: "create", name: defaultProject(locale) }];
  const lastUsed = new Map<string, number>();
  for (const entry of entries) lastUsed.set(entry.project, Math.max(lastUsed.get(entry.project) ?? 0, entry.endedAt));
  return projects
    .map((name, index) => ({ name, index, used: lastUsed.get(name) ?? -1 }))
    .sort((a, b) => b.used - a.used || a.index - b.index)
    .map((row): StartRow => ({ kind: "project", name: row.name }));
}

export type LiveWord = "live" | "demo";

/** `Schicht · ● live` (QUS 1.1): the mode, a dot while live, the state as a word otherwise. */
export function headerLine(locale: Locale, word: LiveWord): string {
  const state = word === "live" ? "● " + t(locale, "g.live") : t(locale, "g.demoWord");
  return `${t(locale, "g.title")} · ${state}`;
}

export interface StartOptions {
  readonly locale: Locale;
  readonly demo: boolean;
  /** The page opened from the pause page: 2× goes back there instead of leaving. */
  readonly canGoBack: boolean;
}

/** Where the window of `rows` around the cursor starts. */
export function windowStart(total: number, cursor: number, rows: number): number {
  return Math.max(0, Math.min(cursor - Math.floor(rows / 2), total - rows));
}

export function startView(rows: readonly StartRow[], cursor: number, options: StartOptions): ClockView {
  const { locale } = options;
  const at = Math.min(Math.max(0, cursor), Math.max(0, rows.length - 1));
  const first = windowStart(rows.length, at, VISIBLE_ROWS);
  const body = rows.slice(first, first + VISIBLE_ROWS).map((row, index) => {
    // The cursor is a dot.
    const mark = first + index === at ? "● " : "  ";
    const label = row.kind === "create" ? t(locale, "g.create", { name: row.name }) : row.name;
    return truncate(mark + label, LINE_WIDTH);
  });
  const create = rows[at]?.kind === "create";
  return {
    header: headerLine(locale, options.demo ? "demo" : "live"),
    body,
    footer: footer(locale, {
      tap: t(locale, create ? "g.f.create" : "g.f.start"),
      ...(rows.length > 1 ? { swipe: t(locale, "g.f.choose") } : {}),
    }, options.canGoBack ? "back" : "exit"),
  };
}

export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)).trimEnd() + "…";
}
