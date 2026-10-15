/**
 * Reads one string field out of a JSON object that is still being written,
 * e.g. `{"kurz":"Termin Dienst` → "Termin Dienst" (not complete yet).
 *
 * Only for showing a growing answer; the finished answer is parsed properly.
 * Escapes are decoded; a half-received escape at the end is held back.
 */
export interface PartialString {
  readonly value: string;
  /** The closing quote has arrived. */
  readonly complete: boolean;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
};

export function partialJsonString(text: string, key: string): PartialString | null {
  const pattern = new RegExp("\"" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\"\\s*:\\s*\"");
  const match = pattern.exec(text);
  if (!match) return null;
  let value = "";
  let i = match.index + match[0].length;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "\"") return { value, complete: true };
    if (ch !== "\\") { value += ch; i++; continue; }
    const next = text[i + 1];
    if (next === undefined) break;
    if (next === "u") {
      const hex = text.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      if (/^[0-9a-f]{4}$/i.test(hex)) value += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    value += SIMPLE_ESCAPES[next] ?? next;
    i += 2;
  }
  return { value, complete: false };
}
