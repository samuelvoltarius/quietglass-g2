/** `provider` is the lower-cased name the bridge sent ("" when absent); price and P/L are null when the bridge sent nothing usable, so they render as a missing marker instead of a fake 0. */
export interface Position { readonly provider: string; readonly title: string; readonly outcome: string; readonly quantity: number; readonly currentValue: number; readonly pnl: number | null; readonly realizedPnl?: number; readonly price: number | null; }
export interface ProviderError { readonly provider: string; readonly message: string; }
export const MISSING = "–";
function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function maybe(value: unknown): number | null { if (value === null || value === undefined || value === "" || typeof value === "boolean") return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
export function providerName(value: unknown): string { return typeof value === "string" ? value.trim().toLowerCase() : ""; }
/** Glasses tag: K / P for the two supported providers, "?" for anything else — never silently relabelled as Polymarket. */
export function providerTag(provider: string): string { return provider === "kalshi" ? "K" : provider === "polymarket" ? "P" : "?"; }
export function parsePositions(value: unknown): Position[] { const rows = Array.isArray(value) ? value : (value as { positions?: unknown })?.positions; if (!Array.isArray(rows)) throw new Error("positions response must be an array"); return rows.flatMap((raw) => { const row = (raw ?? {}) as Record<string, unknown>; if (typeof row.title !== "string") return []; const realized = maybe(row.realizedPnl); return [{ provider: providerName(row.provider), title: row.title, outcome: typeof row.outcome === "string" ? row.outcome : "", quantity: number(row.quantity), currentValue: number(row.currentValue), pnl: maybe(row.pnl), price: maybe(row.price), ...(realized === null ? {} : { realizedPnl: realized }) }]; }); }
export function parseErrors(value: unknown): ProviderError[] { return Array.isArray(value) ? value.flatMap((raw) => { const row = (raw ?? {}) as Record<string, unknown>; return typeof row.message === "string" ? [{ provider: providerName(row.provider), message: row.message }] : []; }) : []; }
/** Milliseconds since epoch, or null for a missing/unparseable timestamp. */
export function parseTimestamp(value: unknown): number | null { if (typeof value !== "string") return null; const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
export function demoPositions(): Position[] { return [{ provider: "polymarket", title: "Demo: rainfall above average?", outcome: "YES", quantity: 25, currentValue: 16.25, pnl: 2.5, price: 0.65 }, { provider: "kalshi", title: "DEMO-TEMP-80", outcome: "YES", quantity: 10, currentValue: 5.4, pnl: -0.6, price: 0.54 }]; }
// Sign follows the rounded amount, so -0.004 prints "+$0.00" rather than a loss of "-$0.00".
export function money(value: number | null): string { if (value === null) return MISSING; const rounded = Math.round(value * 100) / 100; return `${rounded >= 0 ? "+" : "-"}$${Math.abs(rounded).toFixed(2)}`; }
/** Probability price (0..1) as whole cents. */
export function cents(price: number | null): string { return price === null ? MISSING : `${Math.round(price * 100)}c`; }
// Counts code points, not UTF-16 units, so an emoji is never cut in half; never returns more than `length` characters.
export function shorten(text: string, length = 44): string { const chars = Array.from(text); if (chars.length <= length) return text; if (length <= 3) return chars.slice(0, Math.max(0, length)).join(""); return `${chars.slice(0, length - 3).join("")}...`; }
/** Data older than this (three missed 15 s polls) is no longer shown as LIVE. */
export const STALE_AFTER_MS = 45000;
export function ageLabel(ms: number): string { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`; }
/** Age label ("3m") when the data must be shown as stale — too old, or the last refresh failed — otherwise null. A future timestamp (clock skew) counts as age 0. */
export function staleAge(updatedAt: number, now: number, failed: boolean, maxAgeMs = STALE_AFTER_MS): string | null { const age = Math.max(0, now - updatedAt); return failed || age > maxAgeMs ? ageLabel(age) : null; }
