import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { CaptionMode } from "../glasses/view";
import { AUTO, normalizeLanguageCode } from "../text/languages";
import type { Locale } from "../i18n";
import { t } from "../messages";
import type { TranscriptEntry } from "../companion/transcript";
import type { SpeakerChoice } from "../companion/wordfinder";
import { clampPersons, PERSONS_DEFAULT } from "../stt/voice";
import { parseVocab, VOCAB_CAP, type VocabEntry } from "../companion/vocab";

/**
 * Configuration, stored in the Even app's per-app storage on the phone.
 *
 * No audio is ever written here. The transcript exists in memory for the
 * session and is gone when the app closes — unless the user switches on
 * "keep the last transcript" (off by default), see `saveConversation`.
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

  /** Conversation companion (0.3.0): speaker labels, popups, summary on stop. */
  readonly speakers: boolean;
  readonly insights: boolean;
  readonly autoSummary: boolean;
  /** Keep the last transcript (and summary) on the phone across the lock and a restart. Off by default. */
  readonly keepTranscript: boolean;
  /** Wortfinder (0.4.0): which speaker letter is the user ("auto" = whoever spoke last). */
  readonly mySpeaker: SpeakerChoice;
  /**
   * Babel's own memory (0.4.0): store each summary (with agreements) on the
   * babel-llm-proxy and let the companion use it. Never any other store.
   */
  readonly memory: boolean;
  /** Antwort-Vorschläge (0.5.0): propose one short reply to the other person. On by default. */
  readonly replySuggestions: boolean;
  /**
   * Meine Sätze übersetzen (0.5.0): the user's own lines (own language = the
   * translation target) are translated INTO the conversation language. Off by default.
   */
  readonly translateOwn: boolean;
  /**
   * 0.6.3: the mode picked on the glasses or the phone ("client" =
   * Kundengespräch, "translate" = Übersetzen). Absent = not picked yet: client
   * when Shoot Day reports a customer, else translate (see companion/talkmode).
   */
  readonly talkMode?: "client" | "translate" | "learn";
  /** Tipp-Karten (Kundengespräch): short live tip cards on the glasses. Absent = on; only `false` is stored. */
  readonly cueCards?: boolean;
  /** 0.8.0: people in the conversation, the user included ("Personen: 2-5" in the side menu). */
  readonly persons: number;
  /**
   * 0.8.0: the user's voice is enrolled on the speech server ("Meine Stimme lernen").
   * Only this flag lives here; the voice print itself stays on the server.
   */
  readonly voiceEnrolled: boolean;
  /** 0.9.0: "Wortfinder automatisch": look for the word by itself when the user gets stuck. On by default. */
  readonly wordAuto: boolean;
  /** 1.0.0 "Englisch sprechen": translate the other person into German on the glasses. On by default. */
  readonly learnTranslate: boolean;
  /**
   * 1.1.1 "Sprecher erkennen (Brille)": use the glasses' own speaker role (SDK 0.0.16, self/other per audio
   * frame) to mark "Ich"/"Gegenüber" and to gate the word finder. Absent = on; only `false` is stored.
   */
  readonly speakerRole?: boolean;
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
  speakers: true,
  insights: true,
  autoSummary: true,
  keepTranscript: false,
  mySpeaker: "auto",
  memory: true,
  replySuggestions: true,
  translateOwn: false,
  persons: PERSONS_DEFAULT,
  voiceEnrolled: false,
  wordAuto: true,
  learnTranslate: true,
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

/** Summary and popups need an OpenAI-compatible server, whatever translates. */
export function companionConfigured(data: BabelData): boolean {
  return data.llmUrl.trim() !== "" && data.llmModel.trim() !== "";
}

export function translationEnabled(data: BabelData): boolean {
  // 0.6.3: Kundengespräch shows the German captions only, never a translation.
  // 1.0.0: "Englisch sprechen" translates the other person into German only when the phone switch says so.
  if (data.talkMode === "learn" && !data.learnTranslate) return false;
  return data.talkMode !== "client" && data.mode !== "captionOnly" && translationConfigured(data);
}

export async function save(bridge: EvenAppBridge, data: BabelData): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(data));
}

export async function load(bridge: EvenAppBridge): Promise<BabelData> {
  return withBuildDefaults(parseData(await bridge.getLocalStorage(KEY)));
}

/**
 * Servers a private build ships with (set at build time, never in the repo):
 * VITE_BABEL_STT (wss://…), VITE_BABEL_LLM (…/v1), VITE_BABEL_MODEL.
 */
export interface BuildDefaults { readonly stt?: string; readonly llm?: string; readonly model?: string }
const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
export const BUILD_DEFAULTS: BuildDefaults = {
  ...(ENV.VITE_BABEL_STT ? { stt: ENV.VITE_BABEL_STT } : {}),
  ...(ENV.VITE_BABEL_LLM ? { llm: ENV.VITE_BABEL_LLM } : {}),
  ...(ENV.VITE_BABEL_MODEL ? { model: ENV.VITE_BABEL_MODEL } : {}),
};

/** Empty server fields fall back to the build's own servers, so a private build works without typing anything. */
export function withBuildDefaults(data: BabelData, defaults: BuildDefaults = BUILD_DEFAULTS): BabelData {
  let next = data;
  if (next.sttUrl.trim() === "" && defaults.stt) next = { ...next, sttUrl: defaults.stt };
  if (!translationConfigured(next) && defaults.llm) {
    next = { ...next, translateProvider: "openai", llmUrl: defaults.llm, llmModel: next.llmModel.trim() || defaults.model || "qwen" };
  }
  // The companion (summary, popups) uses the LLM even when LibreTranslate translates.
  if (!companionConfigured(next) && defaults.llm && next.llmUrl.trim() === "") {
    next = { ...next, llmUrl: defaults.llm, llmModel: next.llmModel.trim() || defaults.model || "qwen" };
  }
  return next;
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
      // New in 0.3.0: absent in older settings = on.
      speakers: value.speakers !== false,
      insights: value.insights !== false,
      autoSummary: value.autoSummary !== false,
      // New in 0.3.1: opt-in, absent = off.
      keepTranscript: value.keepTranscript === true,
      // New in 0.4.0.
      mySpeaker: value.mySpeaker === "A" || value.mySpeaker === "B" ? value.mySpeaker : "auto",
      memory: value.memory !== false,
      // New in 0.5.0.
      replySuggestions: value.replySuggestions !== false,
      translateOwn: value.translateOwn === true,
      // New in 0.6.3: absent = not picked yet.
      ...(value.talkMode === "client" || value.talkMode === "translate" || value.talkMode === "learn" ? { talkMode: value.talkMode } : {}),
      // Tipp-Karten: absent = on.
      ...(value.cueCards === false ? { cueCards: false } : {}),
      // New in 0.8.0.
      persons: clampPersons(value.persons),
      voiceEnrolled: value.voiceEnrolled === true,
      // New in 0.9.0: absent = on.
      wordAuto: value.wordAuto !== false,
      // New in 1.0.0: absent = on.
      learnTranslate: value.learnTranslate !== false,
      // New in 1.1.1: absent = on.
      ...(value.speakerRole === false ? { speakerRole: false } : {}),
    };
  } catch {
    return EMPTY_DATA;
  }
}

/**
 * The last conversation, kept only when the user switched "keep the last
 * transcript" on: the phone lock (after ~5 min the WebView is restarted) must
 * not wipe what was just said. Capped, and cleared with the transcript.
 */
const CONVERSATION_KEY = "quietglass.babelglass.conversation.v1";
export const KEPT_LINES = 300;

export interface KeptConversation {
  readonly log: readonly TranscriptEntry[];
  readonly summary: { readonly short: readonly string[]; readonly long: readonly string[]; readonly agreements?: readonly string[] } | null;
}

export async function saveConversation(bridge: EvenAppBridge, conversation: KeptConversation | null): Promise<void> {
  const value = conversation === null || (conversation.log.length === 0 && conversation.summary === null)
    ? ""
    : JSON.stringify({ log: conversation.log.slice(-KEPT_LINES), summary: conversation.summary });
  await bridge.setLocalStorage(CONVERSATION_KEY, value);
}

export async function loadConversation(bridge: EvenAppBridge): Promise<KeptConversation | null> {
  return parseConversation(await bridge.getLocalStorage(CONVERSATION_KEY));
}

export function parseConversation(raw: string): KeptConversation | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { log?: unknown; summary?: unknown } | null;
    if (!value || typeof value !== "object") return null;
    const strings = (list: unknown): string[] =>
      Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
    const log = Array.isArray(value.log)
      ? value.log.flatMap((item): TranscriptEntry[] => {
          if (!item || typeof item !== "object") return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry.text !== "string" || !entry.text.trim() || typeof entry.at !== "number") return [];
          return [{
            text: entry.text,
            at: entry.at,
            ...(typeof entry.speaker === "string" ? { speaker: entry.speaker } : {}),
            ...(typeof entry.language === "string" ? { language: entry.language } : {}),
            ...(typeof entry.translated === "string" ? { translated: entry.translated } : {}),
            ...(typeof entry.own === "string" ? { own: entry.own } : {}),
            ...(typeof entry.reply === "string" ? { reply: entry.reply } : {}),
          }];
        }).slice(-KEPT_LINES)
      : [];
    const rawSummary = value.summary as { short?: unknown; long?: unknown } | null | undefined;
    const summary = rawSummary && typeof rawSummary === "object" && strings(rawSummary.short).length > 0
      ? { short: strings(rawSummary.short), long: strings(rawSummary.long) }
      : null;
    if (log.length === 0 && summary === null) return null;
    return { log, summary };
  } catch {
    return null;
  }
}

/**
 * 0.9.0 "Meine Wörter": the words the word finder found, newest first, capped.
 * Kept on the phone until the user deletes them (one by one or all).
 */
const VOCAB_KEY = "quietglass.babelglass.words.v1";

export async function saveVocab(bridge: EvenAppBridge, words: readonly VocabEntry[]): Promise<void> {
  await bridge.setLocalStorage(VOCAB_KEY, words.length === 0 ? "" : JSON.stringify(words.slice(0, VOCAB_CAP)));
}

export async function loadVocab(bridge: EvenAppBridge): Promise<VocabEntry[]> {
  return parseVocab(await bridge.getLocalStorage(VOCAB_KEY));
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
