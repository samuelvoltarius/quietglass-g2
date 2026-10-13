import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { validateBridgeUrl } from "../printer/client";

/**
 * Settings, stored in the Even app's per-app storage on the phone. The token
 * is never logged, never placed in a URL, and never shown in full.
 */
export interface Settings {
  /** Base URL of your Klipper Glance bridge; empty = the build's own address (if any). */
  readonly bridgeUrl: string;
  readonly token?: string;
  readonly invertScroll: boolean;
}

export const SETTINGS_KEY = "quietglass.klipperglance.v1";
export const EMPTY_SETTINGS: Settings = { bridgeUrl: "", invertScroll: false };

const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * A private build ships its bridge address (`VITE_KLIPPER_URL=https://host:port`),
 * so it works without typing anything. Never set in the repository.
 */
export function buildUrl(raw: string | undefined = ENV["VITE_KLIPPER_URL"]): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  return url && validateBridgeUrl(url).valid ? url : "";
}
export const BUILD_URL = buildUrl();

/**
 * Addresses that only ever stood in a form as an example, or point at the
 * phone itself, and so can never reach a bridge. A stored one is dropped
 * once, so a private build falls back to its own address.
 */
export function isPlaceholderUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1"
      || host.startsWith("your-") || host.startsWith("dein-") || host.endsWith(".example") || host === "example.com";
  } catch {
    return true;
  }
}

/** The address actually used: the typed one, otherwise the build's. */
export function effectiveUrl(settings: Settings, fallback: string = BUILD_URL): string {
  return settings.bridgeUrl || fallback;
}

export function parseSettings(raw: string, build: string = BUILD_URL): Settings {
  if (!raw) return EMPTY_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<Settings>;
    const typed = typeof value.bridgeUrl === "string" ? value.bridgeUrl.trim() : "";
    // A placeholder left over from an earlier version gives way to the build's own address.
    const url = typed && build && isPlaceholderUrl(typed) ? "" : typed;
    return {
      bridgeUrl: url && validateBridgeUrl(url).valid ? url : "",
      ...(typeof value.token === "string" && value.token ? { token: value.token } : {}),
      invertScroll: value.invertScroll === true,
    };
  } catch {
    return EMPTY_SETTINGS;
  }
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
