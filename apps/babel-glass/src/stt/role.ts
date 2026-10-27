/**
 * 1.1.1 "Sprecher erkennen (Brille)": the glasses' own guess who is talking.
 *
 * Since SDK 0.0.16 every audio frame carries `speakerRole` (self / other /
 * unknown) – the Even app's audio algorithm, NOT a firmware guarantee – and the
 * raw `direction` tag of the glasses. Babel streams all frames to its speech
 * server, which cuts utterances on its own; so the frames are tallied between
 * two final lines and the tally decides the role of the line that ends it.
 *
 * Silence is most of a stream and is likely "unknown", so the decision counts
 * voiced frames (some energy) when there are enough of them; the shares of all
 * frames are kept for the step log. Pure apart from the tally object.
 */

export type SpeakerRole = "self" | "other" | "unknown";

/** Share one role needs to name a line; below that the line stays "unknown". */
export const ROLE_SHARE = 0.6;
/** Voiced frames needed before only they decide (else all frames do). */
export const MIN_VOICED_FRAMES = 4;
/** RMS of s16le samples above which a frame counts as voiced (~ -40 dBFS). */
export const VOICED_RMS = 330;
/** Distinct direction values kept per segment for the log. */
const MAX_DIRECTIONS = 8;

/** Unknown values from the host (older app, phone mic) are "unknown". */
export function normalizeRole(raw: unknown): SpeakerRole {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  return value === "self" || value === "other" ? value : "unknown";
}

export interface RoleCounts {
  readonly self: number;
  readonly other: number;
  readonly unknown: number;
}

export interface SegmentRole {
  /** The decided role of the segment. */
  readonly role: SpeakerRole;
  /** All frames of the segment. */
  readonly frames: number;
  /** Frames with some energy. */
  readonly voiced: number;
  /** Shares of all frames, 0..1. */
  readonly shares: RoleCounts;
  /** Shares of the frames the decision used (voiced, or all when too few were voiced). */
  readonly decidedOn: RoleCounts;
  /** Distinct raw direction tags seen (at most 8), in order of appearance. */
  readonly directions: readonly number[];
  /** Frames that carried a direction (null = none). */
  readonly withDirection: number;
  /** Audio source(s) seen, e.g. "glasses". */
  readonly source: string;
}

const ZERO: RoleCounts = { self: 0, other: 0, unknown: 0 };

function share(counts: RoleCounts): RoleCounts {
  const total = counts.self + counts.other + counts.unknown;
  if (total === 0) return ZERO;
  return { self: counts.self / total, other: counts.other / total, unknown: counts.unknown / total };
}

/** The role holding at least `threshold` of the counts, else "unknown". */
export function decideRole(counts: RoleCounts, threshold = ROLE_SHARE): SpeakerRole {
  const shares = share(counts);
  if (shares.self >= threshold) return "self";
  if (shares.other >= threshold) return "other";
  return "unknown";
}

/** Root mean square of little-endian signed 16-bit samples. */
export function pcmRms(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    let v = pcm[2 * i]! | (pcm[2 * i + 1]! << 8);
    if (v >= 0x8000) v -= 0x10000;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

export interface RoleTracker {
  /** One audio frame as the SDK delivered it. */
  add(frame: { readonly role: SpeakerRole; readonly direction?: number | null; readonly source?: string; readonly pcm?: Uint8Array }): void;
  /** The segment so far, without resetting (the provisional line). */
  peek(): SegmentRole;
  /** The segment so far, and start a new one (a final line). */
  take(): SegmentRole;
  reset(): void;
  /** True once any frame in this session was classified self or other: the glasses do classify. */
  readonly seenKnown: boolean;
}

export function createRoleTracker(threshold = ROLE_SHARE): RoleTracker {
  let all = { self: 0, other: 0, unknown: 0 };
  let voiced = { self: 0, other: 0, unknown: 0 };
  let directions: number[] = [];
  let withDirection = 0;
  let sources: string[] = [];
  let seenKnown = false;

  const clear = (): void => {
    all = { self: 0, other: 0, unknown: 0 };
    voiced = { self: 0, other: 0, unknown: 0 };
    directions = [];
    withDirection = 0;
    sources = [];
  };

  const snapshot = (): SegmentRole => {
    const voicedTotal = voiced.self + voiced.other + voiced.unknown;
    const frames = all.self + all.other + all.unknown;
    const basis = voicedTotal >= MIN_VOICED_FRAMES ? voiced : all;
    return {
      role: decideRole(basis, threshold),
      frames,
      voiced: voicedTotal,
      shares: share(all),
      decidedOn: share(basis),
      directions: [...directions],
      withDirection,
      source: sources.join("+"),
    };
  };

  return {
    add(frame) {
      all[frame.role]++;
      if (frame.role !== "unknown") seenKnown = true;
      if (frame.pcm && pcmRms(frame.pcm) >= VOICED_RMS) voiced[frame.role]++;
      if (typeof frame.direction === "number" && Number.isFinite(frame.direction)) {
        withDirection++;
        if (directions.length < MAX_DIRECTIONS && !directions.includes(frame.direction)) directions.push(frame.direction);
      }
      if (frame.source && !sources.includes(frame.source)) sources.push(frame.source);
    },
    peek: snapshot,
    take() {
      const segment = snapshot();
      clear();
      return segment;
    },
    reset() {
      clear();
      seenKnown = false;
    },
    get seenKnown() { return seenKnown; },
  };
}

/** Percent, rounded, for the log. */
const pct = (value: number): number => Math.round(value * 100);

/**
 * The step-log fields of one segment: counts, shares, the decision, direction
 * values and, with a voice profile, its verdict. Never audio, never text.
 */
export function segmentLog(
  segment: SegmentRole,
  extra: { readonly profile?: "self" | "other" | "none" | null; readonly used: boolean; readonly mode: string },
): Record<string, string | number | boolean | null> {
  const fields: Record<string, string | number | boolean | null> = {
    fr: segment.frames,
    vo: segment.voiced,
    s: pct(segment.shares.self),
    o: pct(segment.shares.other),
    u: pct(segment.shares.unknown),
    ds: pct(segment.decidedOn.self),
    dot: pct(segment.decidedOn.other),
    role: segment.role,
    dir: segment.directions.join(","),
    dirN: segment.withDirection,
    src: segment.source,
    used: extra.used,
    mode: extra.mode,
  };
  if (extra.profile) {
    fields["prof"] = extra.profile;
    // Only a real contradiction counts: one side "unknown" / "none" is no disagreement.
    fields["agree"] = extra.profile === "none" || segment.role === "unknown" ? null : extra.profile === segment.role;
  }
  return fields;
}
