/**
 * Glasses microphone PCM -> what Whisper wants.
 *
 * The Even app delivers the glasses microphone through `event.audioEvent.audioPcm`
 * (SDK 0.0.16: a Uint8Array; older hosts used number[] or base64). The SDK README
 * does not state the format; every Quietglass voice app (and the Spark Whisper path)
 * reads it as 16 kHz, signed 16-bit little-endian, mono. Speech Probe also measures
 * the real byte rate during the 5 s window (`samplesPerSecond`), so the log shows
 * whether 16 kHz holds on the device.
 */

export const SAMPLE_RATE = 16_000;
const FULL_SCALE = 32_768;

/** audioPcm as bytes, whatever container the host bridge used; null if it is not PCM at all. */
export function toBytes(pcm: unknown): Uint8Array | null {
  if (pcm instanceof Uint8Array) return pcm;
  if (pcm instanceof ArrayBuffer) return new Uint8Array(pcm);
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

/** Signed 16-bit little-endian PCM -> float samples in [-1, 1). A trailing odd byte is ignored. */
export function pcm16leToFloat32(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    let value = ((bytes[i * 2 + 1] ?? 0) << 8) | (bytes[i * 2] ?? 0);
    if (value >= 0x8000) value -= 0x10000;
    out[i] = value / FULL_SCALE;
  }
  return out;
}

/** Joins chunks first, so a sample split across two chunks (odd chunk length) is not misread. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/** Peak and RMS level of float samples in dBFS (-120 for silence), to see whether the microphone heard anything. */
export function levelDbfs(samples: Float32Array): { rms: number; peak: number } {
  if (samples.length === 0) return { rms: -120, peak: -120 };
  let sum = 0;
  let peak = 0;
  for (const s of samples) { sum += s * s; const m = Math.abs(s); if (m > peak) peak = m; }
  const db = (v: number): number => (v <= 0 ? -120 : Math.max(-120, Math.round(20 * Math.log10(v) * 10) / 10));
  return { rms: db(Math.sqrt(sum / samples.length)), peak: db(peak) };
}

/** Collects the PCM of one recording window. */
export class PcmRecorder {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  firstChunkAt: number | null = null;
  lastChunkAt: number | null = null;

  push(chunk: Uint8Array, now: number): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    this.firstChunkAt ??= now;
    this.lastChunkAt = now;
  }

  get chunkCount(): number { return this.chunks.length; }
  get byteCount(): number { return this.bytes; }
  get sampleCount(): number { return Math.floor(this.bytes / 2); }
  /** Audio length if the stream really is 16 kHz. */
  get audioSeconds(): number { return this.sampleCount / SAMPLE_RATE; }

  /** Samples per wall-clock second over the recording window (expect ~16000). */
  samplesPerSecond(windowMs: number): number {
    return windowMs > 0 ? Math.round(this.sampleCount / (windowMs / 1000)) : 0;
  }

  toFloat32(): Float32Array {
    return pcm16leToFloat32(concatBytes(this.chunks));
  }
}
