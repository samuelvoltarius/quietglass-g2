/**
 * Speaking a destination: the recording goes to a Whisper server of the
 * user's own (OpenAI-compatible `/v1/audio/transcriptions`) and comes back as
 * text. Nothing is recorded unless the touchpad is held, nothing is kept.
 */

/** Less audio than this is a mis-press (16 kHz, 16 bit, mono = 32 bytes per ms): 0.4 s. */
export const MIN_VOICE_BYTES = 32 * 400;
/** The hard stop of a recording whose release event never arrives. */
export const MAX_VOICE_MS = 8000;

/** Set at build time in a private build: `VITE_STT_URL=https://… npm run build`. */
const BUILD_STT_URL: string | undefined = import.meta.env.VITE_STT_URL as string | undefined;

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
  if (Array.isArray(pcm)) return Uint8Array.from(pcm as number[]);
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

/**
 * Uploads the recording as multipart form data and returns the text.
 *
 * No header is set on purpose: a form post with the browser's own content type
 * is a "simple" request, so the glasses' WebView sends no CORS preflight (a
 * Whisper server often answers OPTIONS with 405).
 */
export async function transcribe(
  wav: Uint8Array, base: string, language: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis), timeoutMs = 20000,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([wav as BlobPart], { type: "audio/wav" }), "voice.wav");
  form.append("language", language);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(sttEndpoint(base), { method: "POST", body: form, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const answer = (await response.json()) as { text?: unknown };
    return typeof answer.text === "string" ? answer.text.replace(/\s+/g, " ").trim() : "";
  } finally {
    clearTimeout(timer);
  }
}
