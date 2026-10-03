export interface Episode { readonly title: string; readonly transcriptUrl: string; readonly transcriptType: string; }
export interface Caption { readonly start: number; readonly end: number; readonly text: string; }
function decode(text: string): string { return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").trim(); }
export function parsePodcastFeed(xml: string): Episode[] {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  return items.flatMap((item) => {
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(item)?.[1];
    const transcript = /<podcast:transcript\b([^>]*)\/?>(?:<\/podcast:transcript>)?/i.exec(item)?.[1];
    const url = transcript ? /\burl=["']([^"']+)["']/i.exec(transcript)?.[1] : undefined;
    const type = transcript ? /\btype=["']([^"']+)["']/i.exec(transcript)?.[1] : undefined;
    return title && url ? [{ title: decode(title), transcriptUrl: decode(url), transcriptType: type ?? "text/plain" }] : [];
  });
}
export function parseTranscript(text: string, mime = "text/vtt"): Caption[] {
  if (mime.includes("json")) {
    const value = JSON.parse(text) as { segments?: Array<{ startTime?: number; endTime?: number; body?: string }> };
    return (value.segments ?? []).flatMap((segment) => typeof segment.body === "string" ? [{ start: Number(segment.startTime ?? 0), end: Number(segment.endTime ?? segment.startTime ?? 0), text: segment.body.trim() }] : []);
  }
  if (mime.includes("html")) return [{ start: 0, end: 0, text: decode(text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")) }];
  const blocks = text.replace(/^WEBVTT[^\n]*\n/i, "").trim().split(/\n\s*\n/); const captions: Caption[] = [];
  for (const block of blocks) { const lines = block.split(/\r?\n/).filter(Boolean); const timingIndex = lines.findIndex((line) => line.includes("-->")); if (timingIndex < 0) continue; const [from = "0", to = "0"] = (lines[timingIndex] ?? "").split("-->").map((part) => part.trim().split(" ")[0] ?? "0"); const body = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim(); if (body) captions.push({ start: seconds(from), end: seconds(to), text: decode(body) }); }
  return captions.length > 0 ? captions : [{ start: 0, end: 0, text: text.trim() }];
}
function seconds(value: string): number { const parts = value.replace(",", ".").split(":").map(Number); if (parts.some((part) => !Number.isFinite(part))) return 0; return parts.reduce((total, part) => total * 60 + part, 0); }
export function demoCaptions(): Caption[] { return [
  { start: 0, end: 4, text: "Willkommen bei PodCaption." },
  { start: 4, end: 9, text: "Podcast-Untertitel erscheinen direkt im Blickfeld." },
  { start: 9, end: 14, text: "Der offene RSS-Feed liefert das vorhandene Transkript." },
  { start: 14, end: 20, text: "Kein Spotify-Audiomitschnitt und kein verstecktes Dauerlauschen." },
]; }
