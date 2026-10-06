import type { AgentEvent } from "../terminal/types";
import { locales, type Locale } from "../i18n";
import { t } from "../messages";

export interface SpeechPreferences {
  readonly spokenOutput: boolean;
  readonly speechLanguage: string;
  readonly speechVoice: string;
  readonly speechRate: number;
}

export type SpeechStatus =
  | "off" | "needs-activation" | "ready" | "speaking" | "paused" | "unavailable";

export interface SpeechVoiceChoice {
  readonly name: string;
  readonly lang: string;
}

interface SpeechRequest {
  readonly text: string;
  readonly language: string;
  readonly voice: string;
  readonly rate: number;
  readonly onStart: () => void;
  readonly onEnd: () => void;
  readonly onError: () => void;
}

export interface SpeechEngine {
  readonly available: boolean;
  voices(): readonly SpeechVoiceChoice[];
  speak(request: SpeechRequest): void;
  cancel(): void;
  pause(): void;
  resume(): void;
}

/** The full tag the narrator speaks in when it follows the app language. */
const UI_SPEECH_TAG: Readonly<Record<Locale, string>> = { de: "de-DE", en: "en-US" };

/**
 * What "Automatic" means for the narrator.
 *
 * The narrator's language is its own setting and never changes with the app
 * language. Only while it is left on "auto" (the stored default, which this
 * function never rewrites) does it follow along:
 *
 * - normally it speaks the phone language, regional variant included
 *   (de-AT stays de-AT, it-IT stays it-IT) — exactly as before;
 * - but when the phone is German or English and the app language was switched
 *   to the other one on the phone page, it follows that choice, so the voice
 *   and the screen agree.
 */
export function resolveSpeechLanguage(setting: string, uiLocale: Locale | undefined, deviceLanguage: string): string {
  if (setting && setting !== "auto") return setting;
  const device = deviceLanguage || "en-US";
  if (!uiLocale) return device;
  const base = device.slice(0, 2).toLowerCase() as Locale;
  return locales.includes(base) && base !== uiLocale ? UI_SPEECH_TAG[uiLocale] : device;
}

/** Which catalogue the narrator's own phrases come from: German voices get German, every other voice English. */
export function speechPhraseLocale(language: string): Locale {
  return language.slice(0, 2).toLowerCase() === "de" ? "de" : "en";
}

function deviceLanguage(): string {
  try { return globalThis.navigator?.language || "en-US"; } catch { return "en-US"; }
}

/** Browser speech synthesis routes through the phone's active audio output. */
export function createBrowserSpeechEngine(): SpeechEngine {
  const synthesis = globalThis.speechSynthesis;
  const Utterance = globalThis.SpeechSynthesisUtterance;

  if (!synthesis || !Utterance) {
    return {
      available: false,
      voices: () => [],
      speak: () => undefined,
      cancel: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
    };
  }

  return {
    available: true,
    voices: () => synthesis.getVoices().map(({ name, lang }) => ({ name, lang })),
    speak: (request) => {
      const utterance = new Utterance(request.text);
      utterance.lang = request.language === "auto" ? deviceLanguage() : request.language;
      utterance.rate = request.rate;
      const voice = synthesis.getVoices().find((candidate) =>
        request.voice ? candidate.name === request.voice : candidate.lang === utterance.lang);
      if (voice) utterance.voice = voice;
      utterance.onstart = request.onStart;
      utterance.onend = request.onEnd;
      utterance.onerror = request.onError;
      synthesis.speak(utterance);
    },
    cancel: () => synthesis.cancel(),
    pause: () => synthesis.pause(),
    resume: () => synthesis.resume(),
  };
}

/**
 * Removes content that is noisy or risky to read aloud.
 *
 * Agent prose stays intact. Code, URLs, commands and credential-looking values
 * are replaced with short labels so headphones do not leak commands or
 * credentials. Private keys and code fences are handled before everything
 * else so a key inside a fence, or a fence still being streamed, is dropped
 * whole rather than read line by line.
 */
export function sanitizeForSpeech(input: string, locale: Locale = "en"): string {
  const omitted = (key: string): string => ` ${t(locale, key)} `;
  return input
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
      omitted("s.privateKey"))
    .replace(/```[\s\S]*?```/g, omitted("s.codeBlock"))
    // An opening fence whose end has not arrived yet: everything after it is code.
    .replace(/```[\s\S]*$/g, omitted("s.codeBlock"))
    .replace(/`[^`\n]+`/g, omitted("s.code"))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, omitted("s.link"))
    .replace(/^\s*\$\s+\S.*$/gm, omitted("s.command"))
    .replace(/\b(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp\d+)\s+AAAA[A-Za-z0-9+/=]+/g, omitted("s.sensitive"))
    .replace(/\b(?:Proxy-)?Authorization\s*:\s*(?:\w+\s+)?\S+/gi, omitted("s.sensitive"))
    .replace(/\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/g,
      (whole, value: string) => (/\d/.test(value) ? omitted("s.sensitive") : whole))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, omitted("s.sensitive"))
    // Environment assignments: `API_KEY=…`, `export TOKEN="…"`, `password: …`.
    .replace(/\b(?:export\s+)?[A-Z][A-Z0-9_]{1,}=\S+/g, omitted("s.setting"))
    .replace(/\b[\w.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|credentials?)\s*[=:]\s*\S+/gi,
      omitted("s.sensitive"))
    .replace(/\b(?:sk|ghp|gho|ghs|ghu|github_pat|glpat|npm|hf|xox[abeoprs]|xapp)[-_][A-Za-z0-9_-]{12,}\b/gi,
      omitted("s.sensitive"))
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, omitted("s.sensitive"))
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, omitted("s.sensitive"))
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, omitted("s.sensitive"))
    // Long base64 / base64url runs with both letters and digits. Plain words
    // and paths without digits are left alone.
    .replace(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}/g,
      (run) => (/[0-9]/.test(run) && /[A-Za-z]/.test(run) ? omitted("s.sensitive") : run))
    .replace(/^\s{0,3}[#>*+-]+\s*/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fenceCount(text: string): number {
  return text.match(/```/g)?.length ?? 0;
}

/** Tracks a streamed response and emits only newly completed sentences. */
export class SentenceBuffer {
  #source = "";
  #pending = "";
  readonly #locale: () => Locale;

  /** `locale` picks the language of the "… omitted" labels. */
  constructor(locale: () => Locale = () => "en") {
    this.#locale = locale;
  }

  reset(): void { this.#source = ""; this.#pending = ""; }

  append(fragment: string): readonly string[] {
    this.#source += fragment;
    this.#pending += fragment;
    return this.#drain(false);
  }

  replace(fullText: string): readonly string[] {
    if (fullText.startsWith(this.#source)) return this.append(fullText.slice(this.#source.length));
    this.#source = fullText;
    this.#pending = fullText;
    return this.#drain(false);
  }

  finish(): readonly string[] { return this.#drain(true); }

  #drain(flushAll: boolean): readonly string[] {
    const output: string[] = [];
    // A full stop only ends a sentence once whitespace follows it. A delta
    // that happens to end on "." may be the middle of a version number, a
    // file name or a dotted token such as a JWT; `finish` flushes the rest.
    const boundary = /[.!?](?:["')\]]*)?\s+|\n{2,}/g;
    let from = 0;
    for (;;) {
      boundary.lastIndex = from;
      const match = boundary.exec(this.#pending);
      if (!match) break;
      const end = match.index + match[0].length;
      // Never cut inside an open code fence: the first half would no longer
      // look like code and its contents would be read aloud.
      if (fenceCount(this.#pending.slice(0, end)) % 2 === 1) { from = end; continue; }
      const clean = sanitizeForSpeech(this.#pending.slice(0, end), this.#locale());
      if (clean) output.push(clean);
      this.#pending = this.#pending.slice(end);
      from = 0;
    }
    if (flushAll) {
      const clean = sanitizeForSpeech(this.#pending, this.#locale());
      if (clean) output.push(clean);
      this.#pending = "";
    }
    return output;
  }
}

export class AgentNarrator {
  readonly #engine: SpeechEngine;
  readonly #preferences: () => SpeechPreferences;
  readonly #uiLocale: (() => Locale) | undefined;
  readonly #buffer = new SentenceBuffer(() => this.#phraseLocale());
  #armed = false;
  #phase: SpeechStatus = "off";
  #lastText = "";
  #queued = 0;

  /**
   * `uiLocale` is the app language; it only matters while the speech
   * language is "auto" (see `resolveSpeechLanguage`).
   */
  constructor(engine: SpeechEngine, preferences: () => SpeechPreferences, uiLocale?: () => Locale) {
    this.#engine = engine;
    this.#preferences = preferences;
    this.#uiLocale = uiLocale;
  }

  /** The tag actually handed to the speech engine. */
  language(): string {
    return resolveSpeechLanguage(this.#preferences().speechLanguage, this.#uiLocale?.(), deviceLanguage());
  }

  #phraseLocale(): Locale { return speechPhraseLocale(this.language()); }

  #phrase(key: string, vars: Record<string, string | number> = {}): string {
    return t(this.#phraseLocale(), key, vars);
  }

  status(): SpeechStatus {
    if (!this.#engine.available) return "unavailable";
    if (!this.#preferences().spokenOutput) return "off";
    if (!this.#armed) return "needs-activation";
    return this.#phase;
  }

  voices(): readonly SpeechVoiceChoice[] { return this.#engine.voices(); }

  activate(): boolean {
    if (!this.#engine.available) return false;
    this.#armed = true;
    this.#phase = "ready";
    this.#say(this.#phrase("s.ready"));
    return true;
  }

  stop(): void {
    this.#engine.cancel();
    this.#armed = false;
    this.#queued = 0;
    this.#phase = "off";
    this.#buffer.reset();
  }

  remember(text: string): void { this.#lastText = sanitizeForSpeech(text, this.#phraseLocale()); }

  accept(event: AgentEvent): void {
    if (event.kind === "user_prompt") { this.#buffer.reset(); return; }

    if (event.kind === "text_delta") {
      this.#speakAll(this.#buffer.append(event.text));
      return;
    }
    if (event.kind === "text") {
      this.remember(event.text);
      this.#speakAll(this.#buffer.replace(event.text));
      return;
    }
    if (event.kind === "result") {
      this.#speakAll(this.#buffer.finish());
      return;
    }
    if (event.kind === "permission_request") {
      this.#say(this.#phrase("s.permission", { tool: event.tool ?? this.#phrase("s.aTool") }));
      return;
    }
    if (event.kind === "user_question") {
      this.#say(this.#phrase("s.question"));
      return;
    }
    if (event.kind === "error") this.#say(this.#phrase("s.error"));
  }

  replay(): void {
    if (this.#lastText) this.#say(this.#lastText);
  }

  togglePause(): void {
    if (!this.#armed) return;
    if (this.#phase === "paused") {
      this.#engine.resume();
      this.#phase = this.#queued > 0 ? "speaking" : "ready";
    } else {
      this.#engine.pause();
      this.#phase = "paused";
    }
  }

  #speakAll(chunks: readonly string[]): void {
    for (const chunk of chunks) this.#say(chunk);
  }

  #say(text: string): void {
    const clean = sanitizeForSpeech(text, this.#phraseLocale());
    if (!clean || !this.#armed || !this.#preferences().spokenOutput) return;
    this.#lastText = clean;
    this.#queued += 1;
    const preferences = this.#preferences();
    this.#engine.speak({
      text: clean.slice(0, 800),
      language: this.language(),
      voice: preferences.speechVoice,
      rate: preferences.speechRate,
      onStart: () => { this.#phase = "speaking"; },
      onEnd: () => {
        this.#queued = Math.max(0, this.#queued - 1);
        if (this.#phase !== "paused") this.#phase = this.#queued > 0 ? "speaking" : "ready";
      },
      onError: () => {
        this.#queued = Math.max(0, this.#queued - 1);
        if (this.#phase !== "paused") this.#phase = this.#queued > 0 ? "speaking" : "ready";
      },
    });
  }
}
