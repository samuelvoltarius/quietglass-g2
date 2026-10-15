import type { StarStatus } from "./status";

/**
 * What deserves a line at the top of every page, worst first. Pure function of
 * one status, so every case is testable and the glasses never invent a
 * warning from a stale comparison.
 */
export type AlertKind =
  | "seqDone"
  | "guidingLost"
  | "coolingOff"
  | "coolingDrift"
  | "flipSoon"
  | "flipNow"
  | "cameraLost"
  | "mountLost"
  | "error"
  | "unsafe";

export interface Alert {
  readonly kind: AlertKind;
  readonly level: "critical" | "warn" | "info";
  /** Placeholder values for the message text. */
  readonly vars: Readonly<Record<string, string | number>>;
}

/** A flip this close is announced. */
export const FLIP_WARN_MINUTES = 15;
/** Events older than this no longer raise an alert. */
export const EVENT_WINDOW_S = 20 * 60;
/** Degrees the sensor may sit off its set point before cooling counts as drifting. */
export const COOLING_DRIFT = 2.5;

const recent = (status: Extract<StarStatus, { online: true }>, name: RegExp): { name: string; ageSeconds: number | null } | undefined =>
  [...status.events].reverse().find((e) => name.test(e.name) && (e.ageSeconds === null || e.ageSeconds <= EVENT_WINDOW_S));

export function alerts(status: StarStatus | null): Alert[] {
  if (!status?.online) return [];
  const out: Alert[] = [];
  const running = status.sequence.state === "running";

  const error = recent(status, /^(ERROR-|CAMERA-DOWNLOAD-TIMEOUT)/);
  if (error) out.push({ kind: "error", level: "critical", vars: { name: error.name.replace(/^ERROR-/, "") } });

  // N.I.N.A.'s safety monitor says the sky is not safe (rain, clouds, wind - whatever it watches).
  if (status.safety.connected && status.safety.safe === false) out.push({ kind: "unsafe", level: "critical", vars: {} });

  if (running && !status.camera.connected) out.push({ kind: "cameraLost", level: "critical", vars: {} });
  if (running && !status.mount.connected) out.push({ kind: "mountLost", level: "critical", vars: {} });

  // Guiding lost: the guider is there but no longer guides while imaging, or it stopped mid-sequence.
  const stopped = recent(status, /^GUIDER-(STOP|DISCONNECTED)$/);
  const restarted = recent(status, /^GUIDER-START$/);
  const stoppedLater = stopped && (!restarted || (stopped.ageSeconds ?? 0) < (restarted.ageSeconds ?? Infinity));
  if (running && ((status.guider.connected && status.guider.guiding === false) || (stoppedLater && status.guider.guiding !== true))) {
    out.push({ kind: "guidingLost", level: "critical", vars: {} });
  }

  const cam = status.camera;
  if (cam.connected && cam.canCool && cam.setpoint !== null) {
    if (running && !cam.cooler) out.push({ kind: "coolingOff", level: "critical", vars: {} });
    else if (cam.cooler && cam.temp !== null && Math.abs(cam.temp - cam.setpoint) > COOLING_DRIFT) {
      out.push({ kind: "coolingDrift", level: "warn", vars: { temp: Math.round(cam.temp), setpoint: Math.round(cam.setpoint) } });
    }
  }

  const flip = status.mount.connected && status.mount.tracking ? status.mount.flipMinutes : null;
  if (flip !== null && flip <= 1) out.push({ kind: "flipNow", level: "warn", vars: {} });
  else if (flip !== null && flip <= FLIP_WARN_MINUTES) out.push({ kind: "flipSoon", level: "warn", vars: { minutes: flip } });

  const done = recent(status, /^SEQUENCE-FINISHED$/);
  if (!running && (status.sequence.state === "finished" || done)) out.push({ kind: "seqDone", level: "info", vars: {} });

  const rank = { critical: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** The worst level present, for the header sign. */
export function worstLevel(list: readonly Alert[]): Alert["level"] | null {
  return list[0]?.level ?? null;
}
