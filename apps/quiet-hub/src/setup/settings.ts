/**
 * Persistent settings (server, token, switches).
 *
 * The installed Even Hub build runs in its own WebView origin: its
 * `window.localStorage` is NOT the one the QR test or the simulator used and
 * may not survive relaunches. The SDK key-value store (`setLocalStorage`) is
 * the authoritative store; `window.localStorage` is only a best-effort mirror
 * and a fallback for plain-browser contexts.
 */
import type { AppSettings } from "../ui/phone";

export const SETTINGS_KEY = "quiethub.settings";

/** The slice of EvenAppBridge the settings need (kept narrow so tests can fake it). */
export interface SettingsBridge {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
}

export const DEFAULT_SETTINGS: AppSettings = { serverUrl: "", token: "", autoOpenNotifications: true, invertScroll: false, voiceAutoSend: false, speakAnswers: false, quietWhileWorking: false, briefMorning: false };

export function normalizeSettings(value: Partial<AppSettings>): AppSettings {
  return {
    serverUrl: typeof value.serverUrl === "string" ? value.serverUrl : "",
    token: typeof value.token === "string" ? value.token : "",
    autoOpenNotifications: value.autoOpenNotifications !== false,
    invertScroll: value.invertScroll === true,
    voiceAutoSend: value.voiceAutoSend === true,
    speakAnswers: value.speakAnswers === true,
    quietWhileWorking: value.quietWhileWorking === true,
    briefMorning: value.briefMorning === true,
  };
}

export async function loadSettings(bridge: SettingsBridge, fallback: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Promise<AppSettings> {
  try {
    const raw = await bridge.getLocalStorage(SETTINGS_KEY);
    if (raw !== null && raw !== undefined && raw !== "") return normalizeSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    // Fall through to the web storage.
  }
  try {
    const raw = fallback?.getItem(SETTINGS_KEY);
    if (raw !== null && raw !== undefined) return normalizeSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    // No storage: start unconfigured.
  }
  return DEFAULT_SETTINGS;
}

/**
 * Writes through the SDK store and reads the value back. `persisted` is true
 * only when the SDK store really returns what was written.
 */
export async function saveSettings(bridge: SettingsBridge, settings: AppSettings, mirror: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): Promise<{ persisted: boolean }> {
  const raw = JSON.stringify(settings);
  try {
    mirror?.setItem(SETTINGS_KEY, raw);
  } catch {
    // Mirror only.
  }
  try {
    const ok = await bridge.setLocalStorage(SETTINGS_KEY, raw);
    if (!ok) return { persisted: false };
    return { persisted: (await bridge.getLocalStorage(SETTINGS_KEY)) === raw };
  } catch {
    return { persisted: false };
  }
}
