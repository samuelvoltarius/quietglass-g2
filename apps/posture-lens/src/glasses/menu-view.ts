import type { Locale } from "../i18n";
import { t } from "../messages";
import { armedFooter, footer } from "./footer";
import { fitView } from "./fit";
import type { TextView } from "./page";

/**
 * The app's own list (Hold on the posture screen, used while the glasses' side menu is off): at most three
 * entries (QUS v1). Everything that is not "look at your posture" lives here: the sensor test and clearing
 * today's tally (armed first, QIS v1). A swipe only moves; the tally can only be cleared by tapping its entry
 * twice. The help lives on the phone.
 */
export type MenuEntry = "sensor" | "reset";
export const MENU_ENTRIES: readonly MenuEntry[] = ["sensor", "reset"];

export interface MenuViewOptions {
  readonly locale: Locale;
  readonly cursor: number;
  /** The tally entry is armed and waits for its confirming tap. */
  readonly resetArmed: boolean;
  /** A short note in the header (e.g. "Tally cleared") until the next gesture. */
  readonly note?: string | null;
}

export function buildMenuView(options: MenuViewOptions): TextView {
  const { locale } = options;
  const cursor = Math.min(Math.max(0, options.cursor), MENU_ENTRIES.length - 1);
  const body = MENU_ENTRIES.map((entry, index) => {
    const selected = index === cursor;
    const armed = selected && entry === "reset" && options.resetArmed;
    return (selected ? "● " : "  ") + (armed ? t(locale, "g.m.sure") : "") + t(locale, "g.m." + entry);
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
