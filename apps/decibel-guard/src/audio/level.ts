/**
 * Sound level from raw PCM.
 *
 * The glasses deliver 16 kHz signed 16-bit mono PCM through
 * `event.audioEvent.audioPcm`. From that we can compute a level in **dBFS**
 * (decibels relative to digital full scale), which is exact and needs no
 * assumptions.
 *
 * What we cannot compute is dB SPL — the physical loudness in the room —
 * because that depends on the microphone's sensitivity, which is not published
 * and not queryable. DecibelGuard therefore treats dBFS as the measurement and
 * applies a user-supplied calibration offset to express it as approximate SPL.
 * The app says so on screen rather than implying a precision it does not have.
 */

/** Signed 16-bit full scale. */
const FULL_SCALE = 32768;

/** Quietest level we report; below this the reading is noise about noise. */
export const MIN_DBFS = -90;

export interface LevelReading {
  /** Root mean square amplitude, 0…1 relative to full scale. */
  readonly rms: number;
  /** Level in dBFS, negative, clamped at MIN_DBFS. */
  readonly dbfs: number;
  /** Peak sample in the block, 0…1. */
  readonly peak: number;
  /** Number of samples the reading is based on. */
  readonly samples: number;
}

export const SILENT: LevelReading = { rms: 0, dbfs: MIN_DBFS, peak: 0, samples: 0 };

/**
 * Computes a level from one PCM block.
 *
 * Accepts the `Uint8Array` the SDK delivers and interprets it as little-endian
 * signed 16-bit samples. An odd-length buffer has its trailing byte ignored
 * rather than being misread as a sample.
 */
export function levelFromPcm(pcm: Uint8Array): LevelReading {
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) return SILENT;

  let sumSquares = 0;
  let peak = 0;

  for (let i = 0; i < sampleCount; i++) {
    const low = pcm[i * 2] ?? 0;
    const high = pcm[i * 2 + 1] ?? 0;
    // Little-endian, two's complement.
    let value = (high << 8) | low;
    if (value >= 0x8000) value -= 0x10000;

    const normalised = value / FULL_SCALE;
    sumSquares += normalised * normalised;
    const magnitude = Math.abs(normalised);
    if (magnitude > peak) peak = magnitude;
  }

  const rms = Math.sqrt(sumSquares / sampleCount);
  return { rms, dbfs: toDbfs(rms), peak, samples: sampleCount };
}

export function toDbfs(rms: number): number {
  if (rms <= 0) return MIN_DBFS;
  return Math.max(MIN_DBFS, 20 * Math.log10(rms));
}

/**
 * Applies the user's calibration offset to express a dBFS reading as
 * approximate dB SPL.
 *
 * The offset is found by holding a reference meter next to the glasses and
 * entering the difference. It is a single linear offset, which is a reasonable
 * approximation across the mid range but is not a frequency-weighted
 * measurement and is not traceable to any standard.
 */
export function toApproxSpl(dbfs: number, calibrationOffset: number): number {
  return dbfs + calibrationOffset;
}

/**
 * Exponential average over blocks, so the number on screen is readable.
 *
 * Sound level jumps constantly; an unsmoothed readout is unreadable and
 * meaningless. This is the "slow" response of a sound level meter in spirit,
 * though not to specification.
 */
export function smoothDb(previous: number | null, sample: number, factor: number): number {
  if (previous === null) return sample;
  const f = Math.min(1, Math.max(0, factor));
  return previous + (sample - previous) * f;
}
