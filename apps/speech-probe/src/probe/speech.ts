import type { Lang, ResultA } from "./results";

/**
 * Test A: is the platform speech recognition (Web Speech API) usable inside the
 * Even app WebView? Runs entirely on the phone (phone microphone), started by a
 * button on the phone page because iOS only allows it from a user gesture.
 *
 * Caution, unverifiable here: on iOS a WKWebView host app without
 * NSSpeechRecognitionUsageDescription / NSMicrophoneUsageDescription may be
 * killed by the system the moment recognition asks for permission. The caller
 * flushes the step log before start(), so a crash still leaves "testAStart"
 * without a "testA" behind it.
 */

/** Recognition gives up after this long without an "end" (a stuck session). */
export const RECOGNITION_TIMEOUT_MS = 15_000;
const VOICES_WAIT_MS = 2_000;

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onstart: ((e: unknown) => void) | null;
  onaudiostart: ((e: unknown) => void) | null;
  onsoundstart: ((e: unknown) => void) | null;
  onspeechstart: ((e: unknown) => void) | null;
  onspeechend: ((e: unknown) => void) | null;
  onaudioend: ((e: unknown) => void) | null;
  onresult: ((e: unknown) => void) | null;
  onnomatch: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: ((e: unknown) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => RecognitionLike;

/** The bits of `window` the probe reads; injectable for tests. */
export interface SpeechEnv {
  readonly SpeechRecognition?: unknown;
  readonly webkitSpeechRecognition?: unknown;
  readonly speechSynthesis?: {
    getVoices(): ArrayLike<{ lang: string }>;
    addEventListener?(type: "voiceschanged", fn: () => void): void;
    removeEventListener?(type: "voiceschanged", fn: () => void): void;
  };
  readonly navigator: {
    readonly userAgent: string;
    readonly mediaDevices?: { getUserMedia?: unknown };
    readonly permissions?: { query(d: { name: string }): Promise<{ state: string }> };
  };
  readonly isSecureContext?: boolean;
  readonly location?: { protocol: string };
}

export interface VoiceInfo {
  readonly count: number;
  readonly langs: string;
  readonly de: number;
  readonly en: number;
}

/** Voices of speechSynthesis; waits briefly for "voiceschanged" when the list starts empty (WebKit loads lazily). */
export async function voiceInfo(env: SpeechEnv, waitMs = VOICES_WAIT_MS): Promise<VoiceInfo> {
  const synth = env.speechSynthesis;
  if (!synth) return { count: 0, langs: "no speechSynthesis", de: 0, en: 0 };
  let voices = Array.from(synth.getVoices());
  if (voices.length === 0 && synth.addEventListener) {
    await new Promise<void>((done) => {
      const timer = setTimeout(finish, waitMs);
      function finish(): void { clearTimeout(timer); synth?.removeEventListener?.("voiceschanged", finish); done(); }
      synth.addEventListener?.("voiceschanged", finish);
    });
    voices = Array.from(synth.getVoices());
  }
  return summarizeVoices(voices);
}

export function summarizeVoices(voices: ReadonlyArray<{ lang: string }>): VoiceInfo {
  const langs = [...new Set(voices.map((v) => v.lang).filter(Boolean))].sort();
  const starts = (prefix: string): number => voices.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(prefix)).length;
  return { count: voices.length, langs: langs.join(","), de: starts("de"), en: starts("en") };
}

async function permissionState(env: SpeechEnv): Promise<string> {
  try {
    if (!env.navigator.permissions) return "n/a";
    return (await env.navigator.permissions.query({ name: "microphone" })).state;
  } catch (error) {
    return `n/a (${errorName(error)})`;
  }
}

export function errorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && typeof (error as { name: unknown }).name === "string") return (error as { name: string }).name;
  return String(error);
}

export function recognitionLang(lang: Lang): string {
  return lang === "de" ? "de-DE" : "en-US";
}

export interface SpeechProgress {
  (stage: string): void;
}

/**
 * Runs one recognition attempt and reports everything it saw. Never rejects.
 * `promptSeen` is filled in later by the tester on the phone page.
 */
export async function runSpeechTest(env: SpeechEnv, lang: Lang, onProgress: SpeechProgress = () => undefined, timeoutMs = RECOGNITION_TIMEOUT_MS): Promise<ResultA> {
  const begun = Date.now();
  const Ctor = (env.SpeechRecognition ?? env.webkitSpeechRecognition) as RecognitionCtor | undefined;
  const base = {
    at: new Date(begun).toISOString(),
    lang,
    userAgent: env.navigator.userAgent,
    secureContext: env.isSecureContext === true,
    protocol: env.location?.protocol ?? "?",
    hasSpeechRecognition: typeof env.SpeechRecognition === "function",
    hasWebkitSpeechRecognition: typeof env.webkitSpeechRecognition === "function",
    hasGetUserMedia: typeof env.navigator.mediaDevices?.getUserMedia === "function",
    promptSeen: "?" as const,
  };
  const voicesPromise = voiceInfo(env);
  const permissionBefore = await permissionState(env);

  const events: string[] = [];
  const errors: string[] = [];
  let errorMessage = "";
  let transcript = "";
  let confidence: number | null = null;
  let isFinal = false;
  let audioStartMs: number | null = null;
  let started = false;

  if (typeof Ctor === "function") {
    onProgress("starting");
    await new Promise<void>((done) => {
      let finished = false;
      let rec: RecognitionLike;
      const startedAt = Date.now();
      const mark = (name: string): void => { events.push(`${name}@${Date.now() - startedAt}`); };
      const finish = (): void => { if (!finished) { finished = true; clearTimeout(timer); done(); } };
      const timer = setTimeout(() => {
        mark("timeout");
        try { rec?.stop(); } catch { /* already gone */ }
        // Give "end" a moment, then stop waiting regardless.
        setTimeout(finish, 1500);
      }, timeoutMs);
      try {
        rec = new Ctor();
        rec.lang = recognitionLang(lang);
        rec.interimResults = true;
        rec.continuous = false;
        rec.maxAlternatives = 1;
        rec.onstart = () => { mark("start"); onProgress("listening – speak now"); };
        rec.onaudiostart = () => { mark("audiostart"); audioStartMs ??= Date.now() - startedAt; };
        rec.onsoundstart = () => mark("soundstart");
        rec.onspeechstart = () => mark("speechstart");
        rec.onspeechend = () => mark("speechend");
        rec.onaudioend = () => mark("audioend");
        rec.onnomatch = () => mark("nomatch");
        rec.onresult = (e: unknown) => {
          mark("result");
          const read = readResult(e);
          if (read) { transcript = read.transcript; confidence = read.confidence; isFinal = read.isFinal; onProgress(`heard: ${transcript}`); }
        };
        rec.onerror = (e: unknown) => {
          const ev = e as { error?: unknown; message?: unknown };
          const name = typeof ev.error === "string" ? ev.error : "unknown";
          mark(`error:${name}`);
          errors.push(name);
          if (typeof ev.message === "string" && ev.message) errorMessage = ev.message;
        };
        rec.onend = () => { mark("end"); finish(); };
        rec.start();
        started = true;
      } catch (error) {
        mark("throw");
        errors.push(errorName(error));
        errorMessage = error instanceof Error ? error.message : String(error);
        finish();
      }
    });
  } else {
    errors.push("not-available");
  }

  const voices = await voicesPromise;
  return {
    ...base,
    started,
    permissionBefore,
    permissionAfter: await permissionState(env),
    events: events.join(" "),
    audioStartMs,
    transcript,
    confidence,
    isFinal,
    errors: errors.join(","),
    errorMessage,
    durationMs: Date.now() - begun,
    voices: voices.count,
    voiceLangs: voices.langs,
    deVoices: voices.de,
    enVoices: voices.en,
  };
}

/** The joined best transcript of a SpeechRecognitionEvent (all results so far). */
export function readResult(e: unknown): { transcript: string; confidence: number | null; isFinal: boolean } | null {
  const results = (e as { results?: ArrayLike<ArrayLike<{ transcript?: string; confidence?: number }> & { isFinal?: boolean }> }).results;
  if (!results || results.length === 0) return null;
  const parts: string[] = [];
  let confidence: number | null = null;
  let isFinal = true;
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const best = result?.[0];
    if (!result || !best) continue;
    parts.push((best.transcript ?? "").trim());
    if (typeof best.confidence === "number" && best.confidence > 0) confidence = best.confidence;
    if (!result.isFinal) isFinal = false;
  }
  return { transcript: parts.filter(Boolean).join(" "), confidence, isFinal };
}
