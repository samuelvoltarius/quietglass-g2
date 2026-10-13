/**
 * Reads agent answers aloud through the phone's current audio route (AirPods,
 * Bluetooth headphones). Engine, sanitizer and sentence buffer come from Agent
 * Glass; the HubNarrator below follows the agent shown on the glasses.
 */
import type { Locale } from "../i18n";
import type { AgentInfo, Approval } from "../api/types";
import type { ServerTts } from "./server-tts";

const PHRASES: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  de: {
    "s.ready": "Vorlesen ist bereit.", "s.permission": "Freigabe nötig für {tool}. Schau auf die Brille.", "s.aTool": "ein Werkzeug",
    "s.error": "Der Agent meldet einen Fehler.", "s.privateKey": "privater Schlüssel ausgelassen", "s.codeBlock": "Codeblock ausgelassen.",
    "s.code": "Code ausgelassen", "s.link": "Link ausgelassen", "s.command": "Befehl ausgelassen", "s.sensitive": "vertraulicher Wert ausgelassen",
    "s.setting": "Einstellung ausgelassen",
  },
  en: {
    "s.ready": "Spoken output ready.", "s.permission": "Permission required for {tool}. Check the glasses.", "s.aTool": "a tool",
    "s.error": "The agent reported an error.", "s.privateKey": "private key omitted", "s.codeBlock": "Code block omitted.",
    "s.code": "code omitted", "s.link": "link omitted", "s.command": "command omitted", "s.sensitive": "sensitive value omitted",
    "s.setting": "setting omitted",
  },
};
function t(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  return (PHRASES[locale][key] ?? key).replace(/\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? ""));
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
 * Speaks through the server voice (Piper) and falls back to the browser voice
 * when the server is slow, down or not set up; see server-tts.ts.
 */
export function createServerSpeechEngine(browser: SpeechEngine, tts: ServerTts): SpeechEngine {
  return {
    get available(): boolean { return tts.available || browser.available; },
    voices: () => browser.voices(),
    speak: (request) => tts.speak(request.text, {
      lang: request.language.toLowerCase().startsWith("en") ? "en" : "de",
      onStart: request.onStart,
      onEnd: request.onEnd,
    }),
    cancel: () => tts.stop(),
    pause: () => browser.pause(),
    resume: () => browser.resume(),
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

/** Which phone speech tag a UI locale speaks in. */
const SPEECH_TAG: Readonly<Record<Locale, string>> = { de: "de-DE", en: "en-US" };

/**
 * Follows the agent on the glasses: new sentences of its answer are spoken as
 * they stream in, the rest when it finishes; a new permission card is
 * announced. Browsers only allow speech after a user gesture, so it must be
 * activated once from the phone page.
 */
export class HubNarrator {
  readonly #engine: SpeechEngine;
  readonly #enabled: () => boolean;
  readonly #locale: () => Locale;
  readonly #buffer: SentenceBuffer;
  #armed = false;
  #speaking = 0;
  #key = "";
  #wasBusy = false;
  #seenApprovals = new Set<string>();
  #primed = false;
  #last = "";

  constructor(engine: SpeechEngine, enabled: () => boolean, locale: () => Locale) {
    this.#engine = engine;
    this.#enabled = enabled;
    this.#locale = locale;
    this.#buffer = new SentenceBuffer(locale);
  }

  status(): SpeechStatus {
    if (!this.#engine.available) return "unavailable";
    if (!this.#enabled()) return "off";
    if (!this.#armed) return "needs-activation";
    return this.#speaking > 0 ? "speaking" : "ready";
  }

  /** Must run inside a tap handler on the phone page. */
  activate(): boolean {
    if (!this.#engine.available) return false;
    this.#armed = true;
    this.#say(t(this.#locale(), "s.ready"));
    return true;
  }

  stop(): void {
    this.#engine.cancel();
    this.#speaking = 0;
  }

  replay(): void {
    if (this.#last !== "") this.#say(this.#last);
  }

  /** Feed every fresh report: the agent in focus and the open permission cards. */
  observe(agent: AgentInfo | undefined, approvals: readonly Approval[]): void {
    for (const card of approvals) {
      if (this.#seenApprovals.has(card.id)) continue;
      this.#seenApprovals.add(card.id);
      if (this.#primed) this.#say(t(this.#locale(), "s.permission", { tool: card.tool || t(this.#locale(), "s.aTool") }));
    }
    if (agent === undefined) return;
    const key = `${agent.id}|${agent.session?.id ?? ""}|${agent.lastQuestion ?? ""}`;
    const answer = agent.answer ?? "";
    if (key !== this.#key) {
      // A different agent, session or question: start over, never re-read an old answer.
      this.#key = key;
      this.#buffer.reset();
      this.#buffer.replace(answer);
      if (!agent.busy || !this.#primed) this.#buffer.finish();
      this.#wasBusy = agent.busy;
      this.#primed = true;
      return;
    }
    this.#speakAll(this.#buffer.replace(answer));
    if (this.#wasBusy && !agent.busy) {
      this.#speakAll(this.#buffer.finish());
      if (agent.error !== null && answer === "") this.#say(t(this.#locale(), "s.error"));
      this.#last = sanitizeForSpeech(answer, this.#locale());
    }
    this.#wasBusy = agent.busy;
  }

  #speakAll(chunks: readonly string[]): void {
    for (const chunk of chunks) this.#say(chunk);
  }

  #say(text: string): void {
    const clean = sanitizeForSpeech(text, this.#locale());
    if (clean === "" || !this.#armed || !this.#enabled()) return;
    this.#speaking += 1;
    const done = (): void => { this.#speaking = Math.max(0, this.#speaking - 1); };
    this.#engine.speak({ text: clean.slice(0, 800), language: SPEECH_TAG[this.#locale()], voice: "", rate: 1, onStart: () => undefined, onEnd: done, onError: done });
  }
}
