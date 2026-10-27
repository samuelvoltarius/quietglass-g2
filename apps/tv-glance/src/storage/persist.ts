import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { normaliseBase, validateUrl } from "../tv/errors";
import { parseAppList, type AppEntry } from "../tv/model";

/**
 * Settings, stored in the Even app's per-app storage on the phone (like every
 * Quietglass app). Tokens are never logged and never shown in full; they only
 * travel to the address the user entered.
 */
export type BackendKind = "none" | "ha" | "bridge";

/** One controllable device (Home Assistant): the player, its remote for the D-pad, and a name for the glasses. */
export interface Device {
  /** `media_player.…` */
  readonly entityId: string;
  /** `remote.…` for the D-pad, "" = none. */
  readonly remoteId: string;
  /** The name shown on the glasses; "" = the player's friendly name (or its id before the first answer). */
  readonly name: string;
}

export const MAX_DEVICES = 6;

export interface Settings {
  readonly backend: BackendKind;
  /** Home Assistant base address (http, https, ws or wss); empty = the build's preset, if any. */
  readonly haUrl: string;
  /** Home Assistant long-lived access token. */
  readonly haToken?: string;
  /** The Home Assistant devices (TV, projector …), switchable on the glasses. */
  readonly devices: readonly Device[];
  /** Index into `devices` of the device the glasses control. */
  readonly activeDevice: number;
  readonly bridgeUrl: string;
  /** Bridge bearer token (optional behind tailscale serve with a login check). */
  readonly bridgeToken?: string;
  /** The app list of "Apps & input" (besides the TV's own sources). */
  readonly apps: readonly AppEntry[];
  readonly invertScroll: boolean;
}

export const SETTINGS_KEY = "quietglass.tvglance.v1";
export const EMPTY_SETTINGS: Settings = { backend: "none", haUrl: "", devices: [], activeDevice: 0, bridgeUrl: "", apps: [], invertScroll: false };

const url = (value: unknown, allowWs = false): string => {
  const text = typeof value === "string" ? normaliseBase(value) : "";
  return text && validateUrl(text, allowWs).valid ? text : "";
};

const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * A private build may preset the Home Assistant address (`VITE_HA_URL=<address> npm run build`).
 * Empty in public builds, so the public bundle carries no address. Never a token: that is always
 * entered on the phone.
 */
export function buildHaUrl(raw: string | undefined = ENV["VITE_HA_URL"]): string {
  return url(raw ?? "", true);
}
export const BUILD_HA_URL = buildHaUrl();

/** The build variable; the process environment is the fallback (tests of a relay build set it there; no `process` in the WebView). */
function relayFromEnv(): string | undefined {
  const node = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return ENV["VITE_HA_RELAY"] ?? node?.env?.["VITE_HA_RELAY"];
}

/**
 * A private build may connect through the owner's relay (`VITE_HA_RELAY=<address> npm run build`): a small
 * service on the tailnet that speaks Home Assistant's WebSocket protocol, holds the real token itself and
 * lists the devices at `/config`. The app then needs no token and no device picking. Empty in public builds.
 */
export function buildHaRelay(raw: string | undefined = relayFromEnv()): string {
  return url(raw ?? "", true);
}
export const BUILD_HA_RELAY = buildHaRelay();

/** What the app sends as "token" to a relay: it accepts any value (the relay has the real token). */
export const RELAY_PLACEHOLDER_TOKEN = "relay";

/** The Home Assistant address in use: the build's relay, else the typed one, else the build's preset. */
export function effectiveHaUrl(settings: Settings, fallback: string = BUILD_HA_URL, relay: string = BUILD_HA_RELAY): string {
  return relay || settings.haUrl || fallback;
}

/** The token in use: a placeholder for a relay, else the typed one. */
export function effectiveHaToken(settings: Settings, relay: string = BUILD_HA_RELAY): string {
  return relay ? RELAY_PLACEHOLDER_TOKEN : settings.haToken ?? "";
}

/** Defaults: with a preset address or a relay the connection starts as Home Assistant (a preset address still needs the token). */
export function defaultSettings(fallback: string = BUILD_HA_URL, relay: string = BUILD_HA_RELAY): Settings {
  return fallback || relay ? { ...EMPTY_SETTINGS, backend: "ha" } : EMPTY_SETTINGS;
}
const token = (value: unknown): string => (typeof value === "string" ? value.trim().slice(0, 1024) : "");

const PLAYER = /^media_player\.[\w-]+$/;
const REMOTE = /^remote\.[\w-]+$/;

/**
 * The device list. Older versions (0.1.x) stored one `entityId`/`remoteId` pair: it becomes device 1
 * (a remote of "-" or "" meant none).
 */
export function parseDevices(value: Record<string, unknown>): Device[] {
  const out: Device[] = [];
  const add = (entityId: unknown, remoteId: unknown, name: unknown): void => {
    if (typeof entityId !== "string" || !PLAYER.test(entityId) || out.some((d) => d.entityId === entityId) || out.length >= MAX_DEVICES) return;
    out.push({
      entityId,
      remoteId: typeof remoteId === "string" && REMOTE.test(remoteId) ? remoteId : "",
      name: typeof name === "string" ? name.trim().slice(0, 40) : "",
    });
  };
  if (Array.isArray(value["devices"])) {
    for (const item of value["devices"] as unknown[]) {
      const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      add(entry["entityId"], entry["remoteId"], entry["name"]);
    }
  } else {
    add(value["entityId"], value["remoteId"], "");
  }
  return out;
}

/** The device the glasses control, or null before one is chosen. */
export function activeDeviceOf(settings: Pick<Settings, "devices" | "activeDevice">): Device | null {
  return settings.devices[settings.activeDevice] ?? settings.devices[0] ?? null;
}

/** The name shown for a device: the typed one, else the friendly name from Home Assistant, else the id without its domain. */
export function deviceLabel(device: Device, friendly?: string | null): string {
  return device.name || friendly || device.entityId.replace(/^media_player\./, "").replace(/_/g, " ");
}

export function addDevice(settings: Settings, device: Device): Settings {
  if (settings.devices.length >= MAX_DEVICES || settings.devices.some((d) => d.entityId === device.entityId)) return settings;
  return { ...settings, devices: [...settings.devices, device] };
}

/** Removes a device; the active one stays the same device where possible. */
export function removeDevice(settings: Settings, entityId: string): Settings {
  const at = settings.devices.findIndex((d) => d.entityId === entityId);
  if (at < 0) return settings;
  const devices = settings.devices.filter((_, index) => index !== at);
  const active = at < settings.activeDevice ? settings.activeDevice - 1 : settings.activeDevice;
  return { ...settings, devices, activeDevice: Math.max(0, Math.min(Math.max(0, devices.length - 1), active)) };
}

export function updateDevice(settings: Settings, entityId: string, patch: Partial<Pick<Device, "name" | "remoteId">>): Settings {
  return { ...settings, devices: settings.devices.map((d) => (d.entityId === entityId ? { ...d, ...patch } : d)) };
}

/** The next device in the list (wraps around). */
export function nextActive(settings: Pick<Settings, "devices" | "activeDevice">): number {
  return settings.devices.length === 0 ? 0 : (settings.activeDevice + 1) % settings.devices.length;
}

/**
 * The devices a relay lists at `/config` (`{"devices":[{"entityId","remoteId","name"}]}`), checked like stored ones.
 * Anything else yields an empty list.
 */
export function parseRelayDevices(raw: unknown): Device[] {
  const list = raw && typeof raw === "object" ? (raw as Record<string, unknown>)["devices"] : undefined;
  return Array.isArray(list) ? parseDevices({ devices: list }) : [];
}

/** First start of a relay build: the relay's devices become the device list (active = first), but only while the saved list is empty. */
export function importRelayDevices(settings: Settings, found: readonly Device[]): Settings {
  if (settings.devices.length > 0 || found.length === 0) return settings;
  return { ...settings, backend: "ha", devices: found.slice(0, MAX_DEVICES), activeDevice: 0 };
}

export function parseSettings(raw: string, fallback: string = BUILD_HA_URL, relay: string = BUILD_HA_RELAY): Settings {
  if (!raw) return defaultSettings(fallback, relay);
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const backend: BackendKind = value["backend"] === "ha" || value["backend"] === "bridge" ? value["backend"] : "none";
    const haToken = token(value["haToken"]);
    const bridgeToken = token(value["bridgeToken"]);
    const devices = parseDevices(value);
    const wanted = typeof value["activeDevice"] === "number" && Number.isInteger(value["activeDevice"]) ? value["activeDevice"] : 0;
    const apps = Array.isArray(value["apps"])
      ? parseAppList((value["apps"] as unknown[]).map((item) => {
        const entry = item as Partial<AppEntry> | null;
        return entry && typeof entry.id === "string" ? `${typeof entry.label === "string" ? entry.label : entry.id}=${entry.id}` : "";
      }).join("\n"))
      : [];
    return {
      // A relay build has no other connection.
      backend: relay ? "ha" : backend,
      haUrl: url(value["haUrl"], true),
      ...(haToken ? { haToken } : {}),
      devices,
      activeDevice: Math.max(0, Math.min(Math.max(0, devices.length - 1), wanted)),
      bridgeUrl: url(value["bridgeUrl"]),
      ...(bridgeToken ? { bridgeToken } : {}),
      apps,
      invertScroll: value["invertScroll"] === true,
    };
  } catch {
    return defaultSettings(fallback, relay);
  }
}

/** True when the chosen backend has everything it needs to be asked (a relay needs no token). */
export function isConfigured(settings: Settings, fallback: string = BUILD_HA_URL, relay: string = BUILD_HA_RELAY): boolean {
  if (settings.backend === "ha") return effectiveHaUrl(settings, fallback, relay) !== "" && (relay !== "" || Boolean(settings.haToken));
  if (settings.backend === "bridge") return settings.bridgeUrl !== "";
  return false;
}

export async function loadSettings(bridge: EvenAppBridge): Promise<Settings> {
  return parseSettings(await bridge.getLocalStorage(SETTINGS_KEY).catch(() => ""));
}

export async function saveSettings(bridge: EvenAppBridge, settings: Settings): Promise<void> {
  await bridge.setLocalStorage(SETTINGS_KEY, JSON.stringify(settings));
}

/** Shows that a token exists without revealing it. */
export function maskToken(value: string | undefined, locale: "de" | "en"): string {
  if (!value) return locale === "de" ? "keins" : "none";
  return locale === "de" ? `gesetzt (${value.length} Zeichen)` : `set (${value.length} chars)`;
}
