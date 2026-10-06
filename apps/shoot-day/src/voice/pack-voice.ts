/**
 * Voice grammar for the packing list. Kept free of SDK imports so it can be
 * tested without glasses or simulator (tests/pack-voice.test.ts).
 *
 * The recogniser hears whole sentences — "the gimbal is packed", "Regenschutz
 * fehlt", "was fehlt noch?" — and this module turns them into one intent.
 * German and English are understood at the same time; nobody switches
 * language settings on set.
 */

/**
 * Short forms people actually say on set → a part of the item name. Only
 * generic gear words; nicknames for your own kit belong in the item names
 * themselves (e.g. "Gimbal (Ronin)").
 */
export const PACK_ALIAS: Readonly<Record<string, string>> = {
  "fx sechs": "fx6", "fx drei": "fx3", "ronin": "gimbal",
  // "Stativ" must find "Videostativ": item words only match when said whole.
  "stativ": "stativ", "tripod": "stativ",
  "funke": "funk", "wireless": "funk", "lavalier": "funk",
  "mikro": "mikrofon", "microphone": "mikrofon",
  "richtrohr": "richtmikrofon", "shotgun": "richtmikrofon", "angel": "richtmikrofon",
  "pol": "polfilter", "drone": "drohne",
  "platte": "ssd", "akkus": "akku", "batteries": "akku", "battery": "akku",
  "regen": "regenschutz", "rain cover": "regenschutz", "slate": "klappe",
  "clapper": "klappe", "headphones": "kopfhörer", "card reader": "kartenleser",
};

export const packNorm = (text: string): string =>
  text.toLowerCase().replace(/[.,!?()/;:"„“”]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Which item is meant? The one with the most matching characters wins.
 * Returns the index into `names`, or -1 when nothing matches well enough.
 */
export function matchPackItem(said: string, names: readonly string[]): number {
  const heard = packNorm(said);
  let best = -1;
  let bestScore = 0;
  names.forEach((raw, index) => {
    const name = packNorm(raw);
    let score = 0;
    for (const word of name.split(" ").filter((w) => w.length >= 3)) if (heard.includes(word)) score += word.length;
    for (const [spoken, part] of Object.entries(PACK_ALIAS)) if (heard.includes(spoken) && name.includes(part)) score += 6;
    if (score > bestScore) { bestScore = score; best = index; }
  });
  return bestScore >= 3 ? best : -1;
}

export type PackCommand =
  | { readonly kind: "missing" }                                 // "was fehlt noch?" / "what's missing?"
  | { readonly kind: "all"; readonly packed: boolean }           // "alles eingepackt" / "everything packed"
  | { readonly kind: "item"; readonly index: number; readonly packed: boolean }
  | { readonly kind: "unknown" };

const ASKS_MISSING = /was fehlt|noch offen|noch nicht|\brest\b|fehlt noch|was brauche|what'?s missing|what is missing|still missing|what'?s left|what is left/;
// "fehlt" alone is a negation ("Regenschutz fehlt"), unless the rest is asked for (above).
const NEGATES = /\bfehlt\b|\braus\b|\bnicht\b|\bweg\b|\bnein\b|vergessen|\bnot\b|\bmissing\b|\bforgot|\bunpack|\bremove|\bno\b/;
const EVERYTHING = /\balles\b|\ballem\b|komplett|\bfertig\b|\beverything\b|\ball\b/;

/** Sentence → intent. `names` are the items needed for this shoot. */
export function parsePackCommand(text: string, names: readonly string[]): PackCommand {
  const heard = packNorm(text);
  if (!heard) return { kind: "unknown" };
  if (ASKS_MISSING.test(heard)) return { kind: "missing" };
  const off = NEGATES.test(heard);
  if (EVERYTHING.test(heard)) return { kind: "all", packed: !off };
  const index = matchPackItem(heard, names);
  if (index < 0) return { kind: "unknown" };
  return { kind: "item", index, packed: !off };
}
