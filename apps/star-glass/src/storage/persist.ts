import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { validateBridgeUrl } from "../nina/client";

/**
 * Settings, stored in the Even app's per-app storage on the phone. The token
 * is never logged, never placed in a URL, and never shown in full.
 */
export interface Settings {
  /** Base URL of your Star Glass bridge; empty = the build's own address (if any). */
  readonly bridgeUrl: string;
  readonly token?: string;
  readonly invertScroll: boolean;
}

export const SETTINGS_KEY = "quietglass.starglass.v1";
export const EMPTY_SETTINGS: Settings = { bridgeUrl: "", invertScroll: false };

const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * A private build ships its bridge address (`VITE_STAR_URL=https://host:port`),
 * so it works without typing anything. Never set in the repository.
 */
export function buildUrl(raw: string | undefined = ENV["VITE_STAR_URL"]): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  return url && validateBridgeUrl(url).valid ? url : "";
}
export const BUILD_URL = buildUrl();

export function parseSettings(raw: string): Settings {
  if (!raw) return EMPTY_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<Settings>;
    const url = typeof value.bridgeUrl === "string" ? value.bridgeUrl.trim() : "";
    return {
      bridgeUrl: url && validateBridgeUrl(url).valid ? url : "",
      ...(typeof value.token === "string" && value.token ? { token: value.token } : {}),
      invertScroll: value.invertScroll === true,
    };
  } catch {
    return EMPTY_SETTINGS;
  }
}

/** The address actually used: the typed one, otherwise the build's. */
export function effectiveUrl(settings: Settings, fallback: string = BUILD_URL): string {
  return settings.bridgeUrl || fallback;
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
