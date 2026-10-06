/**
 * German and English, following the phone language; English is the fallback.
 * Same small API as the other Quietglass apps (see rain-lens), trimmed to the
 * two languages this app ships. Every storage and navigator access is guarded:
 * a WebView with storage disabled must still start in a readable language.
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
  } catch { /* storage blocked: fall through to the device language */ }
  try {
    const detected = (globalThis.navigator?.language ?? "").slice(0, 2).toLowerCase() as Locale;
    if (locales.includes(detected)) return detected;
  } catch { /* no navigator */ }
  return "en";
}

export function setLocale(locale: Locale): void {
  try { globalThis.localStorage?.setItem(KEY, locale); } catch { /* not persisted; still applied for this session */ }
}

export function tr(messages: Messages, locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  const source = messages[locale][key] ?? messages.en[key] ?? key;
  return Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), source);
}

export function languageSelect(locale: Locale): string {
  return `<label>${locale === "de" ? "Sprache" : "Language"}<select id="language">${locales.map((item) => `<option value="${item}"${item === locale ? " selected" : ""}>${localeNames[item]}</option>`).join("")}</select></label>`;
}
