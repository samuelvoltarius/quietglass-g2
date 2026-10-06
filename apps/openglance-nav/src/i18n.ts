/**
 * Small Quietglass i18n pattern (as in rain-lens): the device language picks
 * the locale, a saved choice wins, English is the fallback for anything
 * missing. The G2 font renders ä ö ü ß, so German text uses real umlauts.
 */
export type Locale = "de" | "en";
export const locales: readonly Locale[] = ["de", "en"];
export const localeNames: Record<Locale, string> = { de: "Deutsch", en: "English" };
export type Messages = Record<Locale, Record<string, string>>;

const LOCALE_KEY = "quietglass.locale";

/**
 * Saved choice first, then the WebView's language, then English. Storage and
 * navigator are read defensively: either can be missing or throw in a WebView
 * with storage disabled, and the app must still start.
 */
export function getLocale(): Locale {
  try {
    const saved = globalThis.localStorage?.getItem(LOCALE_KEY);
    if (locales.includes(saved as Locale)) return saved as Locale;
  } catch { /* storage unavailable */ }
  const detected = (globalThis.navigator?.language ?? "").slice(0, 2).toLowerCase() as Locale;
  return locales.includes(detected) ? detected : "en";
}

export function setLocale(locale: Locale): void {
  try { globalThis.localStorage?.setItem(LOCALE_KEY, locale); } catch { /* storage unavailable */ }
}

export function tr(messages: Messages, locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  const source = messages[locale][key] ?? messages.en[key] ?? key;
  return Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), source);
}

export function languageSelect(locale: Locale): string {
  return `<label for="language">${locale === "de" ? "Sprache" : "Language"}</label><select id="language">${locales.map((item) => `<option value="${item}"${item === locale ? " selected" : ""}>${localeNames[item]}</option>`).join("")}</select>`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
