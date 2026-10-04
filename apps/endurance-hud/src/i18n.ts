export type Locale = "de" | "en" | "fr" | "es" | "it";
export const locales: readonly Locale[] = ["de", "en", "fr", "es", "it"];
const names: Record<Locale, string> = { de: "Deutsch", en: "English", fr: "Français", es: "Español", it: "Italiano" };
export function getLocale(): Locale { const saved = localStorage.getItem("quietglass.locale"); if (locales.includes(saved as Locale)) return saved as Locale; const detected = navigator.language.slice(0, 2) as Locale; return locales.includes(detected) ? detected : "en"; }
export function setLocale(locale: Locale): void { localStorage.setItem("quietglass.locale", locale); }
export function languageSelect(locale: Locale): string { return `<label>Language / Sprache<select id="language">${locales.map((item) => `<option value="${item}"${item === locale ? " selected" : ""}>${names[item]}</option>`).join("")}</select></label>`; }
