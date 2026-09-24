import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { CaptionMode } from "../glasses/view";

/**
 * Configuration, stored in the Even app's per-app storage on the phone.
 *
 * No captions and no audio are ever written here. The transcript exists in
 * memory for the session and is gone when the app closes — a record of
 * everything said around someone is not something this app is willing to keep.
 */

export interface BabelData {
  readonly mode: CaptionMode;
  /** WebSocket URL of the speech recognition server. Empty means use the mock. */
  readonly sttUrl: string;
  readonly sttToken?: string;
  /** BCP-47 source language or "auto". */
  readonly sourceLanguage: string;

  /** HTTP endpoint for translation. Empty disables translation. */
  readonly translateUrl: string;
  readonly translateKey?: string;
  readonly targetLanguage: string;

  readonly invertScroll: boolean;
}

const KEY = "aignerlabs.babelglass.v1";

export const EMPTY_DATA: BabelData = {
  mode: "conversation",
  sttUrl: "",
  sourceLanguage: "auto",
  translateUrl: "",
  targetLanguage: "en",
  invertScroll: false,
};

export function usesMockStt(data: BabelData): boolean {
  return data.sttUrl.trim() === "";
}

export function translationEnabled(data: BabelData): boolean {
  return data.mode !== "captionOnly" && data.translateUrl.trim() !== "";
}

export async function save(bridge: EvenAppBridge, data: BabelData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

export async function load(bridge: EvenAppBridge): Promise<BabelData> {
  return parseData(await bridge.getLocalStorage(KEY));
}

export interface UrlCheck {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function validateWsUrl(url: string): UrlCheck {
  const trimmed = url.trim();
  if (!trimmed) return { valid: true, errors: [] };   // empty means "use the mock"
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return { valid: false, errors: ["Speech server URL must start with ws:// or wss://."] };
    }
    return { valid: true, errors: [] };
  } catch {
    return { valid: false, errors: ["Speech server URL is not valid."] };
  }
}

export function validateHttpUrl(url: string): UrlCheck {
  const trimmed = url.trim();
  if (!trimmed) return { valid: true, errors: [] };   // empty disables translation
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, errors: ["Translation URL must start with http:// or https://."] };
    }
    return { valid: true, errors: [] };
  } catch {
    return { valid: false, errors: ["Translation URL is not valid."] };
  }
}

export function isPlainHttp(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "ws:";
  } catch {
    return false;
  }
}

export function parseData(raw: string): BabelData {
  if (!raw) return EMPTY_DATA;
  try {
    const value = JSON.parse(raw) as Partial<BabelData>;
    const sttUrl = typeof value.sttUrl === "string" && validateWsUrl(value.sttUrl).valid
      ? value.sttUrl.trim()
      : "";
    const translateUrl = typeof value.translateUrl === "string" && validateHttpUrl(value.translateUrl).valid
      ? value.translateUrl.trim()
      : "";

    return {
      mode: isMode(value.mode) ? value.mode : EMPTY_DATA.mode,
      sttUrl,
      ...(typeof value.sttToken === "string" && value.sttToken ? { sttToken: value.sttToken } : {}),
      sourceLanguage: typeof value.sourceLanguage === "string" && value.sourceLanguage
        ? value.sourceLanguage
        : EMPTY_DATA.sourceLanguage,
      translateUrl,
      ...(typeof value.translateKey === "string" && value.translateKey ? { translateKey: value.translateKey } : {}),
      targetLanguage: typeof value.targetLanguage === "string" && value.targetLanguage
        ? value.targetLanguage
        : EMPTY_DATA.targetLanguage,
      invertScroll: typeof value.invertScroll === "boolean" ? value.invertScroll : false,
    };
  } catch {
    return EMPTY_DATA;
  }
}

function isMode(value: unknown): value is CaptionMode {
  return value === "conversation" || value === "lecture"
    || value === "travel" || value === "captionOnly";
}

/** Shows that a credential exists without revealing it. */
export function maskSecret(secret: string | undefined): string {
  if (!secret) return "none";
  return "set (" + secret.length + " chars)";
}
