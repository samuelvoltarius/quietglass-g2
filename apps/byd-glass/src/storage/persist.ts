import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { validateUrl } from "../car/client";

/**
 * Settings, stored in the Even app's per-app storage on the phone. There is no
 * token: the bridge trusts the Tailscale login that `tailscale serve` adds.
 */
export interface Settings {
  /** The byd-bridge; empty = the build's own address (if any), else demo. */
  readonly url: string;
  readonly invertScroll: boolean;
}

export const SETTINGS_KEY = "quietglass.bydglass.v1";
export const EMPTY_SETTINGS: Settings = { url: "", invertScroll: false };

const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * A private build ships its bridge address (`VITE_BYD_URL=https://host:port`),
 * so it works without typing anything. Never set in the repository.
 */
export function buildUrl(raw: string | undefined = ENV["VITE_BYD_URL"]): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  return url && validateUrl(url).valid ? url : "";
}
export const BUILD_URL = buildUrl();

export function parseSettings(raw: string): Settings {
  if (!raw) return EMPTY_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<Settings>;
    const url = typeof value.url === "string" ? value.url.trim().replace(/\/+$/, "") : "";
    return { url: url && validateUrl(url).valid ? url : "", invertScroll: value.invertScroll === true };
  } catch {
    return EMPTY_SETTINGS;
  }
}

/** The address actually used: the typed one, otherwise the build's; empty = demo. */
export function effectiveUrl(settings: Settings, fallback: string = BUILD_URL): string {
  return settings.url || fallback;
}

export async function loadSettings(bridge: EvenAppBridge): Promise<Settings> {
  return parseSettings(await bridge.getLocalStorage(SETTINGS_KEY).catch(() => ""));
}

export async function saveSettings(bridge: EvenAppBridge, settings: Settings): Promise<void> {
  await bridge.setLocalStorage(SETTINGS_KEY, JSON.stringify(settings));
}
