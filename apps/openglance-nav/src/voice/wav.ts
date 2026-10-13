/**
 * WAV assembly for voice notes.
 *
 * The glasses deliver raw PCM blocks (`audioPcm` events); the recogniser wants
 * one file. Only the 44-byte RIFF header is added here — the
 * samples pass through untouched, because resampling belongs to the
 * recogniser, not to a glance app.
 */

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) target[offset + i] = text.charCodeAt(i);
}

/** Standard 16-bit mono PCM WAV. `sampleRate` must match what the SDK sends. */
export function buildWav(chunks: readonly Uint8Array[], sampleRate = 16_000): Uint8Array {
  const dataLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const wav = new Uint8Array(44 + dataLength);
  const view = new DataView(wav.buffer);
  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(wav, 8, "WAVE");
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate: 16-bit mono
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(wav, 36, "data");
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (const chunk of chunks) {
    wav.set(chunk, offset);
    offset += chunk.length;
  }
  return wav;
}
