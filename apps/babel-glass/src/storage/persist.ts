import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { CaptionMode } from "../glasses/view";
import { AUTO, normalizeLanguageCode } from "../text/languages";
import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * Configuration, stored in the Even app's per-app storage on the phone.
 *
 * No captions and no audio are ever written here. The transcript exists in
 * memory for the session and is gone when the app closes — a record of
 * everything said around someone is not something this app is willing to keep.
 */

/** Which translation backend to talk to. */
export type TranslateProvider = "libretranslate" | "openai";

export interface BabelData {
  readonly mode: CaptionMode;
  /** WebSocket URL of the speech recognition server. Empty means use the mock. */
  readonly sttUrl: string;
  readonly sttToken?: string;
  /** BCP-47 source language or "auto". */
  readonly sourceLanguage: string;

  readonly translateProvider: TranslateProvider;
  /** LibreTranslate-compatible endpoint. Empty disables that provider. */
  readonly translateUrl: string;
  readonly translateKey?: string;
  /** OpenAI-compatible base URL (…/v1). Empty disables that provider. */
  readonly llmUrl: string;
  readonly llmModel: string;
  readonly llmKey?: string;
  readonly targetLanguage: string;

  /** Show the original line on the glasses in Latin letters. */
  readonly transliterateOriginal: boolean;
  readonly invertScroll: boolean;
}

/**
 * Storage key. Still v1: every field added since is optional on read, so data
 * written by 0.1.0 loads unchanged.
 */
const KEY = "quietglass.babelglass.v1";

export const EMPTY_DATA: BabelData = {
  mode: "conversation",
  sttUrl: "",
  sourceLanguage: AUTO,
  translateProvider: "libretranslate",
  translateUrl: "",
  llmUrl: "",
  llmModel: "",
  targetLanguage: "en",
  transliterateOriginal: false,
  invertScroll: false,
};

export function usesMockStt(data: BabelData): boolean {
  return data.sttUrl.trim() === "";
}

/** True when the selected provider has what it needs to run. */
export function translationConfigured(data: BabelData): boolean {
  if (data.translateProvider === "openai") {
    return data.llmUrl.trim() !== "" && data.llmModel.trim() !== "";
  }
  return data.translateUrl.trim() !== "";
}

export function translationEnabled(data: BabelData): boolean {
  return data.mode !== "captionOnly" && translationConfigured(data);
}

export async function save(bridge: EvenAppBridge, data: BabelData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

export async function load(bridge: EvenAppBridge): Promise<BabelData> {
  return parseData(await bridge.getLocalStorage(KEY));
}

export interface UrlCheck {
  readonly valid: boolean;
  /** Message keys (src/messages.ts), translated where they are shown. */
  readonly errors: readonly string[];
}

export function validateWsUrl(url: string): UrlCheck {
  const trimmed = url.trim();
  if (!trimmed) return { valid: true, errors: [] };   // empty means "use the mock"
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return { valid: false, errors: ["e.wsScheme"] };
    }
    return { valid: true, errors: [] };
  } catch {
    return { valid: false, errors: ["e.wsInvalid"] };
  }
}

export function validateHttpUrl(url: string, field: "translate" | "llm" = "translate"): UrlCheck {
  const trimmed = url.trim();
  if (!trimmed) return { valid: true, errors: [] };   // empty disables translation
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, errors: ["e." + field + "Scheme"] };
    }
    return { valid: true, errors: [] };
  } catch {
    return { valid: false, errors: ["e." + field + "Invalid"] };
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
    const value = JSON.parse(raw) as Partial<Record<keyof BabelData, unknown>> | null;
    if (!value || typeof value !== "object") return EMPTY_DATA;

    const sttUrl = typeof value.sttUrl === "string" && validateWsUrl(value.sttUrl).valid
      ? value.sttUrl.trim()
      : "";
    const translateUrl = typeof value.translateUrl === "string" && validateHttpUrl(value.translateUrl).valid
      ? value.translateUrl.trim()
      : "";
    const llmUrl = typeof value.llmUrl === "string" && validateHttpUrl(value.llmUrl).valid
      ? value.llmUrl.trim()
      : "";

    // Languages were free text in 0.1.0: "RU", " de ", "pt_BR" are
    // normalised; anything unusable falls back to the default.
    const source = normalizeLanguageCode(value.sourceLanguage);
    const target = normalizeLanguageCode(value.targetLanguage);

    return {
      mode: isMode(value.mode) ? value.mode : EMPTY_DATA.mode,
      sttUrl,
      ...(typeof value.sttToken === "string" && value.sttToken ? { sttToken: value.sttToken } : {}),
      sourceLanguage: source ?? EMPTY_DATA.sourceLanguage,
      translateProvider: value.translateProvider === "openai" ? "openai" : "libretranslate",
      translateUrl,
      ...(typeof value.translateKey === "string" && value.translateKey ? { translateKey: value.translateKey } : {}),
      llmUrl,
      llmModel: typeof value.llmModel === "string" ? value.llmModel.trim() : "",
      ...(typeof value.llmKey === "string" && value.llmKey ? { llmKey: value.llmKey } : {}),
      // A target of "auto" is meaningless.
      targetLanguage: target && target !== AUTO ? target : EMPTY_DATA.targetLanguage,
      transliterateOriginal: value.transliterateOriginal === true,
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
export function maskSecret(secret: string | undefined, locale: Locale = "en"): string {
  if (!secret) return t(locale, "p.secretNone");
  return t(locale, "p.secretSet", { count: secret.length });
}
