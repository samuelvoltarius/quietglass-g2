import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * The native contextual menu (tap and hold; the glasses draw it) is how the
 * passenger moves between the pages. Each page offers only what makes sense
 * on it, so the menu is never longer than four short verbs.
 */

export type Screen = "board" | "places" | "plans" | "guide" | "voice" | "help";

export const MENU = {
  route: 1, board: 2, refresh: 3, goals: 4, again: 5, next: 6, prev: 7, stop: 8, saveVoice: 9, otherStop: 10, help: 11,
} as const;

export interface MenuItemSpec { readonly id: number; readonly label: string }
export interface MenuSpec {
  /** Changes exactly when the glasses need a different menu (one page rebuild). */
  readonly key: string;
  readonly items: readonly MenuItemSpec[];
}

export function menuFor(screen: Screen, locale: Locale): MenuSpec {
  const item = (id: number, key: string): MenuItemSpec => ({ id, label: t(locale, key) });
  const items: Record<Screen, MenuItemSpec[]> = {
    board: [item(MENU.route, "r.menuRoute"), item(MENU.otherStop, "r.menuOtherStop"), item(MENU.refresh, "r.menuRefresh"), item(MENU.help, "r.menuHelp")],
    places: [item(MENU.board, "r.menuBoard"), item(MENU.help, "r.menuHelp")],
    plans: [item(MENU.goals, "r.menuGoals"), item(MENU.again, "r.menuSearchAgain"), item(MENU.board, "r.menuBoard"), item(MENU.help, "r.menuHelp")],
    voice: [item(MENU.saveVoice, "r.menuSaveVoice"), item(MENU.goals, "r.menuGoals"), item(MENU.help, "r.menuHelp")],
    help: [item(MENU.board, "r.menuClose")],
    guide: [item(MENU.next, "r.menuNext"), item(MENU.prev, "r.menuPrev"), item(MENU.stop, "r.menuStop"), item(MENU.help, "r.menuHelp")],
  };
  return { key: `${locale}:${screen}`, items: items[screen] };
}
