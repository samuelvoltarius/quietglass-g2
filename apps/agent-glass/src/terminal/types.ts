/**
 * What Even Terminal sends, expressed the way the glasses need it.
 *
 * The field names below were read out of the shipped server
 * (`@evenrealities/even-terminal@0.10.5`), not guessed — every event type and
 * payload key here was found in its own routing code or observed on the live
 * stream. Anything the server might rename later is read defensively, so a
 * changed field degrades to "unknown" rather than throwing.
 */

export interface Session {
  readonly id: string;
  readonly title: string;
  /** Working directory, which is how you tell two sessions apart at a glance. */
  readonly cwd: string;
  readonly provider: string;
  /** "idle" while waiting for you, something else while it works. */
  readonly status: string;
  readonly timestamp: Date;
}

export interface HistoryEntry {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

/**
 * The event types the server emits.
 *
 * `permission_request` is the one this whole app exists for: the agent has
 * stopped and cannot continue until somebody says yes or no. Everything else
 * is context.
 */
export type EventKind =
  | "text_delta" | "text" | "status" | "result" | "error" | "notification"
  | "tool_start" | "tool_end" | "task_progress" | "running_stats"
  | "permission_request" | "permission_result"
  | "user_question" | "question_answer" | "user_prompt"
  | "unknown";

export interface AgentEvent {
  readonly kind: EventKind;
  /** Free text carried by the event, already concatenated where relevant. */
  readonly text: string;
  /** Tool name for tool_start/tool_end and permission_request. */
  readonly tool?: string;
  /** The raw payload, for anything this app does not model. */
  readonly raw: Record<string, unknown>;
}

/** What the glasses are currently showing, derived from the stream. */
export interface AgentState {
  readonly session: Session | null;
  /** The agent's most recent prose, as it streams in. */
  readonly text: string;
  /** Tool currently running, if any. */
  readonly tool: string | null;
  /** Set while the agent is blocked waiting for a decision. */
  readonly pending: PendingDecision | null;
  readonly busy: boolean;
  readonly error: string | null;
  /** When the agent last started working, for the elapsed counter. */
  readonly startedAt: Date | null;
  /**
   * Whether this session can be steered at all.
   *
   * Even Terminal reads the history of *every* Claude Code session off disk,
   * but only owns the ones it started itself. A session running in the desktop
   * app answers `404 Session not found` to status, prompt and
   * permission-response alike. Offering "swipe to allow" on such a session
   * would promise something that silently fails, so the display says plainly
   * that it is only watching.
   */
  readonly controllable: boolean;
}

export interface PendingDecision {
  readonly kind: "permission" | "question";
  /** "Bash", "Write", … — what it wants to do. */
  readonly title: string;
  /** The command or the question itself. */
  readonly detail: string;
  /**
   * The server's id for this request, when the event carries one. Used only
   * locally, to recognise a request that was already answered when a
   * reconnecting stream delivers it a second time.
   */
  readonly id?: string;
}

export const EMPTY_STATE: AgentState = {
  session: null, text: "", tool: null, pending: null,
  busy: false, error: null, startedAt: null, controllable: false,
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Pulls the human-readable part out of an event.
 *
 * The server is not consistent about where text lives — `text` on a delta,
 * `message` on an error, `content` elsewhere — so all the plausible keys are
 * tried rather than assuming one.
 */
export function textOf(payload: Record<string, unknown>): string {
  return asString(payload["text"])
    ?? asString(payload["delta"])
    ?? asString(payload["message"])
    ?? asString(payload["content"])
    ?? "";
}

const KNOWN: readonly EventKind[] = [
  "text_delta", "text", "status", "result", "error", "notification",
  "tool_start", "tool_end", "task_progress", "running_stats",
  "permission_request", "permission_result",
  "user_question", "question_answer", "user_prompt",
];

export function parseEvent(raw: unknown): AgentEvent {
  const payload = asRecord(raw);
  const type = asString(payload["type"]) ?? "";
  const kind = (KNOWN as readonly string[]).includes(type) ? (type as EventKind) : "unknown";
  const tool = asString(payload["tool"])
    ?? asString(payload["toolName"])
    ?? asString(asRecord(payload["tool"])["name"]);
  return { kind, text: textOf(payload), ...(tool ? { tool } : {}), raw: payload };
}

/**
 * Folds one event into the state.
 *
 * Deltas append, everything else replaces. The distinction matters: a
 * `text_delta` is one fragment of a sentence being typed, while a `text` is a
 * complete message — treating the second as a fragment would print the whole
 * answer twice.
 */
export function applyEvent(state: AgentState, event: AgentEvent): AgentState {
  switch (event.kind) {
    case "user_prompt":
      // A new instruction resets everything; the old answer is no longer
      // what the agent is doing.
      return { ...state, text: "", tool: null, pending: null, busy: true,
        error: null, startedAt: new Date() };

    case "text_delta":
      return { ...state, text: state.text + event.text, busy: true,
        startedAt: state.startedAt ?? new Date() };

    case "text":
      return { ...state, text: event.text, busy: true,
        startedAt: state.startedAt ?? new Date() };

    case "tool_start":
      return { ...state, tool: event.tool ?? event.text ?? null, busy: true };

    case "tool_end":
      return { ...state, tool: null };

    case "permission_request": {
      const id = requestId(event.raw);
      return {
        ...state,
        busy: false,
        pending: {
          kind: "permission",
          title: event.tool ?? "Tool",
          detail: event.text || describeInput(event.raw),
          ...(id ? { id } : {}),
        },
      };
    }

    case "user_question":
      return {
        ...state,
        busy: false,
        pending: { kind: "question", title: "Question", detail: event.text },
      };

    // The decision has been made — by these glasses or elsewhere. Either way
    // the question is gone, so the prompt must disappear from the display.
    case "permission_result":
    case "question_answer":
      return { ...state, pending: null, busy: true };

    case "result":
      return { ...state, busy: false, tool: null, startedAt: null };

    case "error":
      return { ...state, busy: false, error: event.text || "Error" };

    default:
      return state;
  }
}

/**
 * Reads a request id defensively; the key name is not part of a stable
 * contract. A bare `id` is deliberately not used: if it named the session or
 * the stream, every later request would look "already answered".
 */
export function requestId(raw: Record<string, unknown>): string | undefined {
  for (const key of ["requestId", "request_id", "permissionId", "toolUseId", "tool_use_id"]) {
    const value = raw[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * A one-line description of what a tool wants to do.
 *
 * Falls back to the raw input when the server sends no prose, because
 * "Bash" alone is not enough to approve on — you need to see the command.
 */
export function describeInput(raw: Record<string, unknown>): string {
  const input = asRecord(raw["input"] ?? raw["arguments"] ?? raw["params"]);
  const direct = asString(input["command"]) ?? asString(input["file_path"])
    ?? asString(input["path"]) ?? asString(input["pattern"]) ?? asString(input["url"]);
  if (direct) return direct;
  const keys = Object.keys(input);
  return keys.length > 0 ? JSON.stringify(input).slice(0, 160) : "";
}
