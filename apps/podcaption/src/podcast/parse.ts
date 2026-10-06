export interface Transcript { readonly url: string; readonly type: string; readonly rel?: string; }
/** transcriptUrl/transcriptType name the preferred file; `transcripts` lists every offered one, best first, as fallbacks. */
export interface Episode { readonly title: string; readonly transcriptUrl: string; readonly transcriptType: string; readonly transcripts: readonly Transcript[]; }
export interface Caption { readonly start: number; readonly end: number; readonly text: string; }
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
/** One pass, so "&amp;lt;" stays "&lt;"; numeric references cover feeds that write "Don&#8217;t". */
function entity(match: string, name: string): string {
  if (name[0] !== "#") return NAMED[name.toLowerCase()] ?? match;
  const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
}
function decode(text: string): string { return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, entity).trim(); }
/**
 * Lower is better. The Podcasting 2.0 docs call WebVTT the preferred format and HTML "low-fidelity"; SRT and JSON are
 * also time-coded, and rel="captions" promises time codes whatever the MIME type. Plain text has no timing at all.
 */
export function transcriptRank(transcript: Pick<Transcript, "type" | "rel">): number {
  const mime = transcript.type.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (mime === "text/vtt") return 0; if (/\/(x-)?(subrip|srt)$/.test(mime)) return 1; if (mime.includes("json")) return 2;
  if (transcript.rel?.toLowerCase() === "captions") return 3; return mime.includes("html") ? 4 : mime === "text/plain" ? 5 : 6;
}
const attribute = (tag: string, name: string): string | undefined => { const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, "i").exec(tag); return match ? match[1] ?? match[2] : undefined; };
export function parsePodcastFeed(xml: string): Episode[] {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  return items.flatMap((item) => {
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(item)?.[1];
    // Every transcript the item offers, best first (Array#sort is stable, so feed order breaks ties).
    const transcripts = [...item.matchAll(/<podcast:transcript\b([^>]*?)\/?>/gi)].flatMap((match): Transcript[] => { const tag = match[1] ?? ""; const url = attribute(tag, "url"); const rel = attribute(tag, "rel"); return url ? [{ url: decode(url), type: decode(attribute(tag, "type") ?? "") || "text/plain", ...(rel ? { rel: decode(rel) } : {}) }] : []; }).sort((a, b) => transcriptRank(a) - transcriptRank(b));
    const best = transcripts[0];
    return title && best ? [{ title: decode(title), transcriptUrl: best.url, transcriptType: best.type, transcripts }] : [];
  });
}
/** Splits untimed text into caption-sized pieces, preferring sentence ends, so a whole episode is not one unscrollable caption. */
export function chunkText(text: string, max = 92): string[] {
  const chunks: string[] = []; let current = "";
  const push = (piece: string): void => { if (!current) current = piece; else if (current.length + 1 + piece.length <= max) current += ` ${piece}`; else { chunks.push(current); current = piece; } };
  for (const sentence of text.replace(/\s+/g, " ").trim().split(/(?<=[.!?…])\s+/)) {
    if (!sentence) continue;
    if (sentence.length <= max) { push(sentence); continue; }
    for (const word of sentence.split(" ")) for (let index = 0; index < word.length; index += max) push(word.slice(index, index + max));
  }
  if (current) chunks.push(current);
  return chunks;
}
const untimed = (text: string): Caption[] => chunkText(text).map((piece) => ({ start: 0, end: 0, text: piece }));
const time = (value: unknown, fallback: number): number => { const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN; return Number.isFinite(number) && number >= 0 ? number : fallback; };
export function parseTranscript(text: string, mime = "text/vtt"): Caption[] {
  if (mime.includes("json")) {
    const value = JSON.parse(text) as { segments?: Array<{ startTime?: unknown; endTime?: unknown; body?: unknown }> } | null;
    const segments = Array.isArray(value?.segments) ? value.segments : [];
    return segments.flatMap((segment) => { if (typeof segment?.body !== "string" || !segment.body.trim()) return []; const start = time(segment.startTime, 0); return [{ start, end: time(segment.endTime, start), text: segment.body.trim() }]; });
  }
  if (mime.includes("html")) return untimed(decode(text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")));
  const blocks = text.replace(/^﻿?WEBVTT[^\n]*\n/i, "").trim().split(/\n\s*\n/); const captions: Caption[] = [];
  for (const block of blocks) { const lines = block.split(/\r?\n/).filter(Boolean); const timingIndex = lines.findIndex((line) => line.includes("-->")); if (timingIndex < 0) continue; const [from = "0", to = "0"] = (lines[timingIndex] ?? "").split("-->").map((part) => part.trim().split(" ")[0] ?? "0"); const body = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim(); if (body) captions.push({ start: seconds(from), end: seconds(to), text: decode(body) }); }
  return captions.length > 0 ? captions : untimed(text.replace(/^﻿/, ""));
}
/** parseTranscript that fails loudly, so an unreadable or empty file reaches the user instead of the console. */
export function readTranscript(text: string, mime: string): Caption[] { let captions: Caption[]; try { captions = parseTranscript(text, mime); } catch (cause) { throw new Error(`unreadable transcript (${cause instanceof Error ? cause.message : String(cause)})`); } if (!captions.length) throw new Error("transcript is empty"); return captions; }
function seconds(value: string): number { const parts = value.replace(",", ".").split(":").map(Number); if (parts.some((part) => !Number.isFinite(part))) return 0; return parts.reduce((total, part) => total * 60 + part, 0); }
/** The first-run captions: by default the original German sample, or the localized how-to the app passes in. */
export function demoCaptions(lines: readonly string[] = [
  "Willkommen bei PodCaption.",
  "Podcast-Untertitel erscheinen direkt im Blickfeld.",
  "Der offene RSS-Feed liefert das vorhandene Transkript.",
  "Kein Spotify-Audiomitschnitt und kein verstecktes Dauerlauschen.",
]): Caption[] { return lines.map((text, index) => ({ start: index * 5, end: index * 5 + 5, text })); }
