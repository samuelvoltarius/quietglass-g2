import type { TvBackend } from "./backend";
import { ApiError, DEFAULT_TIMEOUT_MS, haHttpBase, requestJson } from "./errors";
import { clampVolume, type Activity, type AppEntry, type DpadKey, type Power, type TvState } from "./model";

/**
 * Home Assistant over its REST API - only the FALLBACK when the WebSocket API
 * (ha-ws.ts, the main path) cannot be reached. With a long-lived access token:
 *
 *   GET  /api/states                               the media players (and remotes) to choose from
 *   GET  /api/states/<media_player.x>              the TV's state
 *   POST /api/services/media_player/<service>      play/pause, volume, mute, on/off, source, app
 *   POST /api/services/remote/send_command         D-pad, only with a matching remote.* entity
 *                                                  (Android TV Remote integration)
 *
 * The token travels only in the Authorization header to the address the user
 * entered. Because of that header the WebView sends a CORS preflight, so REST only
 * works when Home Assistant lists the app's origin in `http: cors_allowed_origins`.
 */

export interface HaOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** `media_player.living_room_tv`. */
  readonly entityId: string;
  /** `remote.living_room_tv` for the D-pad; "" = none. */
  readonly remoteId?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** One entity as GET /api/states returns it (only the fields read here). */
export interface HaEntity {
  readonly entity_id: string;
  readonly state: string;
  readonly attributes?: Record<string, unknown>;
}

export interface HaChoice {
  readonly id: string;
  readonly name: string;
  readonly state: string;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function asEntity(raw: unknown): HaEntity | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record["entity_id"] !== "string" || typeof record["state"] !== "string") return null;
  const attributes = record["attributes"];
  return { entity_id: record["entity_id"], state: record["state"], ...(attributes && typeof attributes === "object" ? { attributes: attributes as Record<string, unknown> } : {}) };
}

/** Home Assistant's media player state in TV Glance terms. */
export function powerOf(state: string): Power {
  switch (state) {
    case "off": case "standby": return "off";
    case "on": case "idle": case "playing": case "paused": case "buffering": return "on";
    default: return "unknown";
  }
}

export function activityOf(state: string): Activity {
  switch (state) {
    case "playing": case "buffering": return "playing";
    case "paused": return "paused";
    case "on": case "idle": return "idle";
    default: return "unknown";
  }
}

export function parseHaState(raw: unknown): TvState {
  const entity = asEntity(raw);
  if (!entity) throw new ApiError("bad-reply");
  const a = entity.attributes ?? {};
  const level = typeof a["volume_level"] === "number" ? (a["volume_level"] as number) * 100 : null;
  const list = Array.isArray(a["source_list"]) ? (a["source_list"] as unknown[]).filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
  return {
    name: text(a["friendly_name"]) ?? entity.entity_id,
    power: powerOf(entity.state),
    activity: activityOf(entity.state),
    app: text(a["app_name"]) ?? text(a["app_id"]),
    title: text(a["media_title"]) ?? text(a["media_series_title"]),
    source: text(a["source"]),
    volume: clampVolume(level),
    muted: typeof a["is_volume_muted"] === "boolean" ? (a["is_volume_muted"] as boolean) : null,
    sources: list.slice(0, 30),
    apps: [],
    ...(entity.state === "unavailable" ? { unavailable: true } : {}),
  };
}

/**
 * The Android TV Remote integration keeps the media player at "idle" with the last
 * app and mute flag after the TV went to standby; its remote entity tracks the
 * screen. With a remote, its on/off decides power, and an off TV shows no app.
 */
export function withRemote(state: TvState, remote: HaEntity | undefined): TvState {
  if (!remote || state.unavailable) return state;
  if (remote.state === "off") return { ...state, power: "off", activity: "unknown", app: null, title: null, muted: null };
  if (remote.state === "on" && state.power !== "on") return { ...state, power: "on", activity: state.activity === "unknown" ? "idle" : state.activity };
  return state;
}

/** The media players and remotes of GET /api/states, for the picker on the phone. */
export function parseHaChoices(raw: unknown): { players: HaChoice[]; remotes: HaChoice[] } {
  if (!Array.isArray(raw)) throw new ApiError("bad-reply");
  const players: HaChoice[] = [];
  const remotes: HaChoice[] = [];
  for (const item of raw) {
    const entity = asEntity(item);
    if (!entity) continue;
    const choice = { id: entity.entity_id, name: text(entity.attributes?.["friendly_name"]) ?? entity.entity_id, state: entity.state };
    if (entity.entity_id.startsWith("media_player.")) players.push(choice);
    else if (entity.entity_id.startsWith("remote.")) remotes.push(choice);
  }
  const byName = (x: HaChoice, y: HaChoice): number => x.name.localeCompare(y.name);
  return { players: players.sort(byName), remotes: remotes.sort(byName) };
}

/**
 * The remote that belongs to a media player: the same object id
 * (`media_player.living_room_tv` -> `remote.living_room_tv`), otherwise one
 * with the same friendly name, otherwise none.
 */
export function matchRemote(playerId: string, players: readonly HaChoice[], remotes: readonly HaChoice[]): string {
  const objectId = playerId.replace(/^media_player\./, "");
  const same = remotes.find((remote) => remote.id === "remote." + objectId);
  if (same) return same.id;
  const name = players.find((player) => player.id === playerId)?.name;
  const named = name ? remotes.find((remote) => remote.name === name) : undefined;
  return named?.id ?? "";
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/** GET /api/states once: the TV and remote candidates. */
export async function listHaEntitiesRest(options: { baseUrl: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<{ players: HaChoice[]; remotes: HaChoice[] }> {
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const raw = await requestJson(doFetch, haHttpBase(options.baseUrl) + "/api/states", { method: "GET", headers: { Authorization: `Bearer ${options.token}` } }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return parseHaChoices(raw);
}

export interface HaRestBackend extends TvBackend {
  /** Points the commands and reads at another device. */
  select(entityId: string, remoteId: string): void;
}

export function createHaRestBackend(options: HaOptions): HaRestBackend {
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const base = haHttpBase(options.baseUrl);
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let entityId = options.entityId;
  let remoteId = options.remoteId ?? "";
  let last: TvState | null = null;

  const service = async (domain: string, name: string, data: Record<string, unknown>): Promise<void> => {
    await requestJson(doFetch, `${base}/api/services/${domain}/${name}`, { method: "POST", headers: headers(options.token), body: JSON.stringify(data) }, timeout);
  };
  const player = (name: string, extra: Record<string, unknown> = {}): Promise<void> => service("media_player", name, { entity_id: entityId, ...extra });

  return {
    kind: "ha",
    get dpad() { return remoteId !== ""; },
    select(nextEntity: string, nextRemote: string) { entityId = nextEntity; remoteId = nextRemote; last = null; },
    async state() {
      const read = (id: string): Promise<unknown> => requestJson(doFetch, `${base}/api/states/${encodeURIComponent(id)}`, { method: "GET", headers: { Authorization: `Bearer ${options.token}` } }, timeout);
      const [raw, remote] = await Promise.all([read(entityId), remoteId ? read(remoteId).catch(() => null) : Promise.resolve(null)]);
      last = withRemote(parseHaState(raw), asEntity(remote) ?? undefined);
      return last;
    },
    playPause: () => player("media_play_pause"),
    // With a remote one swipe is one key press (one step on the TV); media_player.volume_up may jump 10 %.
    volumeStep: (direction) => remoteId
      ? service("remote", "send_command", { entity_id: remoteId, command: direction > 0 ? "VOLUME_UP" : "VOLUME_DOWN" })
      : player(direction > 0 ? "volume_up" : "volume_down"),
    mute: (on) => player("volume_mute", { is_volume_muted: on }),
    power: (on) => player(on ? "turn_on" : "turn_off"),
    async launch(entry: AppEntry) {
      // A name of the TV's own source list is a source switch; anything else is an app id for play_media
      // (the Android TV Remote integration starts apps that way).
      if (last?.sources.includes(entry.id)) return player("select_source", { source: entry.id });
      return player("play_media", { media_content_type: "app", media_content_id: entry.id });
    },
    async key(key: DpadKey) {
      if (!remoteId) throw new ApiError("unsupported");
      await service("remote", "send_command", { entity_id: remoteId, command: key });
    },
  };
}
