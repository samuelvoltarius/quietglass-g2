/**
 * `audioEvent.speakerRole` during a recording (SDK 0.0.14+: "self" | "other" | "unknown",
 * the Even app's own audio algorithm; phone mic and older hosts say "unknown" or nothing).
 * Shares are by PCM bytes, i.e. by audio time, not by frame count (frames may differ in length).
 */

export type Role = "self" | "other" | "unknown" | "missing";
export const ROLES: readonly Role[] = ["self", "other", "unknown", "missing"];

export function roleOf(value: unknown): Role {
  if (typeof value !== "string") return "missing";
  const v = value.trim().toLowerCase();
  return v === "self" || v === "other" || v === "unknown" ? v : "missing";
}

export interface RoleShares {
  /** Percent of audio time per role, whole numbers; roles never seen are 0. */
  readonly percent: Readonly<Record<Role, number>>;
  readonly frames: Readonly<Record<Role, number>>;
  readonly totalFrames: number;
}

export class RoleTally {
  private readonly bytes: Record<Role, number> = { self: 0, other: 0, unknown: 0, missing: 0 };
  private readonly frameCount: Record<Role, number> = { self: 0, other: 0, unknown: 0, missing: 0 };

  add(role: unknown, byteLength: number): void {
    const r = roleOf(role);
    this.bytes[r] += Math.max(0, byteLength);
    this.frameCount[r] += 1;
  }

  shares(): RoleShares {
    const total = ROLES.reduce((sum, r) => sum + this.bytes[r], 0);
    const percent = { self: 0, other: 0, unknown: 0, missing: 0 } as Record<Role, number>;
    if (total > 0) for (const r of ROLES) percent[r] = Math.round((this.bytes[r] / total) * 100);
    const totalFrames = ROLES.reduce((sum, r) => sum + this.frameCount[r], 0);
    return { percent, frames: { ...this.frameCount }, totalFrames };
  }
}

/** "self 62% · other 30% · unknown 8%" (roles at 0% left out; "no frames" when nothing came). */
export function formatShares(shares: RoleShares): string {
  if (shares.totalFrames === 0) return "no frames";
  const parts = ROLES.filter((r) => shares.frames[r] > 0).map((r) => `${r} ${shares.percent[r]}%`);
  return parts.join(" · ");
}
