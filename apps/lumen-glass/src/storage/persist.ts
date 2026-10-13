import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * Where your LUMEN lives, and nothing else.
 *
 * No photos, no quests and no history are stored here — LUMEN already keeps
 * all of that, and a second copy on the phone would only be a second thing to
 * leak.
 */

export interface LumenData {
  /** Base URL of the LUMEN instance, e.g. http://127.0.0.1:8077 */
  readonly baseUrl: string;
  /** Access token (sent as Bearer), only for a LUMEN that asks for one. */
  readonly token?: string;
  readonly invertScroll: boolean;
}

const KEY = "quietglass.lumenglass.v1";

/** LUMEN's own documented address; inside the Even app it points at the phone itself. */
export const LUMEN_DOC_DEFAULT = "http://127.0.0.1:8077";

/** Set at build time in a private build: `VITE_LUMEN_URL=https://… npm run build`. */
const BUILD_LUMEN_URL: string = ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_LUMEN_URL ?? "").trim();

/** The address a fresh install starts with: the private build's server, else LUMEN's documented default. */
export function defaultBaseUrl(build: string = BUILD_LUMEN_URL): string {
  return build || LUMEN_DOC_DEFAULT;
}

/**
 * A stored address that was never really chosen (empty, or the documented
 * placeholder) gives way to the build's server, so a private build works
 * without any typing even after an older version saved the placeholder.
 */
export function migrateBaseUrl(stored: string, build: string = BUILD_LUMEN_URL): string {
  const trimmed = stored.trim().replace(/\/+$/, "");
  if (build && (trimmed === "" || trimmed === LUMEN_DOC_DEFAULT)) return build;
  return stored.trim();
}

export const EMPTY_DATA: LumenData = {
  baseUrl: defaultBaseUrl(),
  invertScroll: false,
};

export async function save(bridge: EvenAppBridge, data: LumenData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

export async function load(bridge: EvenAppBridge): Promise<LumenData> {
  return parseData(await bridge.getLocalStorage(KEY));
}

export interface UrlCheck {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Plain http is expected here, not tolerated as an exception: LUMEN is
 * normally run on the user's own machine or LAN, where there is no
 * certificate. The phone app points that out rather than refusing it.
 */
export function validateUrl(url: string, locale: Locale = "en"): UrlCheck {
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, errors: [t(locale, "p.urlRequired")] };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, errors: [t(locale, "p.urlScheme")] };
    }
    return { valid: true, errors: [] };
  } catch {
    return { valid: false, errors: [t(locale, "p.urlInvalid")] };
  }
}

export function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost"
      || host === "127.0.0.1"
      || host.endsWith(".local")
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  } catch {
    return false;
  }
}

export function parseData(raw: string, build: string = BUILD_LUMEN_URL): LumenData {
  if (!raw) return { ...EMPTY_DATA, baseUrl: defaultBaseUrl(build) };
  try {
    const value = JSON.parse(raw) as Partial<LumenData>;
    const baseUrl = typeof value.baseUrl === "string" && validateUrl(value.baseUrl).valid
      ? value.baseUrl.trim()
      : "";
    return {
      baseUrl: migrateBaseUrl(baseUrl, build),
      ...(typeof value.token === "string" && value.token ? { token: value.token } : {}),
      invertScroll: typeof value.invertScroll === "boolean" ? value.invertScroll : false,
    };
  } catch {
    return { ...EMPTY_DATA, baseUrl: defaultBaseUrl(build) };
  }
}

/** Shows that a token exists without revealing it. */
export function maskToken(token: string | undefined, locale: Locale): string {
  return token ? t(locale, "p.tokenSet", { count: token.length }) : t(locale, "p.tokenNone");
}
