/**
 * Latin transliteration of Russian, Belarusian and Ukrainian, for showing the
 * original caption on the glasses when the display font may lack Cyrillic.
 *
 * Output is plain ASCII on purpose: if the font cannot draw Cyrillic it is
 * not safe to assume it can draw š, ž or ŭ either. The tables are modelled
 * on BGN/PCGN romanisation with the diacritics dropped and without its
 * position-dependent rules (one letter, one spelling), which keeps them
 * predictable and reads naturally for English and German readers:
 *
 *   Russian     щ → shch, ё → yo, й → y, ы → y, э → e, ю → yu, я → ya,
 *               ь → ' , ъ → "
 *   Belarusian  г → h, ў → u, і → i, ' (apostrophe) → ", otherwise as Russian
 *   Ukrainian   г → h, ґ → g, и → y, і → i, ї → yi, є → ye, ' → "
 *
 * Letters a table does not cover pass through unchanged, so mixed text never
 * loses characters.
 */

type Table = Readonly<Record<string, string>>;

const RUSSIAN: Table = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ъ: "\"", ы: "y", ь: "'", э: "e", ю: "yu", я: "ya",
};

const BELARUSIAN: Table = {
  ...RUSSIAN,
  г: "h", ґ: "g", і: "i", ў: "u",
};

const UKRAINIAN: Table = {
  ...RUSSIAN,
  г: "h", ґ: "g", и: "y", і: "i", ї: "yi", є: "ye", й: "y",
};

/** Apostrophe forms used in Belarusian and Ukrainian orthography. */
const APOSTROPHES = new Set(["'", "’", "ʼ"]);

export type CyrillicLanguage = "ru" | "be" | "uk";

const CYRILLIC = /[Ѐ-ӿ]/;

export function hasCyrillic(text: string): boolean {
  return CYRILLIC.test(text);
}

/**
 * Guesses which Cyrillic orthography a text uses, for when the recogniser
 * gave no usable language. Letters unique to one alphabet decide:
 * ў only exists in Belarusian; ї, є and ґ only in Ukrainian; і without и is
 * Belarusian (it has no и), і with и is Ukrainian. Everything else is read as
 * Russian.
 */
export function guessCyrillicLanguage(text: string): CyrillicLanguage {
  const lower = text.toLowerCase();
  if (lower.includes("ў")) return "be";
  if (/[їєґ]/.test(lower)) return "uk";
  if (lower.includes("і")) return lower.includes("и") ? "uk" : "be";
  return "ru";
}

function tableFor(language: string | undefined, text: string): Table {
  const code = (language ?? "").toLowerCase().split("-")[0];
  const resolved = code === "ru" || code === "be" || code === "uk"
    ? code
    : guessCyrillicLanguage(text);
  if (resolved === "be") return BELARUSIAN;
  if (resolved === "uk") return UKRAINIAN;
  return RUSSIAN;
}

/**
 * Transliterates `text`. `language` picks the table ("ru", "be", "uk");
 * anything else, including "auto" or undefined, guesses from the letters.
 * Non-Cyrillic text is returned untouched.
 */
export function transliterate(text: string, language?: string): string {
  if (!hasCyrillic(text)) return text;
  const table = tableFor(language, text);
  const chars = Array.from(text.normalize("NFC"));
  let out = "";

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? "";
    const prev = chars[i - 1];
    const next = chars[i + 1];

    // The Belarusian/Ukrainian apostrophe is a letter-level separator (like
    // the Russian hard sign); elsewhere it is ordinary punctuation.
    if (APOSTROPHES.has(ch) && table !== RUSSIAN && isCyrillicLetter(prev) && isCyrillicLetter(next)) {
      out += "\"";
      continue;
    }

    const lower = ch.toLowerCase();
    const mapped = table[lower];
    if (mapped === undefined) { out += ch; continue; }
    if (ch === lower) { out += mapped; continue; }

    // Upper case: SHCH inside an all-caps word, Shch otherwise.
    const neighbourUpper = isUpperLetter(next) || (!isLetter(next) && isUpperLetter(prev));
    out += neighbourUpper ? mapped.toUpperCase() : capitalise(mapped);
  }
  return out;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && /\p{L}/u.test(ch);
}

function isUpperLetter(ch: string | undefined): boolean {
  return isLetter(ch) && ch !== undefined && ch === ch.toUpperCase() && ch !== ch.toLowerCase();
}

function isCyrillicLetter(ch: string | undefined): boolean {
  return ch !== undefined && CYRILLIC.test(ch) && isLetter(ch);
}
