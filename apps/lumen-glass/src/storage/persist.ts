import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

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
  /** Session cookie value, only needed when LUMEN runs in closed mode. */
  readonly token?: string;
  readonly invertScroll: boolean;
}

const KEY = "quietglass.lumenglass.v1";

/**
 * LUMEN's own documented default is 127.0.0.1:8077, so that is the starting
 * point rather than an empty field. Anyone running it elsewhere changes it
 * once; anyone running it as documented never has to.
 */
export const EMPTY_DATA: LumenData = {
  baseUrl: "http://127.0.0.1:8077",
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
export function validateUrl(url: string): UrlCheck {
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, errors: ["Address is required."] };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, errors: ["Address must start with http:// or https://."] };
    }
    return { valid: true, errors: [] };
  } catch {
    return { valid: false, errors: ["Address is not a valid URL."] };
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

export function parseData(raw: string): LumenData {
  if (!raw) return EMPTY_DATA;
  try {
    const value = JSON.parse(raw) as Partial<LumenData>;
    const baseUrl = typeof value.baseUrl === "string" && validateUrl(value.baseUrl).valid
      ? value.baseUrl.trim()
      : "";
    return {
      baseUrl,
      ...(typeof value.token === "string" && value.token ? { token: value.token } : {}),
      invertScroll: typeof value.invertScroll === "boolean" ? value.invertScroll : false,
    };
  } catch {
    return EMPTY_DATA;
  }
}

/** Shows that a token exists without revealing it. */
export function maskToken(token: string | undefined): string {
  return token ? "set (" + token.length + " chars)" : "none";
}
