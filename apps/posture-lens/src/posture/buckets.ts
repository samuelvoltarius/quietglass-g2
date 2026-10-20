/**
 * The tally of the session in slices of ten minutes, kept in memory only for the phone's strip of cards
 * (nothing is written anywhere; the strip is gone when the app closes, like the tally itself).
 */
export interface Bucket {
  /** Start of the slice (epoch ms). */
  readonly start: number;
  readonly goodSeconds: number;
  readonly leaningSeconds: number;
}

export interface BucketState {
  readonly buckets: readonly Bucket[];
  /** The tally as of the last update, to take the difference from. */
  readonly last: { readonly good: number; readonly lean: number } | null;
}

export const BUCKET_MS = 10 * 60_000;
export const BUCKET_KEEP = 12;
export const EMPTY_BUCKETS: BucketState = { buckets: [], last: null };

/**
 * Adds what the monitor tallied since the last call to the slice of `now`. A tally that went down was cleared:
 * the strip starts again.
 */
export function updateBuckets(state: BucketState, good: number, lean: number, now: number): BucketState {
  const last = state.last;
  if (last === null || good < last.good || lean < last.lean) return { buckets: last === null ? state.buckets : [], last: { good, lean } };
  const addGood = good - last.good;
  const addLean = lean - last.lean;
  if (addGood <= 0 && addLean <= 0) return { buckets: state.buckets, last: { good, lean } };
  const start = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const buckets = [...state.buckets];
  const tail = buckets[buckets.length - 1];
  if (tail && tail.start === start) buckets[buckets.length - 1] = { start, goodSeconds: tail.goodSeconds + addGood, leaningSeconds: tail.leaningSeconds + addLean };
  else buckets.push({ start, goodSeconds: addGood, leaningSeconds: addLean });
  return { buckets: buckets.slice(-BUCKET_KEEP), last: { good, lean } };
}

/** Share of a slice spent upright, 0..1, or null for an empty one. */
export function bucketShare(bucket: Bucket): number | null {
  const total = bucket.goodSeconds + bucket.leaningSeconds;
  return total > 0 ? bucket.goodSeconds / total : null;
}
