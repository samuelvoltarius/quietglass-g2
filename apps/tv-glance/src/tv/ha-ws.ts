import type { TvBackend } from "./backend";
import { ApiError, DEFAULT_TIMEOUT_MS, haWsUrl, toApiError } from "./errors";
import { parseHaChoices, parseHaState, withRemote, type HaChoice, type HaEntity } from "./ha";
import type { AppEntry, DpadKey, TvState } from "./model";

/**
 * Home Assistant over its WebSocket API (`/api/websocket`) - the main path.
 *
 *   <- {type:"auth_required"}
 *   -> {type:"auth", access_token}
 *   <- {type:"auth_ok"} | {type:"auth_invalid", message}
 *   -> {id, type:"subscribe_entities", entity_ids:[tv, remote]}   live state (compressed diffs)
 *   -> {id, type:"get_states"}                                     the picker on the phone
 *   -> {id, type:"call_service", domain, service, service_data, target:{entity_id}}
 *   <- {id, type:"result", success, result | error}
 *   <- {id, type:"event", event:{a | c | r}}
 *
 * Why WebSocket: a browser applies no CORS to WebSocket connections, and
 * Home Assistant's websocket_api does not check the Origin header (read in
 * its source: http.py / auth.py of components/websocket_api). So it works
 * with only the address and a long-lived token - no `cors_allowed_origins`.
 * The token goes only in the auth message to the address the user entered.
 */

/** The part of a browser WebSocket used here (fakeable in tests). */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

export const defaultWsFactory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;

const OPEN = 1;

export interface HaSocketOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly wsFactory?: WsFactory;
}

type EventListener = (event: Record<string, unknown>) => void;

/**
 * One authenticated connection. `connect()` resolves after auth_ok; a closed
 * socket is opened again by the next call. Pending calls fail when it closes.
 */
export class HaSocket {
  private socket: WsLike | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: ApiError) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly events = new Map<number, EventListener>();
  private closedByUs = false;
  private authed = false;
  /** Called after the socket dropped (not after close()). */
  onDrop: (() => void) | null = null;

  constructor(private readonly options: HaSocketOptions) {}

  get url(): string {
    return haWsUrl(this.options.baseUrl);
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === OPEN && this.ready !== null;
  }

  connect(): Promise<void> {
    if (this.ready && this.socket) return this.ready;
    this.closedByUs = false;
    const timeout = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const run = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: ApiError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.drop(error);
        reject(error);
      };
      const timer = setTimeout(() => fail(new ApiError("timeout")), timeout);
      let socket: WsLike;
      try {
        socket = (this.options.wsFactory ?? defaultWsFactory)(this.url);
      } catch {
        fail(new ApiError("unreachable"));
        return;
      }
      this.socket = socket;
      socket.onerror = () => fail(new ApiError("unreachable"));
      socket.onclose = () => {
        if (!settled) { fail(new ApiError("unreachable")); return; }
        this.drop(new ApiError("unreachable"));
      };
      socket.onmessage = (event) => {
        const message = parse(event.data);
        if (!message) return;
        switch (message["type"]) {
          case "auth_required":
            socket.send(JSON.stringify({ type: "auth", access_token: this.options.token }));
            return;
          case "auth_ok":
            if (!settled) { settled = true; clearTimeout(timer); this.authed = true; resolve(); }
            return;
          case "auth_invalid":
            fail(new ApiError("auth"));
            try { socket.close(); } catch { /* already closed */ }
            return;
          default:
            this.dispatch(message);
        }
      };
    });
    this.ready = run;
    return run;
  }

  /** Sends one command and waits for its result. */
  async call(message: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) throw new ApiError("unreachable");
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ApiError("timeout"));
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ ...message, id }));
    });
  }

  /** Starts a subscription; `listener` gets every event of it. Resolves with the subscription id. */
  async subscribe(message: Record<string, unknown>, listener: EventListener): Promise<number> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) throw new ApiError("unreachable");
    const id = this.nextId++;
    // Registered before sending: the first event can arrive right after the result.
    this.events.set(id, listener);
    await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.events.delete(id); reject(new ApiError("timeout")); }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject: (error) => { this.events.delete(id); reject(error); }, timer });
      socket.send(JSON.stringify({ ...message, id }));
    });
    return id;
  }

  close(): void {
    this.closedByUs = true;
    const socket = this.socket;
    this.drop(new ApiError("unreachable"));
    try { socket?.close(); } catch { /* already closed */ }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = typeof message["id"] === "number" ? message["id"] : -1;
    if (message["type"] === "result") {
      const waiting = this.pending.get(id);
      if (!waiting) return;
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      if (message["success"] === true) { waiting.resolve(message["result"]); return; }
      const error = (message["error"] ?? {}) as { code?: unknown };
      waiting.reject(new ApiError(error.code === "not_found" ? "missing" : error.code === "unauthorized" ? "auth" : "http"));
      return;
    }
    if (message["type"] === "event") {
      const event = message["event"];
      if (event && typeof event === "object") this.events.get(id)?.(event as Record<string, unknown>);
    }
  }

  private drop(error: ApiError): void {
    // Only a connection that was up counts as dropped: a failed connect must not trigger a retry loop.
    const wasUp = this.authed;
    this.authed = false;
    this.socket = null;
    this.ready = null;
    this.events.clear();
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.pending.clear();
    if (wasUp && !this.closedByUs) this.onDrop?.();
  }
}

function parse(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---- subscribe_entities: Home Assistant's compressed state diffs --------------------------

/** One entity as subscribe_entities sends it: `s` state, `a` attributes. */
interface Compressed { s?: unknown; a?: Record<string, unknown> }

/**
 * Applies one subscribe_entities event to the known entities:
 * `a` = added (full), `c` = changed (`+` sets state/attributes, `-` removes attributes), `r` = removed.
 */
export function applyEntityEvent(known: Map<string, HaEntity>, event: Record<string, unknown>): void {
  const added = event["a"];
  if (added && typeof added === "object") {
    for (const [id, raw] of Object.entries(added as Record<string, Compressed>)) {
      known.set(id, { entity_id: id, state: typeof raw?.s === "string" ? raw.s : "unknown", attributes: { ...(raw?.a ?? {}) } });
    }
  }
  const changed = event["c"];
  if (changed && typeof changed === "object") {
    for (const [id, diff] of Object.entries(changed as Record<string, { "+"?: Compressed; "-"?: { a?: string[] } }>)) {
      const before = known.get(id);
      if (!before) continue;
      const attributes = { ...(before.attributes ?? {}) };
      for (const name of diff?.["-"]?.a ?? []) delete attributes[name];
      Object.assign(attributes, diff?.["+"]?.a ?? {});
      const state = typeof diff?.["+"]?.s === "string" ? (diff["+"].s as string) : before.state;
      known.set(id, { entity_id: id, state, attributes });
    }
  }
  const removed = event["r"];
  if (Array.isArray(removed)) for (const id of removed) if (typeof id === "string") known.delete(id);
}

/** GET-states over a short WebSocket: the TV and remote candidates for the phone's picker. */
export async function listHaEntitiesWs(options: HaSocketOptions): Promise<{ players: HaChoice[]; remotes: HaChoice[] }> {
  const socket = new HaSocket(options);
  try {
    return parseHaChoices(await socket.call({ type: "get_states" }));
  } finally {
    socket.close();
  }
}

export interface HaWsBackendOptions extends HaSocketOptions {
  readonly entityId: string;
  /** `remote.…` for the D-pad; "" = none. */
  readonly remoteId?: string;
  /** Every configured device: all of them are subscribed, so switching shows live state at once. */
  readonly devices?: readonly { readonly entityId: string; readonly remoteId?: string }[];
}

export interface HaWsBackend extends TvBackend {
  /** Points commands and reads at another device (subscribes to it first if needed). */
  select(entityId: string, remoteId: string): void;
  /** Live updates: called whenever the subscription reports a change. */
  watch(listener: () => void): void;
  close(): void;
}

export function createHaWsBackend(options: HaWsBackendOptions): HaWsBackend {
  const socket = new HaSocket(options);
  let entityId = options.entityId;
  let remoteId = options.remoteId ?? "";
  const known = new Map<string, HaEntity>();
  const wanted = new Set<string>();
  const want = (...ids: (string | undefined)[]): void => { for (const id of ids) if (id) wanted.add(id); };
  want(options.entityId, options.remoteId);
  for (const device of options.devices ?? []) want(device.entityId, device.remoteId);
  /** What the current subscription covers. */
  let covered = new Set<string>();
  let subscribed: Promise<void> | null = null;
  let listener: (() => void) | null = null;
  let last: TvState | null = null;

  socket.onDrop = () => { subscribed = null; covered = new Set(); listener?.(); };

  const subscribe = (): Promise<void> => {
    // Resolves with the first event (the current state of the entities), fails with the subscription.
    subscribed ??= new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: ApiError): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new ApiError("timeout")), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const ids = [...wanted];
      covered = new Set(ids);
      socket.subscribe({ type: "subscribe_entities", entity_ids: ids }, (event) => {
        applyEntityEvent(known, event);
        const firstEvent = !done;
        finish();
        if (!firstEvent) listener?.();
      }).catch((error: unknown) => finish(toApiError(error)));
    }).catch((error: unknown) => { subscribed = null; covered = new Set(); throw error; });
    return subscribed;
  };

  const service = async (domain: string, name: string, entityId: string, data: Record<string, unknown> = {}): Promise<void> => {
    await socket.call({ type: "call_service", domain, service: name, service_data: data, target: { entity_id: entityId } });
  };
  const player = (name: string, data: Record<string, unknown> = {}): Promise<void> => service("media_player", name, entityId, data);

  return {
    kind: "ha",
    get dpad() { return remoteId !== ""; },
    select(nextEntity: string, nextRemote: string) {
      entityId = nextEntity;
      remoteId = nextRemote;
      last = null;
      want(nextEntity, nextRemote);
      // A device that was not part of the subscription: subscribe again (with everything wanted).
      if (subscribed && ![...wanted].every((id) => covered.has(id))) subscribed = null;
    },
    watch(next) { listener = next; },
    close() { listener = null; socket.close(); },
    async state() {
      await subscribe();
      const entity = known.get(entityId);
      if (!entity) throw new ApiError("missing");
      last = withRemote(parseHaState(entity), remoteId ? known.get(remoteId) : undefined);
      return last;
    },
    playPause: () => player("media_play_pause"),
    // With a remote one swipe is one key press (one step on the TV); media_player.volume_up may jump 10 %.
    volumeStep: (direction) => remoteId
      ? service("remote", "send_command", remoteId, { command: direction > 0 ? "VOLUME_UP" : "VOLUME_DOWN" })
      : player(direction > 0 ? "volume_up" : "volume_down"),
    mute: (on) => player("volume_mute", { is_volume_muted: on }),
    power: (on) => player(on ? "turn_on" : "turn_off"),
    launch(entry: AppEntry) {
      if (last?.sources.includes(entry.id)) return player("select_source", { source: entry.id });
      return player("play_media", { media_content_type: "app", media_content_id: entry.id });
    },
    async key(key: DpadKey) {
      if (!remoteId) throw new ApiError("unsupported");
      await service("remote", "send_command", remoteId, { command: key });
    },
  };
}
