export function joinPcm(chunks: readonly Uint8Array[]): Uint8Array { const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0); const joined = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; } return joined; }
/** The glasses deliver 16 kHz signed 16-bit mono PCM: 32 000 bytes per second of speech. */
export const PCM_BYTES_PER_SECOND = 32000;
/** Shorter recordings are a mis-press, not a question: they are dropped locally and never reach the bridge. */
export const MIN_RECORDING_MS = 400;
/** A lost release event must not leave the microphone recording (and buffering) forever. */
export const MAX_RECORDING_MS = 60000;
export function recordingMs(bytes: number): number { return Math.max(0, bytes) / PCM_BYTES_PER_SECOND * 1000; }
export function isTooShort(pcm: Uint8Array, minMs = MIN_RECORDING_MS): boolean { return recordingMs(pcm.length) < minMs; }
export function isTooLong(bytes: number, maxMs = MAX_RECORDING_MS): boolean { return recordingMs(bytes) >= maxMs; }
export interface AssistantReply { readonly heard: string; readonly answer: string; readonly actions: readonly string[]; }
export function parseReply(value: unknown): AssistantReply { const row = (value && typeof value === "object" ? value : {}) as Partial<AssistantReply>; if (typeof row.answer !== "string") throw new Error("assistant response has no answer"); return { heard: typeof row.heard === "string" ? row.heard : "", answer: row.answer, actions: Array.isArray(row.actions) ? row.actions.filter((action): action is string => typeof action === "string") : [] }; }
/** Words longer than a whole line (URLs, IDs) are hard-split so no line ever exceeds `width`. */
export function wrap(text: string, width = 52): string[] { const max = Math.max(1, Math.floor(width)); const words = text.trim().split(/\s+/).flatMap((word) => { const pieces: string[] = []; for (let index = 0; index < word.length; index += max) pieces.push(word.slice(index, index + max)); return pieces; }); const lines: string[] = []; let line = ""; for (const word of words) { if (`${line} ${word}`.trim().length > max && line) { lines.push(line); line = word; } else line = `${line} ${word}`.trim(); } if (line) lines.push(line); return lines; }
/** Wraps and keeps at most `maxLines`, marking cut-off text with an ellipsis so the reader knows there is more. */
export function fitLines(text: string, width: number, maxLines: number): string[] { const lines = wrap(text, width); if (lines.length <= maxLines) return lines; const kept = lines.slice(0, Math.max(0, maxLines)); const lastIndex = kept.length - 1; const last = kept[lastIndex]; if (last !== undefined) kept[lastIndex] = `${last.slice(0, Math.max(0, Math.floor(width) - 1)).trimEnd()}…`; return kept; }
export interface AskOptions { readonly locale: string; readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch; }
/** Posts the recording to the bridge. Aborts after `timeoutMs` so a hung bridge cannot leave the app stuck in "busy". */
export async function askAssistant(endpoint: string, pcm: Uint8Array, options: AskOptions): Promise<AssistantReply> {
  const doFetch = options.fetchImpl ?? fetch; const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
  const payload = new Uint8Array(pcm.length); payload.set(pcm);
  try { const response = await doFetch(endpoint, { method: "POST", headers: { "content-type": "application/octet-stream", "x-audio-format": "pcm-from-even-g2", "x-language": options.locale }, body: payload.buffer, signal: controller.signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return parseReply(await response.json()); }
  catch (error) { if (controller.signal.aborted) throw new Error("timed out"); throw error; }
  finally { clearTimeout(timeout); }
}
