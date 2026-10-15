/**
 * Audio from the glasses → what Vosk wants.
 *
 * SDK 0.0.16 (`AudioEvent.audioPcm`) only says "Uint8Array; after the JSON hop
 * from the Flutter host usually number[] or a base64 string". Neither sample
 * rate nor encoding is in the d.ts. Quietglass apps (decibel-guard, field-log,
 * nextstop) treat it as **16 kHz, signed 16-bit little-endian, mono**, which is
 * what their WAV files and level meters assume and what the Whisper upload
 * works with. That is exactly Vosk's native format, so no resampling is
 * needed — a resampler is included anyway in case a host delivers 48 kHz
 * (e.g. the phone microphone source).
 */

export const VOSK_RATE = 16_000;

/** Accepts the shapes the SDK documents and returns raw bytes (null if unusable). */
export function pcmBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) {
    if (!raw.every((v) => typeof v === "number")) return null;
    return Uint8Array.from(raw as number[]);
  }
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const binary = atob(raw);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Signed 16-bit little-endian → float in [-1, 1). An odd trailing byte is
 * dropped. vosk-browser's `acceptWaveformFloat` expects exactly this range
 * (it multiplies by 0x8000 itself before handing the data to Kaldi).
 */
export function s16leToFloat32(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let value = ((bytes[i * 2 + 1] ?? 0) << 8) | (bytes[i * 2] ?? 0);
    if (value >= 0x8000) value -= 0x10000;
    out[i] = value / 0x8000;
  }
  return out;
}

/** Linear resampling; good enough for speech commands, a no-op at equal rates. */
export function resample(input: Float32Array, fromRate: number, toRate = VOSK_RATE): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const step = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const pos = i * step;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    out[i] = (input[left] ?? 0) * (1 - frac) + (input[right] ?? 0) * frac;
  }
  return out;
}
