import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * 0.7.0: the start screen is a customer list. The rows come from the
 * babel-llm-proxy (`GET /context/customers`, read-only, same auth as the
 * model), which reads Shoot Day: every customer (unassigned skipped) with its
 * next project. Today's customers come first (by time), then the rest by name;
 * the last row is always "Ohne Kunde – Übersetzen".
 */
export interface CustomerEntry {
  readonly id: string;
  readonly name: string;
  readonly company: string;
  /** Next project from today on: date "YYYY-MM-DD" or "YYYY-MM-DD HH:MM", and its name. */
  readonly next: { readonly date: string; readonly name: string } | null;
}

export const CUSTOMERS_TIMEOUT_MS = 4000;

/** `https://host:8448/v1` → `https://host:8448/context/customers`. */
export function customersUrl(llmUrl: string): string {
  const base = llmUrl.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/v1$/, "");
  return base + "/context/customers";
}

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** The proxy answer (`{customers:[…]}` or a bare array) as entries; null when it is no list at all. */
export function readCustomers(value: unknown): CustomerEntry[] | null {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { customers?: unknown }).customers)
      ? (value as { customers: unknown[] }).customers
      : null;
  if (list === null) return null;
  return list.flatMap((item): CustomerEntry[] => {
    if (!item || typeof item !== "object") return [];
    const r = item as Record<string, unknown>;
    const id = text(r["id"], 80);
    const name = text(r["name"], 120) || text(r["company"], 120);
    if (!id || !name) return [];
    const n = r["next"] && typeof r["next"] === "object" ? (r["next"] as Record<string, unknown>) : null;
    const date = n ? text(n["date"], 20) : "";
    return [{ id, name, company: text(r["company"], 120), next: date ? { date, name: n ? text(n["name"], 120) : "" } : null }];
  });
}

/** "YYYY-MM-DD" of a local date. */
export function dayKey(now: Date): string {
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
}

const isToday = (entry: CustomerEntry, today: string): boolean => entry.next !== null && entry.next.date.slice(0, 10) === today;

/** Today's customers first (all-day before timed, then by time), then everyone else by name. */
export function orderCustomers(list: readonly CustomerEntry[], now: Date): CustomerEntry[] {
  const today = dayKey(now);
  const byName = (a: CustomerEntry, b: CustomerEntry): number => a.name.localeCompare(b.name, "de", { sensitivity: "base" });
  const todays = list.filter((e) => isToday(e, today))
    .sort((a, b) => (a.next!.date < b.next!.date ? -1 : a.next!.date > b.next!.date ? 1 : byName(a, b)));
  const rest = list.filter((e) => !isToday(e, today)).sort(byName);
  return [...todays, ...rest];
}

function fit(row: string, width: number): string {
  const chars = [...row];
  return chars.length <= width ? row : chars.slice(0, width - 1).join("") + "…";
}

/** "heute 10:00" / "14.11. 10:00" / "14.11." for the row's right part. */
export function whenLabel(date: string, now: Date, locale: Locale): string {
  const day = date.slice(0, 10);
  const time = date.slice(11, 16);
  const label = day === dayKey(now)
    ? t(locale, "g.pick.today")
    : day.slice(8, 10) + "." + day.slice(5, 7) + ".";
  return time ? label + " " + time : label;
}

/** One list row (without the cursor mark): "Name · heute 10:00", the name shortened first. */
export function customerListRow(entry: CustomerEntry, now: Date, locale: Locale, width: number): string {
  if (!entry.next) return fit(entry.name, width);
  const tail = " · " + whenLabel(entry.next.date, now, locale);
  const room = width - [...tail].length;
  return room >= 6 ? fit(entry.name, room) + tail : fit(entry.name, width);
}

export interface CustomersFetchConfig {
  readonly url: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Never throws: the list, or null on any failure (no proxy, Shoot Day down, timeout). */
export async function fetchCustomers(config: CustomersFetchConfig): Promise<CustomerEntry[] | null> {
  const doFetch = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { controller?.abort(); resolve(null); }, config.timeoutMs ?? CUSTOMERS_TIMEOUT_MS);
  });
  const request = (async (): Promise<CustomerEntry[] | null> => {
    try {
      const response = await doFetch(customersUrl(config.url), {
        method: "GET",
        headers: { Accept: "application/json", ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}) },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) return null;
      return readCustomers(await response.json());
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A row of the start screen. */
export type PickRow =
  | { readonly kind: "customer"; readonly entry: CustomerEntry }
  | { readonly kind: "retry" }
  | { readonly kind: "loading" }
  | { readonly kind: "none" }
  /** Without the side menu: an entry that used to live there (Meine Stimme lernen/löschen, Personen), at the end of the list. */
  | { readonly kind: "menu"; readonly id: number; readonly label: string };

/** A row for the end of the list: the id of the side menu entry it stands for, and its label. */
export interface MenuRow { readonly id: number; readonly label: string }

/** What the list holds: still loading, loaded, failed, or no proxy at all (then only "Ohne Kunde"). */
export type CustomerListState =
  | { readonly state: "off" }
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | { readonly state: "ready"; readonly entries: readonly CustomerEntry[] };

export function pickRows(list: CustomerListState, now: Date, extras: readonly MenuRow[] = []): PickRow[] {
  const none: PickRow = { kind: "none" };
  const tail = extras.map((extra): PickRow => ({ kind: "menu", id: extra.id, label: extra.label }));
  switch (list.state) {
    case "off": return [none, ...tail];
    case "loading": return [{ kind: "loading" }, none, ...tail];
    case "failed": return [{ kind: "retry" }, none, ...tail];
    case "ready": return [...orderCustomers(list.entries, now).map((entry): PickRow => ({ kind: "customer", entry })), none, ...tail];
  }
}

/** The list as glasses rows: "> " marks the cursor; scrolled so the cursor stays visible. */
export function pickBody(rows: readonly PickRow[], cursor: number, now: Date, locale: Locale, width: number, visible: number): string[] {
  const label = (row: PickRow): string => {
    switch (row.kind) {
      case "customer": return customerListRow(row.entry, now, locale, width - 2);
      case "retry": return t(locale, "g.pick.failed");
      case "loading": return t(locale, "g.pick.loading");
      case "none": return t(locale, "g.pick.none");
      case "menu": return fit(row.label, width - 2);
    }
  };
  const at = Math.min(Math.max(0, cursor), rows.length - 1);
  const start = Math.max(0, Math.min(at - visible + 1, rows.length - visible));
  const first = Math.max(0, Math.min(start, at));
  return rows.slice(first, first + visible).map((row, i) => (first + i === at ? "> " : "  ") + label(row));
}
