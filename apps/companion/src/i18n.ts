export type Locale = "de" | "en" | "fr" | "es" | "it";
export const locales: readonly Locale[] = ["de", "en", "fr", "es", "it"];
export const localeNames: Record<Locale, string> = { de: "Deutsch", en: "English", fr: "Français", es: "Español", it: "Italiano" };
export type Messages = Record<Locale, Record<string, string>>;
export function getLocale(): Locale { const saved = localStorage.getItem("quietglass.locale"); if (locales.includes(saved as Locale)) return saved as Locale; const detected = navigator.language.slice(0, 2) as Locale; return locales.includes(detected) ? detected : "en"; }
export function setLocale(locale: Locale): void { localStorage.setItem("quietglass.locale", locale); }
export function tr(messages: Messages, locale: Locale, key: string, vars: Record<string, string | number> = {}): string { const source = messages[locale][key] ?? messages.en[key] ?? key; return Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), source); }
export function languageSelect(locale: Locale): string { return `<label>${locale === "de" ? "Sprache" : locale === "fr" ? "Langue" : locale === "es" ? "Idioma" : locale === "it" ? "Lingua" : "Language"}<select id="language">${locales.map((item) => `<option value="${item}"${item === locale ? " selected" : ""}>${localeNames[item]}</option>`).join("")}</select></label>`; }
export function escapeHtml(text: string): string { return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c); }
