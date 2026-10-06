import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { validateServerUrl } from "../api/client";
import type { TakeStatus } from "../api/types";

/**
 * Settings and the take outbox, stored in the Even app's per-app storage on
 * the phone. The token sits here because there is nowhere else to put it; it
 * is never logged, never placed in a URL, and never shown in full.
 */

export interface Settings {
  /** Base URL of your Shoot Day server; empty until you enter one. */
  readonly serverUrl: string;
  readonly token?: string;
  readonly invertScroll: boolean;
}

/** A take logged while the server could not be reached, sent later. */
export interface PendingTake {
  readonly id: string;
  readonly project: string;
  readonly scene: string;
  readonly shot: string;
  readonly status: TakeStatus;
  readonly note: string;
  readonly ts: number;
}

export const SETTINGS_KEY = "quietglass.shootday.v1";
export const OUTBOX_KEY = "quietglass.shootday.outbox.v1";
/** Enough for a long day offline; older entries would go first. */
export const OUTBOX_LIMIT = 500;

export const EMPTY_SETTINGS: Settings = { serverUrl: "", invertScroll: false };

export function parseSettings(raw: string): Settings {
  if (!raw) return EMPTY_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<Settings>;
    const url = typeof value.serverUrl === "string" ? value.serverUrl.trim() : "";
    return {
      serverUrl: url && validateServerUrl(url).valid ? url : "",
      ...(typeof value.token === "string" && value.token ? { token: value.token } : {}),
      invertScroll: value.invertScroll === true,
    };
  } catch {
    return EMPTY_SETTINGS;
  }
}

export function parseOutbox(raw: string): PendingTake[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    const out: PendingTake[] = [];
    for (const entry of value.slice(-OUTBOX_LIMIT)) {
      const t = entry as Partial<PendingTake>;
      if (typeof t?.id !== "string" || typeof t.scene !== "string" || typeof t.shot !== "string") continue;
      out.push({
        id: t.id,
        project: typeof t.project === "string" ? t.project : "",
        scene: t.scene,
        shot: t.shot,
        status: t.status === "NG" ? "NG" : "OK",
        note: typeof t.note === "string" ? t.note : "",
        ts: typeof t.ts === "number" && Number.isFinite(t.ts) ? t.ts : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function loadSettings(bridge: EvenAppBridge): Promise<Settings> {
  return parseSettings(await bridge.getLocalStorage(SETTINGS_KEY).catch(() => ""));
}

export async function saveSettings(bridge: EvenAppBridge, settings: Settings): Promise<void> {
  await bridge.setLocalStorage(SETTINGS_KEY, JSON.stringify(settings));
}

export async function loadOutbox(bridge: EvenAppBridge): Promise<PendingTake[]> {
  return parseOutbox(await bridge.getLocalStorage(OUTBOX_KEY).catch(() => ""));
}

export async function saveOutbox(bridge: EvenAppBridge, outbox: readonly PendingTake[]): Promise<void> {
  await bridge.setLocalStorage(OUTBOX_KEY, JSON.stringify(outbox.slice(-OUTBOX_LIMIT)));
}

/** Shows that a token exists without revealing it. */
export function maskToken(token: string | undefined, locale: "de" | "en"): string {
  if (!token) return locale === "de" ? "keins" : "none";
  return locale === "de" ? `gesetzt (${token.length} Zeichen)` : `set (${token.length} chars)`;
}
