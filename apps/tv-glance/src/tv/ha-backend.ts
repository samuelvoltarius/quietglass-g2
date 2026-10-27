import type { TvBackend } from "./backend";
import { ApiError } from "./errors";
import { createHaRestBackend, listHaEntitiesRest, type HaChoice } from "./ha";
import { createHaWsBackend, listHaEntitiesWs, type WsFactory } from "./ha-ws";
import type { TvState } from "./model";

/**
 * Home Assistant: the WebSocket API first (no CORS setup needed), REST only as
 * a fallback when the WebSocket cannot be reached at all (REST needs
 * `cors_allowed_origins`). A refused token is final - REST would refuse it too.
 */

/** After falling back to REST, WebSocket is tried again after this long. */
export const WS_RETRY_MS = 60_000;

export interface HaBackendOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly entityId: string;
  readonly remoteId?: string;
  /** All configured devices (the WebSocket subscribes to every one of them). */
  readonly devices?: readonly { readonly entityId: string; readonly remoteId?: string }[];
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly wsFactory?: WsFactory;
  readonly now?: () => number;
}

export interface HaBackend extends TvBackend {
  /** "ws" or "rest": what the last successful state read used. */
  transport(): "ws" | "rest";
  watch(listener: () => void): void;
  /** Switches the device commands and reads go to. */
  select(entityId: string, remoteId: string): void;
  close(): void;
}

const fallbackWorthy = (error: unknown): boolean => error instanceof ApiError && (error.code === "unreachable" || error.code === "timeout");

export function createHaBackend(options: HaBackendOptions): HaBackend {
  const now = options.now ?? Date.now;
  const common = {
    baseUrl: options.baseUrl, token: options.token, entityId: options.entityId,
    ...(options.remoteId ? { remoteId: options.remoteId } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
  const ws = createHaWsBackend({ ...common, ...(options.devices ? { devices: options.devices } : {}), ...(options.wsFactory ? { wsFactory: options.wsFactory } : {}) });
  const rest = createHaRestBackend({ ...common, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  let mode: "ws" | "rest" = "ws";
  let retryWsAt = 0;

  const current = (): TvBackend => (mode === "ws" ? ws : rest);

  /** Reads on the active transport; a WebSocket that cannot be reached falls back to REST once. */
  const run = async <T>(action: (target: TvBackend) => Promise<T>): Promise<T> => {
    if (mode === "rest" && now() >= retryWsAt) mode = "ws";
    if (mode === "rest") return action(rest);
    try {
      return await action(ws);
    } catch (error) {
      if (!fallbackWorthy(error)) throw error;
      const result = await action(rest);
      mode = "rest";
      retryWsAt = now() + WS_RETRY_MS;
      return result;
    }
  };

  return {
    kind: "ha",
    get dpad() { return mode === "ws" ? ws.dpad : rest.dpad; },
    select(entityId, remoteId) { ws.select(entityId, remoteId); rest.select(entityId, remoteId); },
    transport: () => mode,
    watch: (listener) => ws.watch(listener),
    close: () => ws.close(),
    // Only reading falls back. A command goes over the transport the last read used: retrying a command
    // that may already have reached the TV over the other transport could send it twice.
    state: () => run<TvState>((target) => target.state()),
    playPause: () => current().playPause(),
    volumeStep: (direction) => current().volumeStep(direction),
    mute: (on) => current().mute(on),
    power: (on) => current().power(on),
    launch: (entry) => current().launch(entry),
    key: (key) => current().key(key),
  };
}

/** The phone's picker: WebSocket get_states, REST as fallback. */
export async function listHaEntities(options: { baseUrl: string; token: string; wsFactory?: WsFactory; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<{ players: HaChoice[]; remotes: HaChoice[] }> {
  try {
    return await listHaEntitiesWs({ baseUrl: options.baseUrl, token: options.token, ...(options.wsFactory ? { wsFactory: options.wsFactory } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  } catch (error) {
    if (!fallbackWorthy(error)) throw error;
    return listHaEntitiesRest({ baseUrl: options.baseUrl, token: options.token, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  }
}
