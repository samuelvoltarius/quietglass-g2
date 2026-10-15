/**
 * "Neuer Kunde Anna Beispiel" → "Anna Beispiel". Pure, no SDK imports.
 *
 * The recogniser hears whole sentences; people often repeat the command
 * ("neuer Kunde …", "new customer …", "Kunde heißt …") before the name, and
 * Whisper adds a full stop. Both go; the rest is the name as spoken, with the
 * first letter of each word capitalised when it came back all lower case.
 */

const LEAD = [
  /^(?:bitte\s+)?(?:einen?\s+)?neue[nr]?\s+kunden?\s*(?:anlegen\s*)?(?:namens|mit\s+(?:dem\s+)?namen|heißt|heisst|:)?\s*/i,
  /^(?:der\s+|die\s+)?kunden?(?:name)?\s*(?:ist|heißt|heisst|:)\s*/i,
  /^(?:please\s+)?(?:add\s+|create\s+)?(?:a\s+)?new\s+(?:customer|client)\s*(?:called|named|:)?\s*/i,
  /^(?:the\s+)?(?:customer|client)(?:'s)?\s*(?:name\s+)?(?:is|:)\s*/i,
];
const TAIL = /\s*(?:anlegen|bitte|please|danke|thanks)\s*$/i;

/** The customer's name in a spoken sentence; "" when nothing usable is left. */
export function parseCustomerName(heard: string): string {
  let text = heard.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  for (const lead of LEAD) text = text.replace(lead, "");
  text = text.replace(/[.!?。,;:]+$/g, "").replace(TAIL, "").replace(/^["„“”'«»]+|["„“”'«»]+$/g, "").trim();
  if (!/\p{L}/u.test(text)) return "";
  if (text === text.toLowerCase()) text = text.replace(/(^|[\s-])(\p{L})/gu, (_m, gap: string, first: string) => gap + first.toUpperCase());
  return text.slice(0, 120);
}

/** Same customer? Case, accents and spacing do not count. */
export function sameCustomerName(a: string, b: string): boolean {
  const norm = (value: string): string => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}
