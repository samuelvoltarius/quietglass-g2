import type { Locale } from "../i18n";
import { t } from "../messages";
import { footer } from "./footer";
import type { StatusView } from "./view";

/** The help page (menu entry "Hilfe"): the gestures in the order of the footer, then what the app needs. */
export function buildHelpView(locale: Locale): StatusView {
  return {
    header: t(locale, "g.helpHead"),
    body: [1, 2, 3, 4, 5, 6].map((n) => t(locale, "g.help" + n)),
    footer: footer(locale, {}, "back"),
  };
}
