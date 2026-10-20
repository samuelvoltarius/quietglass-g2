import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { validateServerUrl } from "../api/client";
import type { TakeStatus } from "../api/types";

/**
 * Settings and the take outbox, stored in the Even app's per-app storage on
 * the phone. The token sits here because there is nowhere else to put it; it
 * is never logged, never placed in a URL, and never shown in full.
 */

export interface Settings {
  /** Base URL of your Shoot Day server; empty = the build's own address (if any). */
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

const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * A private build ships its server address (`VITE_SHOOTDAY_URL=https://host:port`),
 * so it works without typing anything. Never set in the repository.
 */
export function buildUrl(raw: string | undefined = ENV["VITE_SHOOTDAY_URL"]): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  return url && validateServerUrl(url).valid ? url : "";
}
export const BUILD_URL = buildUrl();

/**
 * Addresses that only ever stood in a form as an example, or point at the
 * phone itself, and so can never reach the server. A stored one is dropped
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
  return settings.serverUrl || fallback;
}

export function parseSettings(raw: string, build: string = BUILD_URL): Settings {
  if (!raw) return EMPTY_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<Settings>;
    const typed = typeof value.serverUrl === "string" ? value.serverUrl.trim() : "";
    // A placeholder left over from an earlier version gives way to the build's own address.
    const url = typed && build && isPlaceholderUrl(typed) ? "" : typed;
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

/**
 * Where the user was on the glasses: module, shot, running take, prompter,
 * packing list. The Even app unloads Shoot Day after the phone was locked
 * for a while; the next start comes back to the same place.
 */
export const UI_KEY = "quietglass.shootday.ui.v1";
/** A take that has been "running" longer than this was forgotten, not filmed. */
export const ROLLING_MAX_MS = 2 * 60 * 60 * 1000;

export type SavedModule = "menu" | "board" | "day" | "takes" | "prompter" | "schedule" | "pack" | "light";

export interface SavedUi {
  readonly mode: SavedModule;
  readonly menuCursor: number;
  /** The shot by name, so a reordered list still finds it. */
  readonly shot: { readonly scene: string; readonly shot: string } | null;
  readonly rollingSince: number | null;
  readonly prompterPos: number;
  readonly prompterSpeed: number;
  readonly packCursor: number;
  readonly scheduleScroll: number;
}

export function parseUi(raw: string, now = Date.now()): SavedUi | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const modes: readonly SavedModule[] = ["menu", "board", "day", "takes", "prompter", "schedule", "pack", "light"];
    const mode = modes.includes(v.mode as SavedModule) ? (v.mode as SavedModule) : "menu";
    const int = (x: unknown, max: number): number => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.min(max, Math.floor(x))) : 0);
    const shotValue = v.shot as { scene?: unknown; shot?: unknown } | null | undefined;
    const shot = shotValue && typeof shotValue.scene === "string" && typeof shotValue.shot === "string" ? { scene: shotValue.scene, shot: shotValue.shot } : null;
    const rolling = typeof v.rollingSince === "number" && now - v.rollingSince >= 0 && now - v.rollingSince <= ROLLING_MAX_MS ? v.rollingSince : null;
    const speed = typeof v.prompterSpeed === "number" && v.prompterSpeed >= 0.1 && v.prompterSpeed <= 3 ? v.prompterSpeed : 0.4;
    const pos = typeof v.prompterPos === "number" && v.prompterPos >= 0 ? v.prompterPos : 0;
    return {
      mode,
      menuCursor: int(v.menuCursor, 10),
      shot,
      rollingSince: mode === "takes" ? rolling : null,
      prompterPos: pos,
      prompterSpeed: speed,
      packCursor: int(v.packCursor, 10_000),
      scheduleScroll: int(v.scheduleScroll, 10_000),
    };
  } catch {
    return null;
  }
}
