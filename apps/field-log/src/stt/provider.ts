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
 * stock server speaks; a stored ws:// address is dropped on load. Since 0.6 a
 * private build may add live text over a WebSocket (`./live.ts`), but only as
 * a preview: this batch path stays the one every dictation can fall back to.
 */

export type SttStatus = "idle" | "connecting" | "ready" | "reconnecting" | "error";

/** Less audio than this is a mis-tap (16 kHz, 16 bit, mono = 32 bytes per ms): 0.4 s. */
export const MIN_DICTATION_BYTES = 32 * 400;
/**
 * Safety cap of one dictation (live dictation, 0.6): 10 minutes. It only
 * guards against a lost stop tap; a normal note ends with a tap long before.
 */
export const MAX_DICTATION_MS = 600_000;
/** 16 kHz × 2 bytes × 605 s: the recording stops here, nothing beyond is kept. */
export const MAX_DICTATION_BYTES = 16_000 * 2 * 605;
/**
 * The most audio sent as one WAV file (the 0.5 cap, about 30 s). A longer
 * recording that has to go the batch way sends its last part only, and the
 * review screen says so.
 */
export const MAX_UPLOAD_BYTES = 16_000 * 2 * 31;
/** Seconds the review screen names for a cut upload. */
export const MAX_UPLOAD_SECONDS = 30;
/** How long the server may take for a short note … */
export const TRANSCRIBE_TIMEOUT_MS = 20_000;
/** … and never longer than this, however long the audio. */
export const MAX_TRANSCRIBE_TIMEOUT_MS = 120_000;

/** Server time for `bytes` of 16 kHz mono PCM: 20 s plus 1 s per 10 s of audio, at most 120 s. */
export function transcribeTimeoutMs(bytes: number): number {
  const seconds = Math.max(0, bytes) / 32_000;
  return Math.min(MAX_TRANSCRIBE_TIMEOUT_MS, TRANSCRIBE_TIMEOUT_MS + Math.ceil(seconds / 10) * 1_000);
}

/**
 * Where the batch fallback starts in the kept audio. With live finals before
 * the drop, only the audio after the last final is sent (finals come at
 * pauses, so the cut sits in silence; `backoff` reaches back a little in case
 * the final arrived late). If that is still more than `cap`, only the last
 * `cap` bytes go, and `truncated` says so.
 */
export function batchRange(
  total: number,
  lastFinalAt: number,
  cap = MAX_UPLOAD_BYTES,
  backoff = 32_000,
): { start: number; truncated: boolean } {
  const even = (n: number): number => Math.max(0, Math.floor(n / 2) * 2);
  const from = lastFinalAt > 0 ? even(Math.min(total, lastFinalAt - backoff)) : 0;
  if (total - from <= cap) return { start: from, truncated: false };
  return { start: even(total - cap), truncated: true };
}

/** Bytes `start`…end of a list of PCM blocks, as one block. */
export function sliceChunks(chunks: readonly Uint8Array[], start: number): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(Math.max(0, total - start));
  let offset = 0;
  let written = 0;
  for (const chunk of chunks) {
    const end = offset + chunk.length;
    if (end > start) {
      const from = Math.max(0, start - offset);
      out.set(chunk.subarray(from), written);
      written += chunk.length - from;
    }
    offset = end;
  }
  return out;
}

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
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? transcribeTimeoutMs(wav.length - 44));
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
