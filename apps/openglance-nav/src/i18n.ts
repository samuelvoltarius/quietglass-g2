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

/** The narrow part of the Even bridge the language needs (fakeable in tests). */
export interface LocaleBridge {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
  getUserInfo?(): Promise<{ readonly country?: string | undefined } | null | undefined>;
}

/** Country codes or names of the Even account that mean "start in German". */
const GERMAN_SPEAKING = /^(at|de|ch|li|lu|aut|deu|che|lie|lux|austria|germany|switzerland|liechtenstein|österreich|oesterreich|deutschland|schweiz)$/i;

/**
 * The language to start with inside the Even app. Its WebView reports English
 * even on a German phone, and its window.localStorage may not survive a
 * relaunch. So: an explicit choice is kept in the SDK store first; without
 * one, a German-speaking country on the Even account means German; only then
 * the browser language.
 */
export async function resolveLocale(bridge: LocaleBridge): Promise<Locale> {
  try {
    const forced = new URLSearchParams(globalThis.location?.search ?? "").get("lang")
      ?? new URLSearchParams(globalThis.location?.hash?.replace(/^#/, "") ?? "").get("lang");
    if (locales.includes(forced as Locale)) return forced as Locale;
  } catch { /* no location in tests */ }
  try {
    const saved = await bridge.getLocalStorage(LOCALE_KEY);
    if (locales.includes(saved as Locale)) return saved as Locale;
  } catch {
    // SDK store unavailable: fall through.
  }
  try {
    const saved = globalThis.localStorage?.getItem(LOCALE_KEY);
    if (locales.includes(saved as Locale)) return saved as Locale;
  } catch {
    // No web storage either.
  }
  try {
    const country = String((await bridge.getUserInfo?.())?.country ?? "").trim();
    if (GERMAN_SPEAKING.test(country)) return "de";
  } catch {
    // No account info: the device language decides.
  }
  return getLocale();
}

/** Keeps an explicit language choice where it survives relaunches. */
export function rememberLocale(bridge: LocaleBridge, locale: Locale): void {
  setLocale(locale);
  try {
    void Promise.resolve(bridge.setLocalStorage(LOCALE_KEY, locale)).catch(() => false);
  } catch {
    // SDK store unavailable: the switch still applies now.
  }
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
