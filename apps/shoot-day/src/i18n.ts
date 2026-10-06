/**
 * The small Quietglass i18n pattern (same shape as RainLens): German and
 * English, following the device language, English as the fallback, and a
 * language picker on the phone page.
 *
 * Storage access is guarded: in a preview, a private window or a test run
 * `localStorage` may be missing or throw, and that must never break the app.
 */

export type Locale = "de" | "en";
export const locales: readonly Locale[] = ["de", "en"];
export const localeNames: Record<Locale, string> = { de: "Deutsch", en: "English" };
export type Messages = Record<Locale, Record<string, string>>;

const KEY = "quietglass.locale";

export function getLocale(): Locale {
  try {
    const saved = globalThis.localStorage?.getItem(KEY);
    if (locales.includes(saved as Locale)) return saved as Locale;
  } catch {
    // No storage: fall through to the device language.
  }
  const detected = (globalThis.navigator?.language ?? "").slice(0, 2).toLowerCase() as Locale;
  return locales.includes(detected) ? detected : "en";
}

export function setLocale(locale: Locale): void {
  try {
    globalThis.localStorage?.setItem(KEY, locale);
  } catch {
    // Not remembered across launches, but the switch still applies now.
  }
}

/** `{name}` placeholders are replaced everywhere they occur. */
export function tr(messages: Messages, locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  const source = messages[locale][key] ?? messages.en[key] ?? key;
  return Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), source);
}

export function languageSelect(locale: Locale): string {
  return `<label for="language">${locale === "de" ? "Sprache" : "Language"}</label><select id="language">${locales.map((item) => `<option value="${item}"${item === locale ? " selected" : ""}>${localeNames[item]}</option>`).join("")}</select>`;
}
