export interface AgendaItem { readonly id: string; readonly at: string; readonly title: string; readonly kind: "event" | "reminder"; readonly done?: boolean; }
/** RFC 5545 folding is a line break plus one space or tab; pasted text and many exports use a bare LF. */
export function unfoldIcs(text: string): string[] { return text.replace(/\r?\n[ \t]/g, "").replace(/\r/g, "").split("\n"); }
/** RFC 5545 TEXT escapes; a newline becomes a space because a row on the glasses is a single line. */
export function unescapeIcsText(value: string): string { return value.replace(/\\([\\;,nN])/g, (_match, char: string) => char === "n" || char === "N" ? " " : char); }
/** Chronological, not lexical: "09:30+02:00" and "08:00Z" do not compare as strings. Unreadable times keep string order, after real ones. */
export function byTime(a: AgendaItem, b: AgendaItem): number { const left = Date.parse(a.at); const right = Date.parse(b.at); if (Number.isFinite(left) && Number.isFinite(right)) return left - right; if (Number.isFinite(left)) return -1; if (Number.isFinite(right)) return 1; return a.at.localeCompare(b.at); }
export function parseIcs(text: string): AgendaItem[] {
  const lines = unfoldIcs(text); const items: AgendaItem[] = []; let block: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { block = {}; continue; }
    if (line === "END:VEVENT") { if (block?.SUMMARY && block.DTSTART) items.push({ id: block.UID ?? `${block.DTSTART}-${block.SUMMARY}`, at: parseIcsDate(block.DTSTART), title: unescapeIcsText(block.SUMMARY), kind: "event" }); block = null; continue; }
    if (!block) continue; const split = line.indexOf(":"); if (split < 0) continue; const key = line.slice(0, split).split(";", 1)[0]; if (key) block[key] = line.slice(split + 1);
  }
  return items.sort(byTime);
}
/** Keeps a trailing Z: a UTC time read as local time would be off by the zone offset. */
export function parseIcsDate(value: string): string { const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z?))?/.exec(value); if (!match) return value; const [, y, m, d, hh = "00", mm = "00", ss = "00", utc = ""] = match; return `${y}-${m}-${d}T${hh}:${mm}:${ss}${utc}`; }
export function parseBridge(value: unknown): AgendaItem[] { if (!Array.isArray(value)) throw new Error("bridge response must be an array"); return value.flatMap((raw, index) => { const row = (raw ?? {}) as Partial<AgendaItem>; return typeof row.title === "string" && typeof row.at === "string" ? [{ id: typeof row.id === "string" ? row.id : `item-${index}`, at: row.at, title: row.title, kind: row.kind === "reminder" ? "reminder" as const : "event" as const, ...(row.done === true ? { done: true } : {}) }] : []; }).sort(byTime); }
export function demoAgenda(): AgendaItem[] { const base = new Date(); base.setMinutes(0, 0, 0); return [{ id: "1", at: new Date(base.getTime() + 45 * 60_000).toISOString(), title: "Team-Check-in", kind: "event" }, { id: "2", at: new Date(base.getTime() + 120 * 60_000).toISOString(), title: "Angebot senden", kind: "reminder" }, { id: "3", at: new Date(base.getTime() + 210 * 60_000).toISOString(), title: "Zahnarzt", kind: "event" }, { id: "4", at: new Date(base.getTime() + 300 * 60_000).toISOString(), title: "Milch mitnehmen", kind: "reminder" }]; }
export function when(iso: string, locale = "de-AT"): string { const date = new Date(iso); return Number.isNaN(date.valueOf()) ? "--:--" : date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }); }
/** Flips a reminder's done flag; events and other ids are untouched. */
export function toggleDone(items: readonly AgendaItem[], id: string): AgendaItem[] { return items.map((item) => item.id === id && item.kind === "reminder" ? { ...item, done: !item.done } : item); }
/** Fetches the bridge with a timeout so a hung local server cannot leave a request pending forever. */
export async function fetchBridge(endpoint: string, options: { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch } = {}): Promise<AgendaItem[]> {
  const doFetch = options.fetchImpl ?? fetch; const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try { const response = await doFetch(endpoint, { signal: controller.signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return parseBridge(await response.json()); }
  catch (cause) { if (controller.signal.aborted) throw new Error("timed out"); throw cause; }
  finally { clearTimeout(timeout); }
}
