import { TerminalClient, describeError, subscribe as subscribeTerminal } from "../terminal/client";
import type { AgentEvent, HistoryEntry, Session } from "../terminal/types";
import type { ProviderKind, Settings } from "../storage/persist";
import { HermesBackend } from "./hermes";
import { OpenClawBackend } from "./openclaw";

export interface BackendCapabilities {
  readonly decisions: boolean;
  readonly sessions: boolean;
  readonly createSession: boolean;
}

export interface AgentBackend {
  readonly kind: ProviderKind;
  readonly capabilities: BackendCapabilities;
  sessions(): Promise<readonly Session[]>;
  history(sessionId: string): Promise<readonly HistoryEntry[]>;
  controllable(sessionId: string): Promise<boolean>;
  subscribe(
    sessionId: string,
    onEvent: (event: AgentEvent) => void,
    onError: (message: string) => void,
  ): () => void;
  prompt(sessionId: string, text: string): Promise<void>;
  decide(sessionId: string, decision: "allow" | "deny"): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  createSession?(title?: string): Promise<Session>;
  dispose(): void;
}

class EvenTerminalBackend implements AgentBackend {
  readonly kind = "even-terminal" as const;
  readonly capabilities = { decisions: true, sessions: true, createSession: false } as const;
  readonly #client: TerminalClient;

  constructor(settings: Settings) {
    this.#client = new TerminalClient({ baseUrl: settings.baseUrl, token: settings.token });
  }

  sessions(): Promise<readonly Session[]> { return this.#client.sessions(); }
  history(sessionId: string): Promise<readonly HistoryEntry[]> { return this.#client.history(sessionId); }
  controllable(sessionId: string): Promise<boolean> { return this.#client.controllable(sessionId); }
  subscribe(sessionId: string, onEvent: (event: AgentEvent) => void, onError: (message: string) => void): () => void {
    return subscribeTerminal(this.#client, sessionId, onEvent, onError);
  }
  prompt(sessionId: string, text: string): Promise<void> { return this.#client.prompt(sessionId, text); }
  decide(sessionId: string, decision: "allow" | "deny"): Promise<void> {
    return this.#client.decide(sessionId, decision);
  }
  interrupt(sessionId: string): Promise<void> { return this.#client.interrupt(sessionId); }
  dispose(): void { /* EventSource subscriptions are owned by the caller. */ }
}

export function createBackend(settings: Settings): AgentBackend {
  if (settings.provider === "hermes") {
    return new HermesBackend({ url: settings.baseUrl, token: settings.token });
  }
  if (settings.provider === "openclaw") {
    return new OpenClawBackend({ baseUrl: settings.baseUrl, token: settings.token });
  }
  return new EvenTerminalBackend(settings);
}

export function describeBackendError(error: unknown, provider: ProviderKind): string {
  if (provider === "even-terminal") return describeError(error);
  const message = error instanceof Error ? error.message : String(error);
  if (/token|unauthor|forbidden|401|403/i.test(message)) return "Token rejected";
  if (/timeout|timed out|aborted/i.test(message)) return "Timed out";
  if (/socket|network|fetch|connect|unreachable/i.test(message)) {
    return `${provider === "hermes" ? "Hermes bridge" : "OpenClaw gateway"} unreachable`;
  }
  return message.slice(0, 80);
}
