/**
 * The hub report: one payload from one daemon.
 *
 * Quiet Hub is the merged glance app — agent, home and printer come from a
 * single self-hosted bridge instead of three separate servers. The daemon
 * adapts them (Hermes / Home Assistant / Moonraker); the glasses never talk
 * to three different protocols.
 */

export type ConnectionState = "demo" | "connected" | "missing" | "error";

export interface AgentSnapshot {
  /** Name shown in the header, e.g. "Hermes". */
  readonly provider: string;
  /** Saved tap-questions. The G2 has no keyboard; asking starts from a list. */
  readonly questions: readonly string[];
  readonly selected: number;
  /** Answer to the last asked question, when one has arrived. */
  readonly answer: string | null;
  readonly busy: boolean;
  /**
   * Follow-up suggestions offered after the last answer ("Mehr Details",
   * "Kurzfassung" …). When present they replace the saved questions as the
   * tappable list, so the next ask is one tap away — no typing, no speaking.
   */
  readonly suggestions: readonly string[];
}

export type AgentKind = "hermes" | "openclaw" | "codex" | "claude" | "other";

/** One agent known to the hub — local to the daemon or on another machine via a relay. */
export interface AgentInfo {
  readonly id: string;
  readonly label: string;
  readonly kind: AgentKind | string;
  readonly machine: string;
  readonly online: boolean;
  readonly busy: boolean;
  /** ask = permissions are decided on the glasses; auto = bypass; others see README. */
  readonly mode: string;
  /** What the agent is doing right now ("Edit: foo.ts"); empty when idle. */
  readonly activity: string;
  readonly error: string | null;
  /** Streaming or final answer of the last question. */
  readonly answer: string | null;
  readonly lastQuestion: string | null;
  readonly suggestions: readonly string[];
}

/** A permission request waiting for a yes/no on the glasses. */
export interface Approval {
  readonly id: string;
  readonly agentId: string;
  /** Tool plus short command or file, e.g. "Bash: npm test". */
  readonly title: string;
  readonly detail: string | null;
  readonly createdAt: string;
  readonly expiresAt: number;
}

export type AgentEventStatus = "done" | "waiting" | "error";

/** A completion pushed by Hermes, Claude, Codex or OpenClaw to the daemon. */
export interface AgentEvent {
  readonly id: string;
  readonly provider: string;
  readonly status: AgentEventStatus;
  readonly title: string;
  readonly detail: string | null;
  readonly createdAt: string;
  readonly read: boolean;
}

export interface InboxSnapshot {
  readonly events: readonly AgentEvent[];
  readonly selected: number;
}

export interface DeviceSnapshot {
  readonly id: string;
  readonly label: string;
  readonly kind: "switch" | "climate" | "cover";
  /** Already localized short state, e.g. "an", "21,5°", "offen". */
  readonly state: string;
  /** Whether a double tap would switch it ON (or shows it as on). */
  readonly on: boolean;
  /** False for sensors and anything the allow-list marks read-only. */
  readonly writable: boolean;
}

export interface HomeSnapshot {
  readonly devices: readonly DeviceSnapshot[];
  readonly selected: number;
  /** True when the daemon has no Home Assistant configured and shows stand-ins. */
  readonly demo?: boolean;
}

export interface PrinterSnapshot {
  readonly job: string | null;
  readonly state: "printing" | "paused" | "ready" | "error";
  readonly layer: number;
  readonly layers: number;
  readonly etaMin: number | null;
  readonly nozzleC: number;
  readonly bedC: number;
  readonly selected: number;
  /** 0-100; preferred over layer/layers when present. */
  readonly progress?: number;
  /** Moonraker could not be reached. */
  readonly offline?: boolean;
  /** Stand-in data, not a real printer. */
  readonly demo?: boolean;
}

export interface HubReport {
  readonly connection: ConnectionState;
  /** Legacy single-agent view (the default agent) plus the saved questions. */
  readonly agent: AgentSnapshot;
  readonly agents: readonly AgentInfo[];
  readonly approvals: readonly Approval[];
  readonly home: HomeSnapshot;
  readonly printer: PrinterSnapshot;
  readonly inbox: InboxSnapshot;
}

/** One daemon endpoint per side effect — the bridge fans out from here. */
export interface HubApi {
  report(): Promise<HubReport>;
  /** Starts a question; the answer streams into the next reports. */
  ask(question: string, agentId?: string): Promise<void>;
  /** WAV bytes from the glasses → transcript (self-hosted Whisper) → asked. */
  voice(wav: Uint8Array, agentId?: string): Promise<{ question: string }>;
  approve(cardId: string, decision: "allow" | "deny"): Promise<void>;
  cancel(agentId: string): Promise<void>;
  toggle(deviceId: string): Promise<void>;
  printer(action: "pause" | "resume" | "cancel"): Promise<void>;
  readEvent(id: string): Promise<void>;
}
