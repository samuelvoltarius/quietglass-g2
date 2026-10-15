import type { Locale } from "../i18n";
import type { Result } from "./llm";

/**
 * Babel Glass's own memory (0.4.0): past conversations (date, title, summary,
 * agreements) and notes typed on the phone, kept by the babel-llm-proxy on the
 * user's own server (`/memory`). Nothing else is read or written — in
 * particular no other knowledge store of the user.
 *
 * An older proxy (or a plain LLM server) does not know `/memory`: every call
 * then answers `{ ok: false, error: "unavailable" }`, never throws.
 */

export type MemoryType = "session" | "note";

export interface MemoryEntry {
  readonly id: string;
  /** ISO date-time of the conversation or note. */
  readonly date: string;
  readonly type: MemoryType;
  readonly title: string;
  readonly summary: string;
  /** Abmachungen / agreements, one per item. */
  readonly agreements: readonly string[];
  /** Search score (only on search results). */
  readonly score?: number;
}

export interface NewMemory {
  readonly type: MemoryType;
  readonly date?: string;
  readonly title: string;
  readonly summary: string;
  readonly agreements?: readonly string[];
}

export interface MemoryClient {
  list(limit?: number): Promise<Result<MemoryEntry[]>>;
  add(entry: NewMemory): Promise<Result<MemoryEntry>>;
  remove(id: string): Promise<Result<true>>;
  clear(): Promise<Result<true>>;
  search(query: string, limit?: number): Promise<Result<MemoryEntry[]>>;
}

export interface MemoryClientConfig {
  /** The language-model URL from the settings (…/v1); the proxy answers `/memory` next to it. */
  readonly url: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export const MEMORY_UNAVAILABLE = "unavailable";

/** `https://host:8448/v1` → `https://host:8448/memory`. */
export function memoryUrl(llmUrl: string): string {
  const base = llmUrl.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/v1$/, "");
  return base + "/memory";
}

function readEntry(value: unknown): MemoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v["id"] !== "string" || !v["id"]) return null;
  const agreements = Array.isArray(v["agreements"])
    ? (v["agreements"] as unknown[]).filter((a): a is string => typeof a === "string" && a.trim() !== "")
    : [];
  return {
    id: v["id"],
    date: typeof v["date"] === "string" ? v["date"] : "",
    type: v["type"] === "note" ? "note" : "session",
    title: typeof v["title"] === "string" ? v["title"] : "",
    summary: typeof v["summary"] === "string" ? v["summary"] : "",
    agreements,
    ...(typeof v["score"] === "number" ? { score: v["score"] } : {}),
  };
}

function readEntries(value: unknown): MemoryEntry[] | null {
  const list = value && typeof value === "object" && Array.isArray((value as { entries?: unknown }).entries)
    ? (value as { entries: unknown[] }).entries
    : null;
  if (!list) return null;
  return list.flatMap((item) => { const entry = readEntry(item); return entry ? [entry] : []; });
}

export function createMemoryClient(config: MemoryClientConfig): MemoryClient {
  const endpoint = memoryUrl(config.url);
  const doFetch = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = config.timeoutMs ?? 6_000;

  /** One call; anything but a JSON 2xx from a proxy that knows /memory is "unavailable". */
  const call = async (method: string, path: string, body?: unknown): Promise<Result<unknown>> => {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (config.apiKey) headers["Authorization"] = "Bearer " + config.apiKey;
      const response = await doFetch(endpoint + path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.status === 401 || response.status === 403) return { ok: false, error: "unauthorized" };
      if (!response.ok) return { ok: false, error: MEMORY_UNAVAILABLE };
      const value: unknown = await response.json().catch(() => null);
      if (!value || typeof value !== "object" || (value as { memory?: unknown }).memory !== true) {
        return { ok: false, error: MEMORY_UNAVAILABLE };
      }
      return { ok: true, value };
    } catch {
      return { ok: false, error: MEMORY_UNAVAILABLE };
    } finally {
      clearTimeout(timer);
    }
  };

  const entries = (result: Result<unknown>): Result<MemoryEntry[]> => {
    if (!result.ok) return result;
    const list = readEntries(result.value);
    return list ? { ok: true, value: list } : { ok: false, error: MEMORY_UNAVAILABLE };
  };

  return {
    async list(limit = 100) {
      return entries(await call("GET", "?limit=" + Math.max(1, Math.floor(limit))));
    },
    async add(entry) {
      const result = await call("POST", "", {
        type: entry.type,
        ...(entry.date ? { date: entry.date } : {}),
        title: entry.title,
        summary: entry.summary,
        agreements: [...(entry.agreements ?? [])],
      });
      if (!result.ok) return result;
      const saved = readEntry((result.value as { entry?: unknown }).entry);
      return saved ? { ok: true, value: saved } : { ok: false, error: MEMORY_UNAVAILABLE };
    },
    async remove(id) {
      const result = await call("DELETE", "/" + encodeURIComponent(id));
      return result.ok ? { ok: true, value: true } : result;
    },
    async clear() {
      const result = await call("DELETE", "");
      return result.ok ? { ok: true, value: true } : result;
    },
    async search(query, limit = 3) {
      if (!query.trim()) return { ok: true, value: [] };
      return entries(await call("POST", "/search", { query, limit }));
    },
  };
}

/** Clips to `max` characters with "…". */
function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length <= max ? chars.join("") : chars.slice(0, max - 1).join("") + "…";
}

/** "13.10.2026" / "2026-10-13" from an ISO date. */
export function memoryDate(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return locale === "de" ? `${day}.${month}.${d.getFullYear()}` : `${d.getFullYear()}-${month}-${day}`;
}

/**
 * The memory hits as context for the live insight prompt ("Notizen des
 * Nutzers"), short: the model gets facts to match, not whole transcripts.
 */
export function memoryNotes(hits: readonly MemoryEntry[], locale: Locale, max = 3): string {
  return hits.slice(0, max).map((hit) => {
    const agreements = hit.agreements.length
      ? (locale === "de" ? " Abmachungen: " : " Agreements: ") + clip(hit.agreements.join("; "), 240)
      : "";
    return "- " + memoryDate(hit.date, locale) + " " + clip(hit.title, 80) + ": " + clip(hit.summary, 300) + agreements;
  }).join("\n");
}

/** Everything as plain text, for "export" on the phone. */
export function memoryExport(entries: readonly MemoryEntry[], locale: Locale): string {
  const de = locale === "de";
  return entries.map((entry) => {
    const head = memoryDate(entry.date, locale) + " · " + (entry.type === "note" ? (de ? "Notiz" : "Note") : (de ? "Gespräch" : "Conversation"))
      + (entry.title ? " · " + entry.title : "");
    const agreements = entry.agreements.length
      ? "\n" + (de ? "Abmachungen:" : "Agreements:") + "\n" + entry.agreements.map((a) => "- " + a).join("\n")
      : "";
    return head + "\n" + entry.summary + agreements;
  }).join("\n\n---\n\n");
}

/** The search text for the live prompt: the newest lines, without speaker letters. */
export function memoryQuery(lines: readonly { readonly text: string }[], count = 3): string {
  return lines.slice(-count).map((line) => line.text).join(" ").slice(-400);
}
