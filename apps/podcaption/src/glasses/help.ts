import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import { footer, ROW_WIDTH } from "./footer";
import type { TextView } from "./text";

/** What a tap does at the moment: pause while playing, start otherwise. */
export function actionWords(locale: Locale, playing: boolean): { tap: string; swipe: string; hold: string } {
  const t = (key: string): string => tr(messages, locale, key);
  return { tap: t(playing ? "actPause" : "actPlay"), swipe: t("actScroll"), hold: t("actHelp") };
}

/** The footer of the caption page (QIS v1): Tippen -> Wischen -> Halten -> 2x = Ende. */
export function captionFooter(locale: Locale, playing: boolean): string {
  return footer(locale, actionWords(locale, playing), "exit");
}

/** The help page: the four gestures in footer order, then what the app needs. */
export function helpView(locale: Locale): TextView {
  const t = (key: string): string => tr(messages, locale, key);
  const header = `PODCAPTION · ${t("helpTitle")}`;
  return { header: header.slice(0, ROW_WIDTH), body: ["", t("h1"), t("h2"), t("h3"), t("h4"), t("h5")], footer: footer(locale, { tap: t("actClose") }, "back") };
}
