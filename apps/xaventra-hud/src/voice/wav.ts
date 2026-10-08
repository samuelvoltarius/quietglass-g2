/**
 * The glasses deliver 16 kHz, 16-bit, mono PCM in small blocks. The server
 * expects one WAV file, so the blocks are collected and wrapped in a header.
 */

export const SAMPLE_RATE = 16_000;

/** Wraps raw s16le mono PCM in a 44-byte RIFF/WAVE header. */
export function pcmToWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);              // fmt chunk size
  view.setUint16(20, 1, true);               // PCM
  view.setUint16(22, 1, true);               // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);  // byte rate
  view.setUint16(32, 2, true);               // block align
  view.setUint16(34, 16, true);              // bits per sample
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  new Uint8Array(buffer).set(pcm, 44);
  return buffer;
}

/** The SDK hands PCM over as Uint8Array; older hosts sent arrays or base64. */
export function toPcm(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value.filter((n): n is number => typeof n === "number"));
  if (typeof value === "string") {
    try {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch {
      return new Uint8Array(0);
    }
  }
  return new Uint8Array(0);
}

/** Joins the collected blocks into one buffer. */
export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
