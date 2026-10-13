import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { validateUrl } from "../ns/client";
import { DEFAULT_LIMITS, normaliseLimits, type Limits } from "../ns/alerts";
import type { Unit } from "../ns/units";

/**
 * Settings, stored in the Even app's per-app storage on the phone. The token
 * is never logged and never shown in full.
 */
export interface Settings {
  /** Nightscout or Sugar Glass bridge; empty = the build's own address (if any). */
  readonly url: string;
  /** Nightscout access token (role "readable"); only needed without the bridge. */
  readonly token?: string;
  readonly unit: Unit;
  readonly limits: Limits;
  readonly invertScroll: boolean;
}

export const SETTINGS_KEY = "quietglass.sugarglass.v1";
export const EMPTY_SETTINGS: Settings = { url: "", unit: "mgdl", limits: DEFAULT_LIMITS, invertScroll: false };

const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * A private build ships its server address (`VITE_NS_URL=https://host:port`,
 * normally the Sugar Glass bridge), so it works without typing anything.
 * Never set in the repository; never a token.
 */
export function buildUrl(raw: string | undefined = ENV["VITE_NS_URL"]): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  return url && validateUrl(url).valid ? url : "";
}
export const BUILD_URL = buildUrl();

export function parseSettings(raw: string): Settings {
  if (!raw) return EMPTY_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<Settings> & { limits?: Partial<Limits> };
    const url = typeof value.url === "string" ? value.url.trim() : "";
    return {
      url: url && validateUrl(url).valid ? url : "",
      ...(typeof value.token === "string" && value.token ? { token: value.token } : {}),
      unit: value.unit === "mmol" ? "mmol" : "mgdl",
      limits: normaliseLimits(value.limits ?? {}),
      invertScroll: value.invertScroll === true,
    };
  } catch {
    return EMPTY_SETTINGS;
  }
}

/** The address actually used: the typed one, otherwise the build's. */
export function effectiveUrl(settings: Settings, fallback: string = BUILD_URL): string {
  return settings.url || fallback;
}

export async function loadSettings(bridge: EvenAppBridge): Promise<Settings> {
  return parseSettings(await bridge.getLocalStorage(SETTINGS_KEY).catch(() => ""));
}

export async function saveSettings(bridge: EvenAppBridge, settings: Settings): Promise<void> {
  await bridge.setLocalStorage(SETTINGS_KEY, JSON.stringify(settings));
}

/** Shows that a token exists without revealing it. */
export function maskToken(token: string | undefined, locale: "de" | "en"): string {
  if (!token) return locale === "de" ? "keins" : "none";
  return locale === "de" ? `gesetzt (${token.length} Zeichen)` : `set (${token.length} chars)`;
}
