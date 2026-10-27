import type { TvBackend } from "./backend";
import { ApiError, DEFAULT_TIMEOUT_MS, normaliseBase, requestJson } from "./errors";
import { clampVolume, parseAppList, type AppEntry, type DpadKey, type TvState } from "./model";

/**
 * The reference Android TV bridge (examples/androidtv-bridge.py, built on
 * androidtvremote2):
 *
 *   GET  /state          {name, on, app, volume, muted, apps}
 *   POST /key   {key}    DPAD_UP … HOME, MEDIA_PLAY_PAUSE, VOLUME_UP/DOWN, VOLUME_MUTE
 *   POST /app   {app}    package name or app link
 *   POST /power {on}     on/off (the bridge sends POWER only when the state differs)
 *
 * POST bodies go as text/plain JSON and no header is added without a token:
 * behind `tailscale serve` (login check) these are CORS "simple requests"
 * without a preflight. With a token, `Authorization: Bearer` is sent and the
 * bridge answers the preflight itself.
 */

export interface BridgeOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export function parseBridgeState(raw: unknown): TvState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("bad-reply");
  const r = raw as Record<string, unknown>;
  const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
  const on = r["on"];
  const apps: AppEntry[] = Array.isArray(r["apps"])
    ? parseAppList((r["apps"] as unknown[]).map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const e = item as Record<string, unknown>;
        return typeof e["id"] === "string" ? `${typeof e["label"] === "string" ? e["label"] : e["id"]}=${e["id"]}` : "";
      }
      return "";
    }).join("\n"))
    : [];
  return {
    name: str(r["name"]) ?? "Android TV",
    power: on === true ? "on" : on === false ? "off" : "unknown",
    activity: "unknown",
    app: str(r["app_label"]) ?? str(r["app"]),
    title: str(r["title"]),
    source: null,
    volume: clampVolume(typeof r["volume"] === "number" ? (r["volume"] as number) : null),
    muted: typeof r["muted"] === "boolean" ? (r["muted"] as boolean) : null,
    sources: [],
    apps,
  };
}

export function createBridgeBackend(options: BridgeOptions): TvBackend {
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const base = normaliseBase(options.baseUrl);
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auth: Record<string, string> = options.token ? { Authorization: `Bearer ${options.token}` } : {};

  const get = (path: string): Promise<unknown> => requestJson(doFetch, base + path, Object.keys(auth).length ? { method: "GET", headers: auth } : { method: "GET" }, timeout);
  const post = async (path: string, body: Record<string, unknown>): Promise<void> => {
    await requestJson(doFetch, base + path, { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: JSON.stringify(body) }, timeout);
  };
  const key = (name: string): Promise<void> => post("/key", { key: name });

  return {
    kind: "bridge",
    dpad: true,
    state: async () => parseBridgeState(await get("/state")),
    playPause: () => key("MEDIA_PLAY_PAUSE"),
    volumeStep: (direction) => key(direction > 0 ? "VOLUME_UP" : "VOLUME_DOWN"),
    // Android TV only has a mute toggle key; the caller asks only when the state differs.
    mute: () => key("VOLUME_MUTE"),
    power: (on) => post("/power", { on }),
    launch: (entry) => post("/app", { app: entry.id }),
    key: (name: DpadKey) => key(name),
  };
}
