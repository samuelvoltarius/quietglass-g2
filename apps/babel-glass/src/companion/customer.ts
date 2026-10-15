import { wrap } from "../captions/buffer";
import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * Customer context from Shoot Day, read through the babel-llm-proxy (0.6.2):
 * `GET /context/customer?full=1` next to the language model. Read-only; any
 * failure (no proxy, older proxy, no Shoot Day, timeout) means "no customer"
 * and the glasses simply show nothing about it.
 */
export interface CustomerContext {
  readonly name: string;
  readonly project: string;
  readonly date: string;
  readonly place: string;
  readonly ideas: readonly string[];
  readonly storyboards: readonly { readonly title: string; readonly scenes: readonly string[] }[];
  readonly slogans: readonly string[];
}

export const CUSTOMER_TIMEOUT_MS = 3000;

/** `https://host:8448/v1` → `https://host:8448/context/customer?full=1` (0.7.0: `&customer=<id>` for the picked one). */
export function customerUrl(llmUrl: string, customer?: string): string {
  const base = llmUrl.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/v1$/, "");
  return base + "/context/customer?full=1" + (customer ? "&customer=" + encodeURIComponent(customer) : "");
}

const text = (value: unknown, max = 200): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
const texts = (value: unknown, limit: number, max = 200): string[] =>
  Array.isArray(value) ? value.map((v) => text(v, max)).filter((v) => v !== "").slice(0, limit) : [];

/** The proxy answer as a customer, or null when it reports none (disabled, no name, counts-only answer). */
export function readCustomer(value: unknown): CustomerContext | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const name = text(v["name"], 120);
  if (v["enabled"] !== true || !name) return null;
  const boards = Array.isArray(v["storyboards"])
    ? (v["storyboards"] as unknown[]).flatMap((b) => {
      if (!b || typeof b !== "object") return [];
      const r = b as Record<string, unknown>;
      return [{ title: text(r["title"], 80) || "Storyboard", scenes: texts(r["scenes"], 20, 60) }];
    }).slice(0, 6)
    : [];
  return {
    name,
    project: text(v["project"], 120),
    date: text(v["date"], 40),
    place: text(v["place"], 120),
    ideas: texts(v["ideas"], 20, 160),
    storyboards: boards,
    slogans: texts(v["slogans"], 10, 80),
  };
}

export interface CustomerFetchConfig {
  readonly url: string;
  readonly apiKey?: string;
  /** 0.7.0: the customer picked on the start screen (Shoot Day id); omitted = Shoot Day's active one. */
  readonly customer?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Never throws: null on any failure, after at most `timeoutMs`. */
export async function fetchCustomer(config: CustomerFetchConfig): Promise<CustomerContext | null> {
  const doFetch = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { controller?.abort(); resolve(null); }, config.timeoutMs ?? CUSTOMER_TIMEOUT_MS);
  });
  const request = (async (): Promise<CustomerContext | null> => {
    try {
      const response = await doFetch(customerUrl(config.url, config.customer), {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}),
          ...(config.customer ? { "X-Babel-Customer": config.customer } : {}),
        },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) return null;
      return readCustomer(await response.json());
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

function fit(row: string, width: number): string {
  const chars = [...row];
  return chars.length <= width ? row : chars.slice(0, width - 1).join("") + "…";
}

/** The one row on the idle screen: "Kunde: <name> · 3 Ideen", the name shortened to fit. */
export function customerIdleRow(customer: CustomerContext, locale: Locale, width: number): string {
  const tail = " · " + t(locale, "g.cust.ideas", { n: String(customer.ideas.length) });
  const head = t(locale, "g.cust.label") + " ";
  const room = width - [...head].length - [...tail].length;
  if (room >= 4) return head + fit(customer.name, room) + tail;
  return fit(head + customer.name, width);
}

/** The "Kunde" popup as rows: who, project, then ideas, storyboards (scene titles), slogans. */
export function customerRows(customer: CustomerContext, locale: Locale, width: number): string[] {
  const x = (key: string): string => t(locale, key);
  const rows: string[] = [...wrap(x("g.cust.label") + " " + customer.name, width)];
  const where = [customer.project, customer.date, customer.place].filter((part) => part !== "").join(" · ");
  if (where) rows.push(...wrap(x("g.cust.project") + " " + where, width));
  if (customer.ideas.length) {
    rows.push("", x("g.cust.ideasHead"));
    for (const idea of customer.ideas) rows.push(...wrap("· " + idea, width));
  }
  for (const board of customer.storyboards) {
    rows.push("", x("g.cust.board") + " " + board.title);
    board.scenes.forEach((scene, i) => rows.push(...wrap(" " + (i + 1) + ". " + scene, width)));
  }
  if (customer.slogans.length) {
    rows.push("", x("g.cust.slogans"));
    for (const slogan of customer.slogans) rows.push(...wrap("· " + slogan, width));
  }
  return rows;
}

/** The phone line: "Kunde (Shoot Day): <name> – 3 Ideen, 1 Storyboards". */
export function customerPhoneLine(customer: CustomerContext, locale: Locale): string {
  return t(locale, "p.cust", { name: customer.name, ideas: String(customer.ideas.length), boards: String(customer.storyboards.length) });
}
