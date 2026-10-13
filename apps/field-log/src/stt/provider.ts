/**
 * Dictation through a Whisper server of the user's own.
 *
 * The recording is collected on the phone while the user dictates and sent as
 * one WAV file to an OpenAI-compatible `/v1/audio/transcriptions` endpoint
 * (faster-whisper, whisper.cpp server, the Quietglass selfhost whisper …).
 * Same proven path as NextStop and OpenGlance: a multipart form post with no
 * header of our own is a "simple" request, so the glasses' WebView sends no
 * CORS preflight that a Whisper server would answer with 405.
 *
 * Until 0.4 FieldLog streamed PCM over its own WebSocket protocol, which no
 * stock server speaks; a stored ws:// address is dropped on load.
 */

export type SttStatus = "idle" | "connecting" | "ready" | "reconnecting" | "error";

/** Less audio than this is a mis-tap (16 kHz, 16 bit, mono = 32 bytes per ms): 0.4 s. */
export const MIN_DICTATION_BYTES = 32 * 400;
/** A note is short; the microphone never stays on longer than this. */
export const MAX_DICTATION_MS = 30_000;
/** 16 kHz × 2 bytes × 31 s: anything beyond is dropped, never buffered. */
export const MAX_DICTATION_BYTES = 16_000 * 2 * 31;
/** How long the server may take for one note. */
export const TRANSCRIBE_TIMEOUT_MS = 20_000;

/** Set at build time in a private build: `VITE_STT_URL=https://… npm run build`. */
const BUILD_STT_URL: string | undefined = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_STT_URL;

/** The server to ask: the phone setting, else the build's default, else none. */
export function sttBase(setting: string, build: string | undefined = BUILD_STT_URL): string {
  return (setting.trim() || (build ?? "").trim()).replace(/\/+$/, "");
}

/** The transcription endpoint for a base address (a full endpoint address is kept as it is). */
export function sttEndpoint(base: string): string {
  return /\/v1\/audio\/transcriptions$/.test(base) ? base : `${base}/v1/audio/transcriptions`;
}

/**
 * audioPcm arrives as Uint8Array, number[] or base64 depending on the host
 * bridge; every shape is normalised or the recording comes out empty.
 */
export function pcmBytes(pcm: unknown): Uint8Array | null {
  if (pcm instanceof Uint8Array) return pcm;
  if (Array.isArray(pcm)) return Uint8Array.from(pcm.filter((n): n is number => typeof n === "number"));
  if (typeof pcm === "string") {
    try {
      const bin = atob(pcm);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }
  return null;
}

export interface TranscribeOptions {
  /** BCP-47 language, or "auto" to let the server detect it. */
  readonly language: string;
  /** Optional bearer token. Setting one makes the request non-simple (preflight). */
  readonly token?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Uploads the recording as multipart form data and returns the text. */
export async function transcribe(wav: Uint8Array, base: string, options: TranscribeOptions): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([wav as BlobPart], { type: "audio/wav" }), "note.wav");
  if (options.language && options.language !== "auto") form.append("language", options.language);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS);
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  try {
    const response = await doFetch(sttEndpoint(base), {
      method: "POST",
      body: form,
      signal: controller.signal,
      ...(options.token ? { headers: { Authorization: "Bearer " + options.token } } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const answer = (await response.json()) as { text?: unknown };
    return typeof answer.text === "string" ? answer.text.replace(/\s+/g, " ").trim() : "";
  } finally {
    clearTimeout(timer);
  }
}

/** The labelled stand-in for `?demo=1`: fixed text, no server, no audio sent anywhere. */
const MOCK_PHRASES = [
  "Window seal in the hallway is cracked.",
  "Smoke detector tested, works.",
  "Water stain on the ceiling above the bath.",
];

export function mockTranscript(n: number): string {
  return MOCK_PHRASES[n % MOCK_PHRASES.length] ?? "";
}
