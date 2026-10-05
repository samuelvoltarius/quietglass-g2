import type { AgentEvent } from "../terminal/types";

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
      utterance.lang = request.language === "auto"
        ? (globalThis.navigator?.language || "en-US") : request.language;
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
 * Agent prose stays intact. Code, URLs and token-looking values are replaced
 * with short labels so headphones do not leak commands or credentials.
 */
export function sanitizeForSpeech(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .replace(/`[^`\n]+`/g, " code omitted ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " link omitted ")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gi, " sensitive value omitted ")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, " sensitive value omitted ")
    .replace(/^\s{0,3}[#>*+-]+\s*/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tracks a streamed response and emits only newly completed sentences. */
export class SentenceBuffer {
  #source = "";
  #pending = "";

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
    const boundary = /[.!?](?:["')\]]*)?(?:\s+|$)|\n{2,}/;
    let match = boundary.exec(this.#pending);
    while (match) {
      const end = match.index + match[0].length;
      const clean = sanitizeForSpeech(this.#pending.slice(0, end));
      if (clean) output.push(clean);
      this.#pending = this.#pending.slice(end);
      match = boundary.exec(this.#pending);
    }
    if (flushAll) {
      const clean = sanitizeForSpeech(this.#pending);
      if (clean) output.push(clean);
      this.#pending = "";
    }
    return output;
  }
}

export class AgentNarrator {
  readonly #engine: SpeechEngine;
  readonly #preferences: () => SpeechPreferences;
  readonly #buffer = new SentenceBuffer();
  #armed = false;
  #phase: SpeechStatus = "off";
  #lastText = "";
  #queued = 0;

  constructor(engine: SpeechEngine, preferences: () => SpeechPreferences) {
    this.#engine = engine;
    this.#preferences = preferences;
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
    this.#say("Spoken output ready.");
    return true;
  }

  stop(): void {
    this.#engine.cancel();
    this.#armed = false;
    this.#queued = 0;
    this.#phase = "off";
    this.#buffer.reset();
  }

  remember(text: string): void { this.#lastText = sanitizeForSpeech(text); }

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
      this.#say(`Permission required for ${event.tool ?? "a tool"}. Check the glasses.`);
      return;
    }
    if (event.kind === "user_question") {
      this.#say("The agent has a question. Check the glasses.");
      return;
    }
    if (event.kind === "error") this.#say("The agent reported an error. Check the glasses.");
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
    const clean = sanitizeForSpeech(text);
    if (!clean || !this.#armed || !this.#preferences().spokenOutput) return;
    this.#lastText = clean;
    this.#queued += 1;
    const preferences = this.#preferences();
    this.#engine.speak({
      text: clean.slice(0, 800),
      language: preferences.speechLanguage,
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
