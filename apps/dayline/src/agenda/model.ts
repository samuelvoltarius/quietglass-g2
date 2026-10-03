export interface AgendaItem { readonly id: string; readonly at: string; readonly title: string; readonly kind: "event" | "reminder"; readonly done?: boolean; }
export function unfoldIcs(text: string): string[] { return text.replace(/\r\n[ \t]/g, "").replace(/\r/g, "").split("\n"); }
export function parseIcs(text: string): AgendaItem[] {
  const lines = unfoldIcs(text); const items: AgendaItem[] = []; let block: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { block = {}; continue; }
    if (line === "END:VEVENT") { if (block?.SUMMARY && block.DTSTART) items.push({ id: block.UID ?? `${block.DTSTART}-${block.SUMMARY}`, at: parseIcsDate(block.DTSTART), title: block.SUMMARY.replace(/\\,/g, ","), kind: "event" }); block = null; continue; }
    if (!block) continue; const split = line.indexOf(":"); if (split < 0) continue; const key = line.slice(0, split).split(";", 1)[0]; if (key) block[key] = line.slice(split + 1);
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}
export function parseIcsDate(value: string): string { const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?/.exec(value); if (!match) return value; const [, y, m, d, hh = "00", mm = "00", ss = "00"] = match; return `${y}-${m}-${d}T${hh}:${mm}:${ss}`; }
export function parseBridge(value: unknown): AgendaItem[] { if (!Array.isArray(value)) throw new Error("bridge response must be an array"); return value.flatMap((raw, index) => { const row = raw as Partial<AgendaItem>; return typeof row.title === "string" && typeof row.at === "string" ? [{ id: typeof row.id === "string" ? row.id : `item-${index}`, at: row.at, title: row.title, kind: row.kind === "reminder" ? "reminder" as const : "event" as const, ...(row.done === true ? { done: true } : {}) }] : []; }).sort((a, b) => a.at.localeCompare(b.at)); }
export function demoAgenda(): AgendaItem[] { const base = new Date(); base.setMinutes(0, 0, 0); return [{ id: "1", at: new Date(base.getTime() + 45 * 60_000).toISOString(), title: "Team-Check-in", kind: "event" }, { id: "2", at: new Date(base.getTime() + 120 * 60_000).toISOString(), title: "Angebot senden", kind: "reminder" }, { id: "3", at: new Date(base.getTime() + 210 * 60_000).toISOString(), title: "Zahnarzt", kind: "event" }, { id: "4", at: new Date(base.getTime() + 300 * 60_000).toISOString(), title: "Milch mitnehmen", kind: "reminder" }]; }
export function when(iso: string, locale = "de-AT"): string { const date = new Date(iso); return Number.isNaN(date.valueOf()) ? "--:--" : date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }); }
