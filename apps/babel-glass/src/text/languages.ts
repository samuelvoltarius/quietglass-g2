/**
 * Languages offered in the phone UI, and the small amount of logic that turns
 * a stored setting plus a recogniser's detection into the code a translator
 * gets.
 *
 * Codes are ISO 639-1 (BCP-47 primary subtags), which is what Whisper reports
 * and what LibreTranslate expects. Anything not in the list can still be used
 * through the "custom code" escape hatch.
 */

export interface LanguageOption {
  readonly code: string;
  /** English name, also used in the translation prompt sent to an LLM. */
  readonly name: string;
  /** Endonym, shown next to the English name so the list reads for both. */
  readonly native: string;
}

/** Ordered for the primary use case first: Russian / Belarusian → German. */
export const LANGUAGES: readonly LanguageOption[] = [
  { code: "ru", name: "Russian", native: "Русский" },
  { code: "be", name: "Belarusian", native: "Беларуская" },
  { code: "uk", name: "Ukrainian", native: "Українська" },
  { code: "de", name: "German", native: "Deutsch" },
  { code: "en", name: "English", native: "English" },
  { code: "pl", name: "Polish", native: "Polski" },
  { code: "cs", name: "Czech", native: "Čeština" },
  { code: "fr", name: "French", native: "Français" },
  { code: "es", name: "Spanish", native: "Español" },
  { code: "it", name: "Italian", native: "Italiano" },
  { code: "pt", name: "Portuguese", native: "Português" },
  { code: "nl", name: "Dutch", native: "Nederlands" },
  { code: "tr", name: "Turkish", native: "Türkçe" },
  { code: "ar", name: "Arabic", native: "العربية" },
  { code: "zh", name: "Chinese", native: "中文" },
  { code: "ja", name: "Japanese", native: "日本語" },
];

export const AUTO = "auto";
/** Select value meaning "use the free-text field next to the select". */
export const CUSTOM = "custom";

const CODE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

/**
 * Normalises a language code, typically one typed into the free-text field of
 * earlier versions: trims, lowercases, accepts `_` for `-`. Returns null for
 * anything that is not shaped like a language tag ("Russian", "", "de de").
 */
export function normalizeLanguageCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toLowerCase().replace(/_/g, "-");
  if (code === AUTO) return AUTO;
  return CODE_PATTERN.test(code) ? code : null;
}

/** The primary subtag: "de-AT" → "de". */
export function primaryCode(code: string): string {
  return code.split("-")[0] ?? code;
}

export function findLanguage(code: string): LanguageOption | undefined {
  const primary = primaryCode(code.toLowerCase());
  return LANGUAGES.find((l) => l.code === primary);
}

/** English name for a prompt; falls back to the code itself. */
export function languageName(code: string): string {
  return findLanguage(code)?.name ?? code;
}

/**
 * Which option a select should show for a stored code. Only an exact match
 * selects a listed language — "de-at" is kept as a custom code so it is not
 * silently shortened.
 */
export function selectValueFor(code: string, allowAuto: boolean): string {
  if (code === AUTO) return allowAuto ? AUTO : CUSTOM;
  return LANGUAGES.some((l) => l.code === code) ? code : CUSTOM;
}

/**
 * Reads a language choice back from the select + custom field. An invalid or
 * empty custom code falls back rather than storing rubbish.
 */
export function readLanguageChoice(
  selectValue: string,
  customValue: string,
  fallback: string,
  allowAuto: boolean,
): string {
  if (selectValue === CUSTOM) {
    const custom = normalizeLanguageCode(customValue);
    if (custom === null || (custom === AUTO && !allowAuto)) return fallback;
    return custom;
  }
  const code = normalizeLanguageCode(selectValue);
  if (code === null || (code === AUTO && !allowAuto)) return fallback;
  return code;
}

/**
 * The source language to hand to a translator for one caption.
 *
 * A fixed setting always wins. With "auto", the recogniser's detection is the
 * best information available — it is used when the provider needs a concrete
 * code (an LLM prompt, NLLB), while LibreTranslate keeps receiving "auto" so
 * its behaviour is unchanged.
 */
export function resolveSourceLanguage(
  configured: string,
  detected: string | undefined,
  needsConcrete: boolean,
): string {
  if (configured !== AUTO) return configured;
  if (!needsConcrete) return AUTO;
  const code = detected ? normalizeLanguageCode(detected) : null;
  return code && code !== AUTO ? primaryCode(code) : AUTO;
}

/** True when the caption is already in the target language. */
export function sameLanguage(source: string, target: string): boolean {
  return source !== AUTO && primaryCode(source) === primaryCode(target);
}
