/**
 * Server voice for the glasses apps: a Piper TTS server in the user's own
 * network (POST {url}/v1/audio/speech, JSON in, WAV out) sounds much better than
 * the phone WebView voice. Announcements wait in a queue and play one after the
 * other; a more important one drops the less important ones; when the server is
 * slow, down or not configured, the browser voice speaks instead.
 *
 * Audio in a WebView needs a user gesture once: call `unlock()` from a tap.
 * The same <audio> element is reused afterwards, which is what lets later
 * announcements play without another gesture.
 */

export type TtsLang = "de" | "en";

export interface TtsConfig {
  /** Base URL of the server, e.g. https://host:8459. Empty = no server, browser voice only. */
  readonly url: string;
  /** Voice per language; an empty name means "use the browser voice for this language". */
  readonly voices: Readonly<Record<TtsLang, string>>;
  /** Give up on the server after this long (ms) and use the browser voice. Default 8000. */
  readonly timeoutMs?: number;
}

export interface AudioLike {
  src: string;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
}

export interface BrowserVoice {
  readonly available: boolean;
  /** Speak and call `done` when finished (also on error). */
  speak(text: string, lang: TtsLang, done: () => void): void;
  cancel(): void;
}

export interface TtsDeps {
  readonly fetch?: typeof fetch;
  readonly createAudio?: () => AudioLike;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
  readonly browser?: BrowserVoice;
  readonly now?: () => number;
}

export interface SpeakOptions {
  readonly lang?: TtsLang;
  /** Higher drops queued lower ones and interrupts a lower one that is playing. Default 0. */
  readonly priority?: number;
  /** A newer announcement with the same key replaces a queued older one. */
  readonly key?: string;
  /** Not played anymore when it waited longer than this (ms); 0 = never expires. */
  readonly maxAgeMs?: number;
  readonly onStart?: () => void;
  /** Called exactly once: finished, dropped or interrupted. */
  readonly onEnd?: () => void;
}

export type TtsSource = "" | "server" | "browser";

interface Item {
  readonly text: string;
  readonly lang: TtsLang;
  readonly priority: number;
  readonly key: string;
  readonly at: number;
  readonly maxAgeMs: number;
  readonly onStart: (() => void) | undefined;
  readonly onEnd: (() => void) | undefined;
  blob: Promise<Blob | null> | null;
  ctrl: AbortController | null;
  cancelled: boolean;
  ended: boolean;
}

/** Half a second of silence; played inside the tap that unlocks audio. */
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
const PREFETCH = 2;
const FAILURES_BEFORE_PAUSE = 2;
const PAUSE_MS = 60_000;

/** Server address of a private build (`VITE_TTS_URL=https://… npm run build`); empty in the public build. */
export function buildTtsUrl(): string {
  const value = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_TTS_URL;
  return (value ?? "").trim();
}

/** Piper German voice on the server; English has none there, so the browser voice speaks it. */
export const DEFAULT_VOICES: Readonly<Record<TtsLang, string>> = { de: "de-DE-thorsten", en: "" };

export function createBrowserVoice(): BrowserVoice {
  const synthesis = globalThis.speechSynthesis;
  const Utterance = globalThis.SpeechSynthesisUtterance;
  if (!synthesis || !Utterance) return { available: false, speak: (_t, _l, done) => done(), cancel: () => undefined };
  return {
    available: true,
    speak: (text, lang, done) => {
      const utterance = new Utterance(text);
      utterance.lang = lang === "de" ? "de-DE" : "en-US";
      const voice = synthesis.getVoices().find((candidate) => candidate.lang === utterance.lang);
      if (voice) utterance.voice = voice;
      utterance.onend = done;
      utterance.onerror = done;
      synthesis.speak(utterance);
    },
    cancel: () => synthesis.cancel(),
  };
}

export class ServerTts {
  readonly #config: TtsConfig;
  readonly #fetch: typeof fetch;
  readonly #createAudio: () => AudioLike;
  readonly #createUrl: (blob: Blob) => string;
  readonly #revokeUrl: (url: string) => void;
  readonly #browser: BrowserVoice;
  readonly #now: () => number;
  readonly #queue: Item[] = [];
  #current: Item | null = null;
  #audio: AudioLike | null = null;
  #stopPlayback: (() => void) | null = null;
  #pumping = false;
  #unlocked = false;
  #failures = 0;
  #pausedUntil = 0;
  #source: TtsSource = "";

  constructor(config: TtsConfig, deps: TtsDeps = {}) {
    this.#config = { ...config, url: config.url.trim().replace(/\/+$/, "") };
    this.#fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#createAudio = deps.createAudio ?? (() => new Audio() as unknown as AudioLike);
    this.#createUrl = deps.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.#revokeUrl = deps.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    this.#browser = deps.browser ?? createBrowserVoice();
    this.#now = deps.now ?? (() => Date.now());
  }

  /** A server address is set. */
  get configured(): boolean { return this.#config.url !== ""; }
  /** Something can speak: the server or the browser voice. */
  get available(): boolean { return this.configured || this.#browser.available; }
  get unlocked(): boolean { return this.#unlocked; }
  get speaking(): boolean { return this.#current !== null; }
  get pending(): number { return this.#queue.length + (this.#current ? 1 : 0); }
  /** Which voice spoke last. */
  get lastSource(): TtsSource { return this.#source; }

  /** Call from a tap handler: lets the WebView play audio later without a gesture. */
  unlock(): boolean {
    if (this.#unlocked) return true;
    try {
      const audio = this.#audio ?? (this.#audio = this.#createAudio());
      audio.src = SILENCE;
      void audio.play().catch(() => undefined);
      this.#unlocked = true;
    } catch {
      return false;
    }
    return true;
  }

  speak(text: string, options: SpeakOptions = {}): void {
    const clean = text.trim();
    if (clean === "") { options.onEnd?.(); return; }
    const priority = options.priority ?? 0;
    const key = options.key ?? "";
    // Lower priority waiting announcements and older ones with the same key are obsolete now.
    for (const old of [...this.#queue]) {
      if (old.priority < priority || (key !== "" && old.key === key)) this.#drop(old);
    }
    if (this.#current && this.#current.priority < priority) this.#interrupt();
    const item: Item = {
      text: clean, lang: options.lang ?? "de", priority, key, at: this.#now(), maxAgeMs: options.maxAgeMs ?? 0,
      onStart: options.onStart, onEnd: options.onEnd, blob: null, ctrl: null, cancelled: false, ended: false,
    };
    this.#queue.push(item);
    this.#prefetch();
    void this.#pump();
  }

  /** Drop everything and fall silent. */
  stop(): void {
    for (const item of [...this.#queue]) this.#drop(item);
    this.#interrupt();
    this.#browser.cancel();
  }

  #end(item: Item): void {
    if (item.ended) return;
    item.ended = true;
    try { item.onEnd?.(); } catch { /* a listener must never break the queue */ }
  }

  #drop(item: Item): void {
    item.cancelled = true;
    item.ctrl?.abort();
    const index = this.#queue.indexOf(item);
    if (index >= 0) this.#queue.splice(index, 1);
    this.#end(item);
  }

  #interrupt(): void {
    const item = this.#current;
    if (!item) return;
    item.cancelled = true;
    item.ctrl?.abort();
    this.#stopPlayback?.();
    this.#browser.cancel();
  }

  #voiceFor(lang: TtsLang): string {
    return this.#config.voices[lang].trim();
  }

  #serverPaused(): boolean { return this.#now() < this.#pausedUntil; }

  #prefetch(): void {
    if (!this.configured || this.#serverPaused()) return;
    for (const item of this.#queue.slice(0, PREFETCH)) {
      if (item.blob === null && this.#voiceFor(item.lang) !== "") item.blob = this.#download(item);
    }
  }

  async #download(item: Item): Promise<Blob | null> {
    const ctrl = new AbortController();
    item.ctrl = ctrl;
    const timer = setTimeout(() => ctrl.abort(), this.#config.timeoutMs ?? 8000);
    try {
      const response = await this.#fetch(`${this.#config.url}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "tts-1", voice: this.#voiceFor(item.lang), input: item.text }),
        signal: ctrl.signal,
      });
      if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);
      const blob = await response.blob();
      if (blob.size < 64) throw new Error("TTS answer too short");
      this.#failures = 0;
      return blob;
    } catch {
      // A cancelled item is not a server failure.
      if (!item.cancelled) {
        this.#failures += 1;
        if (this.#failures >= FAILURES_BEFORE_PAUSE) this.#pausedUntil = this.#now() + PAUSE_MS;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        const item = this.#queue.shift();
        if (!item) break;
        if (item.cancelled) continue;
        if (item.maxAgeMs > 0 && this.#now() - item.at > item.maxAgeMs) { this.#end(item); continue; }
        this.#current = item;
        this.#prefetch();
        try {
          await this.#play(item);
        } finally {
          this.#current = null;
          this.#end(item);
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #play(item: Item): Promise<void> {
    let blob: Blob | null = null;
    if (this.configured && !this.#serverPaused() && this.#voiceFor(item.lang) !== "") {
      item.blob ??= this.#download(item);
      blob = await item.blob;
    }
    if (item.cancelled) return;
    // It may have waited behind a slow download: a stale announcement is worse than none.
    if (item.maxAgeMs > 0 && this.#now() - item.at > item.maxAgeMs) return;
    item.onStart?.();
    if (blob && await this.#playBlob(item, blob)) { this.#source = "server"; return; }
    if (item.cancelled) return;
    if (!this.#browser.available) return;
    this.#source = "browser";
    await new Promise<void>((resolve) => {
      this.#stopPlayback = resolve;
      this.#browser.speak(item.text, item.lang, resolve);
    });
    this.#stopPlayback = null;
  }

  /** True when the audio played to the end (or was interrupted on purpose). */
  #playBlob(item: Item, blob: Blob): Promise<boolean> {
    const audio = this.#audio ?? (this.#audio = this.#createAudio());
    const url = this.#createUrl(blob);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        this.#stopPlayback = null;
        this.#revokeUrl(url);
        resolve(ok);
      };
      this.#stopPlayback = () => { try { audio.pause(); } catch { /* ignore */ } finish(true); };
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      audio.src = url;
      let started: Promise<void>;
      try { started = audio.play(); } catch { finish(false); return; }
      started.then(() => { if (item.cancelled) this.#stopPlayback?.(); }, () => finish(false));
    });
  }
}
