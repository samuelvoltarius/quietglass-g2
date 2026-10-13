import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * Source configuration, stored in the Even app's per-app storage on the phone.
 *
 * Tokens are stored here alongside the URL because there is nowhere else to put
 * them — the Even app's storage is the app's private area on the device. They
 * are never logged, never placed in a URL, and never shown in full in the UI.
 */

export interface SourceConfig {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /** Optional bearer token, sent as a header. */
  readonly token?: string;
}

export interface StatusData {
  readonly sources: readonly SourceConfig[];
  /** Poll interval in seconds. */
  readonly pollSeconds: number;
  readonly invertScroll: boolean;
}

const KEY = "quietglass.statusglass.v1";

export const EMPTY_DATA: StatusData = {
  sources: [],
  pollSeconds: 30,
  invertScroll: false,
};

export async function save(bridge: EvenAppBridge, data: StatusData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

export async function load(bridge: EvenAppBridge): Promise<StatusData> {
  return withBuildSources(parseData(await bridge.getLocalStorage(KEY)));
}

/**
 * Sources a private build ships with, set at build time and never in the repo:
 * `VITE_STATUS_SOURCES="Name|https://host:port/status;Other|https://..."`
 * (entries separated by `;` or a new line, optional third part `|token`).
 * A build without it ships none.
 */
export function parseBuildSources(raw: string | undefined): SourceConfig[] {
  const out: SourceConfig[] = [];
  for (const entry of (raw ?? "").split(/[;\n]/)) {
    const [name = "", url = "", token = ""] = entry.split("|").map((part) => part.trim());
    if (!url || !validateUrl(url).valid) continue;
    out.push({ id: `build-${out.length + 1}`, name: name || url, url, ...(token ? { token } : {}) });
  }
  return out;
}

const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
export const BUILD_SOURCES: readonly SourceConfig[] = parseBuildSources(ENV["VITE_STATUS_SOURCES"]);

const trimSlash = (url: string): string => url.trim().replace(/\/+$/, "");

/**
 * Adds the build's own sources that are not in the stored list yet, so a
 * private build works without typing anything - on a fresh install and after an
 * update. Entries the user added themselves stay.
 */
export function withBuildSources(data: StatusData, defaults: readonly SourceConfig[] = BUILD_SOURCES): StatusData {
  const missing = defaults.filter((d) => !data.sources.some((s) => trimSlash(s.url) === trimSlash(d.url)));
  return missing.length === 0 ? data : { ...data, sources: [...missing, ...data.sources] };
}

export function nextSourceId(data: StatusData): string {
  let n = data.sources.length + 1;
  const taken = new Set(data.sources.map((s) => s.id));
  while (taken.has("s" + n)) n++;
  return "s" + n;
}

export function upsertSource(data: StatusData, source: SourceConfig): StatusData {
  const index = data.sources.findIndex((s) => s.id === source.id);
  const sources = index === -1
    ? [...data.sources, source]
    : [...data.sources.slice(0, index), source, ...data.sources.slice(index + 1)];
  return { ...data, sources };
}

export function removeSource(data: StatusData, id: string): StatusData {
  return { ...data, sources: data.sources.filter((s) => s.id !== id) };
}

export interface UrlCheck {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Validates a source URL.
 *
 * Plain `http:` is allowed because homelab sources routinely live on a LAN
 * without certificates — refusing it would just push people to disable checks
 * elsewhere. The phone UI warns about it instead.
 */
export function validateUrl(url: string, locale: Locale = "en"): UrlCheck {
  const errors: string[] = [];
  const trimmed = url.trim();
  if (!trimmed) {
    errors.push(t(locale, "v.urlRequired"));
    return { valid: false, errors };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push(t(locale, "v.urlScheme"));
    }
    // A password in the URL is shown in full on the sources list and refused
    // by fetch outright ("unreachable"); it belongs in the token field.
    if (parsed.username || parsed.password) {
      errors.push(t(locale, "v.urlCredentials"));
    }
  } catch {
    errors.push(t(locale, "v.urlInvalid"));
  }
  return { valid: errors.length === 0, errors };
}

export function isPlainHttp(url: string): boolean {
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

export function parseData(raw: string): StatusData {
  if (!raw) return EMPTY_DATA;
  try {
    const value = JSON.parse(raw) as Partial<StatusData>;

    const sources: SourceConfig[] = [];
    if (Array.isArray(value.sources)) {
      for (const candidate of value.sources) {
        const s = candidate as Partial<SourceConfig>;
        if (typeof s?.id !== "string" || typeof s.url !== "string") continue;
        if (!validateUrl(s.url).valid) continue;
        sources.push({
          id: s.id,
          name: typeof s.name === "string" && s.name ? s.name : s.id,
          url: s.url.trim(),
          ...(typeof s.token === "string" && s.token ? { token: s.token } : {}),
        });
      }
    }

    const pollSeconds = typeof value.pollSeconds === "number" && Number.isFinite(value.pollSeconds)
      ? Math.min(600, Math.max(5, Math.round(value.pollSeconds)))
      : EMPTY_DATA.pollSeconds;

    return {
      sources,
      pollSeconds,
      invertScroll: typeof value.invertScroll === "boolean" ? value.invertScroll : false,
    };
  } catch {
    return EMPTY_DATA;
  }
}

/** Shows that a token exists without revealing it. */
export function maskToken(token: string | undefined, locale: Locale = "en"): string {
  if (!token) return t(locale, "p.tokenNone");
  return t(locale, "p.tokenSet", { count: token.length });
}
