import type { Locale } from "../i18n";
import { t } from "../messages";
import { armedFooter, footer } from "./footer";
import { BODY_ROWS, fitView } from "./fit";
import type { PostureView } from "./view";

/**
 * The app's own menu (Hold on the posture screen, used while the glasses' side menu is off) and the help page behind it.
 *
 * Everything that is not "look at your posture" lives here: the sensor test, clearing today's tally (armed
 * first, QIS v1) and the help. A swipe only moves; the tally can only be cleared by tapping its entry twice.
 */
export type MenuEntry = "sensor" | "reset" | "help";
export const MENU_ENTRIES: readonly MenuEntry[] = ["sensor", "reset", "help"];

export interface MenuViewOptions {
  readonly locale: Locale;
  readonly cursor: number;
  /** The tally entry is armed and waits for its confirming tap. */
  readonly resetArmed: boolean;
  /** A short note in the header (e.g. "Tally cleared") until the next gesture. */
  readonly note?: string | null;
}

export function buildMenuView(options: MenuViewOptions): PostureView {
  const { locale } = options;
  const cursor = Math.min(Math.max(0, options.cursor), MENU_ENTRIES.length - 1);
  const body = MENU_ENTRIES.map((entry, index) => {
    const selected = index === cursor;
    const armed = selected && entry === "reset" && options.resetArmed;
    return (selected ? "> " : "  ") + (armed ? t(locale, "g.m.sure") : "") + t(locale, "g.m." + entry);
  });
  const armed = options.resetArmed && MENU_ENTRIES[cursor] === "reset";
  return fitView({
    header: `${t(locale, "g.title")} · ${options.note ?? t(locale, "g.sMenu")}`,
    body,
    footer: armed
      ? armedFooter(locale, t(locale, "g.a.reset"))
      : footer(locale, { tap: t(locale, "g.w.pick"), swipe: t(locale, "g.w.list") }, "back"),
  });
}

const HELP_LINES = 6;

/** Pages of the help text: three lines each (the body holds three rows). */
export const HELP_PAGES = HELP_LINES / BODY_ROWS;

export function buildHelpView(locale: Locale, page: number): PostureView {
  const shown = ((Math.floor(page) % HELP_PAGES) + HELP_PAGES) % HELP_PAGES;
  const body = Array.from({ length: BODY_ROWS }, (_, i) => t(locale, "g.help" + (shown * BODY_ROWS + i + 1)));
  return fitView({
    header: `${t(locale, "g.title")} · ${t(locale, "g.sHelp", { page: shown + 1, pages: HELP_PAGES })}`,
    body,
    footer: footer(locale, { swipe: t(locale, "g.w.page") }, "back"),
  });
}
