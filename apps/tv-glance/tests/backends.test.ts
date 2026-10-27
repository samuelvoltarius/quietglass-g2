import { describe, expect, it, vi } from "vitest";
import { createHaRestBackend as createHaBackend, listHaEntitiesRest as listHaEntities, matchRemote, parseHaChoices, parseHaState, powerOf } from "../src/tv/ha";
import { createBridgeBackend, parseBridgeState } from "../src/tv/bridge";
import { createDemo } from "../src/tv/demo";
import { ApiError, validateUrl } from "../src/tv/errors";
import { launchEntries, parseAppList, UNKNOWN_STATE } from "../src/tv/model";

// The backend adapters against fake servers: no real TV, Home Assistant or bridge is ever contacted.

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

function recorder(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = { url: String(input), method: init.method ?? "GET", headers, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const TV = {
  entity_id: "media_player.living_room_tv",
  state: "playing",
  attributes: {
    friendly_name: "Living Room TV", app_name: "Netflix", media_title: "The Crown", source: "Netflix",
    volume_level: 0.23, is_volume_muted: false, source_list: ["Netflix", "YouTube", "HDMI 1"],
  },
};
const BASE = "https://ha.example:8123";

describe("Home Assistant REST adapter (fallback)", () => {
  it("reads the TV state from GET /api/states/<entity> with the bearer token", async () => {
    const server = recorder(() => new Response(JSON.stringify(TV)));
    const ha = createHaBackend({ baseUrl: BASE + "/", token: "tok-abc", entityId: TV.entity_id, remoteId: "remote.living_room_tv", fetchImpl: server.fetchImpl });
    const state = await ha.state();
    expect(server.calls[0]?.url).toBe(BASE + "/api/states/media_player.living_room_tv");
    expect(server.calls[0]?.headers["Authorization"]).toBe("Bearer tok-abc");
    expect(state).toMatchObject({ name: "Living Room TV", power: "on", activity: "playing", app: "Netflix", title: "The Crown", source: "Netflix", volume: 23, muted: false });
    expect(state.sources).toEqual(["Netflix", "YouTube", "HDMI 1"]);
    expect(ha.dpad).toBe(true);
  });

  it("calls the media_player services with the entity id and a JSON body", async () => {
    const server = recorder(() => new Response("[]"));
    const ha = createHaBackend({ baseUrl: BASE, token: "t", entityId: TV.entity_id, fetchImpl: server.fetchImpl });
    await ha.playPause();
    await ha.volumeStep(1);
    await ha.volumeStep(-1);
    await ha.mute(true);
    await ha.power(true);
    await ha.power(false);
    expect(server.calls.map((c) => c.url.replace(BASE, ""))).toEqual([
      "/api/services/media_player/media_play_pause",
      "/api/services/media_player/volume_up",
      "/api/services/media_player/volume_down",
      "/api/services/media_player/volume_mute",
      "/api/services/media_player/turn_on",
      "/api/services/media_player/turn_off",
    ]);
    for (const call of server.calls) {
      expect(call.method).toBe("POST");
      expect(call.headers["Content-Type"]).toBe("application/json");
      expect((call.body as { entity_id: string }).entity_id).toBe(TV.entity_id);
    }
    expect(server.calls[3]?.body).toEqual({ entity_id: TV.entity_id, is_volume_muted: true });
  });

  it("a name of the source list is select_source, anything else play_media with an app id", async () => {
    const server = recorder((call) => new Response(call.method === "GET" ? JSON.stringify(TV) : "[]"));
    const ha = createHaBackend({ baseUrl: BASE, token: "t", entityId: TV.entity_id, fetchImpl: server.fetchImpl });
    await ha.state();
    await ha.launch({ label: "YouTube", id: "YouTube" });
    await ha.launch({ label: "Kodi", id: "org.xbmc.kodi" });
    expect(server.calls[1]?.url).toBe(BASE + "/api/services/media_player/select_source");
    expect(server.calls[1]?.body).toEqual({ entity_id: TV.entity_id, source: "YouTube" });
    expect(server.calls[2]?.url).toBe(BASE + "/api/services/media_player/play_media");
    expect(server.calls[2]?.body).toEqual({ entity_id: TV.entity_id, media_content_type: "app", media_content_id: "org.xbmc.kodi" });
  });

  it("sends the D-pad through remote.send_command, and refuses it without a remote entity", async () => {
    const server = recorder(() => new Response("[]"));
    const ha = createHaBackend({ baseUrl: BASE, token: "t", entityId: TV.entity_id, remoteId: "remote.living_room_tv", fetchImpl: server.fetchImpl });
    await ha.key("DPAD_UP");
    await ha.key("HOME");
    expect(server.calls[0]?.url).toBe(BASE + "/api/services/remote/send_command");
    expect(server.calls[0]?.body).toEqual({ entity_id: "remote.living_room_tv", command: "DPAD_UP" });
    expect(server.calls[1]?.body).toEqual({ entity_id: "remote.living_room_tv", command: "HOME" });
    const plain = createHaBackend({ baseUrl: BASE, token: "t", entityId: TV.entity_id, fetchImpl: server.fetchImpl });
    expect(plain.dpad).toBe(false);
    await expect(plain.key("DPAD_UP")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("maps 401 to auth, 404 to missing, 500 to http, garbage to bad-reply, a network failure to unreachable", async () => {
    const make = (response: () => Response | Promise<Response>) => createHaBackend({ baseUrl: BASE, token: "t", entityId: TV.entity_id, fetchImpl: recorder(response).fetchImpl });
    await expect(make(() => new Response("", { status: 401 })).state()).rejects.toMatchObject({ code: "auth" });
    await expect(make(() => new Response("", { status: 404 })).state()).rejects.toMatchObject({ code: "missing" });
    await expect(make(() => new Response("", { status: 500 })).state()).rejects.toMatchObject({ code: "http", status: 500 });
    await expect(make(() => new Response("<html>")).state()).rejects.toMatchObject({ code: "bad-reply" });
    await expect(make(() => { throw new TypeError("Failed to fetch"); }).state()).rejects.toMatchObject({ code: "unreachable" });
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as unknown as typeof fetch;
      const ha = createHaBackend({ baseUrl: BASE, token: "t", entityId: TV.entity_id, timeoutMs: 1000, fetchImpl: hanging });
      const pending = ha.state().catch((error: ApiError) => error.code);
      await vi.advanceTimersByTimeAsync(1100);
      expect(await pending).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists media players and remotes from GET /api/states and matches the remote by name", async () => {
    const all = [TV, { entity_id: "remote.living_room_tv", state: "on", attributes: { friendly_name: "Living Room TV" } }, { entity_id: "light.kitchen", state: "on" }, { entity_id: "media_player.kitchen_speaker", state: "idle", attributes: { friendly_name: "Kitchen" } }];
    const server = recorder(() => new Response(JSON.stringify(all)));
    const found = await listHaEntities({ baseUrl: BASE, token: "t", fetchImpl: server.fetchImpl });
    expect(server.calls[0]?.url).toBe(BASE + "/api/states");
    expect(found.players.map((p) => p.id)).toEqual(["media_player.kitchen_speaker", "media_player.living_room_tv"]);
    expect(found.remotes.map((r) => r.id)).toEqual(["remote.living_room_tv"]);
    expect(matchRemote("media_player.living_room_tv", found.players, found.remotes)).toBe("remote.living_room_tv");
    expect(matchRemote("media_player.kitchen_speaker", found.players, found.remotes)).toBe("");
    // Same friendly name, different object id.
    const renamed = parseHaChoices([{ entity_id: "media_player.tv_2", state: "on", attributes: { friendly_name: "Bedroom" } }, { entity_id: "remote.bedroom_atv", state: "on", attributes: { friendly_name: "Bedroom" } }]);
    expect(matchRemote("media_player.tv_2", renamed.players, renamed.remotes)).toBe("remote.bedroom_atv");
  });

  it("reads off/standby as off and unknown states as unknown", () => {
    expect(powerOf("off")).toBe("off");
    expect(powerOf("standby")).toBe("off");
    expect(powerOf("idle")).toBe("on");
    expect(powerOf("unavailable")).toBe("unknown");
    const off = parseHaState({ entity_id: "media_player.x", state: "off", attributes: {} });
    expect(off).toMatchObject({ power: "off", volume: null, muted: null, name: "media_player.x" });
    expect(() => parseHaState({ nope: 1 })).toThrow(ApiError);
  });
});

describe("bridge adapter", () => {
  const STATE = { name: "Shield", on: true, app: "com.netflix.ninja", app_label: "Netflix", volume: 40, muted: false, apps: [{ label: "YouTube", id: "com.google.android.youtube.tv" }, "Kodi=org.xbmc.kodi"] };

  it("reads GET /state without any header when there is no token (simple request, no preflight)", async () => {
    const server = recorder(() => new Response(JSON.stringify(STATE)));
    const bridge = createBridgeBackend({ baseUrl: "https://tv.example:8476", fetchImpl: server.fetchImpl });
    const state = await bridge.state();
    expect(server.calls[0]?.url).toBe("https://tv.example:8476/state");
    expect(server.calls[0]?.headers).toEqual({});
    expect(state).toMatchObject({ name: "Shield", power: "on", app: "Netflix", volume: 40, muted: false });
    expect(state.apps).toEqual([{ label: "YouTube", id: "com.google.android.youtube.tv" }, { label: "Kodi", id: "org.xbmc.kodi" }]);
  });

  it("posts keys, apps and power as text/plain JSON; the token only as a bearer header", async () => {
    const server = recorder(() => new Response("{\"ok\":true}"));
    const bridge = createBridgeBackend({ baseUrl: "http://192.168.1.20:8477", token: "secret-1", fetchImpl: server.fetchImpl });
    await bridge.playPause();
    await bridge.volumeStep(1);
    await bridge.volumeStep(-1);
    await bridge.mute(true);
    await bridge.key("DPAD_CENTER");
    await bridge.launch({ label: "Kodi", id: "org.xbmc.kodi" });
    await bridge.power(false);
    expect(server.calls.map((c) => [c.url.replace("http://192.168.1.20:8477", ""), c.body])).toEqual([
      ["/key", { key: "MEDIA_PLAY_PAUSE" }],
      ["/key", { key: "VOLUME_UP" }],
      ["/key", { key: "VOLUME_DOWN" }],
      ["/key", { key: "VOLUME_MUTE" }],
      ["/key", { key: "DPAD_CENTER" }],
      ["/app", { app: "org.xbmc.kodi" }],
      ["/power", { on: false }],
    ]);
    for (const call of server.calls) {
      expect(call.headers["Content-Type"]).toBe("text/plain");
      expect(call.headers["Authorization"]).toBe("Bearer secret-1");
      expect(call.url).not.toContain("secret-1");
    }
  });

  it("an unknown power state stays unknown; garbage is a bad reply", () => {
    expect(parseBridgeState({}).power).toBe("unknown");
    expect(parseBridgeState({ on: false }).power).toBe("off");
    expect(() => parseBridgeState([])).toThrow(ApiError);
  });
});

describe("demo TV", () => {
  it("reacts like a TV: play/pause, volume, mute, power, launch, keys", async () => {
    const demo = createDemo();
    expect((await demo.state()).activity).toBe("playing");
    await demo.playPause();
    expect((await demo.state()).activity).toBe("paused");
    await demo.volumeStep(1);
    await demo.volumeStep(1);
    expect((await demo.state()).volume).toBe(20);
    await demo.mute(true);
    expect((await demo.state()).muted).toBe(true);
    await demo.launch({ label: "YouTube", id: "YouTube" });
    expect((await demo.state()).app).toBe("YouTube");
    await demo.key("DPAD_UP");
    expect(demo.keys).toEqual(["DPAD_UP"]);
    await demo.power(false);
    expect((await demo.state()).power).toBe("off");
    await demo.volumeStep(1);
    expect((await demo.state()).volume).toBe(18 + 2 - 0); // ignored while off
    expect(demo.kind).toBe("demo");
  });
});

describe("addresses and app lists", () => {
  it("accepts only http/https without credentials or query", () => {
    expect(validateUrl("https://ha.example:8123").valid).toBe(true);
    expect(validateUrl("http://192.168.1.5:8123").valid).toBe(true);
    expect(validateUrl("homeassistant.local:8123").valid).toBe(false);
    expect(validateUrl("ftp://x").errors).toEqual(["p.err.urlScheme"]);
    expect(validateUrl("https://user:pw@ha.example").errors).toEqual(["p.err.urlCredentials"]);
    expect(validateUrl("https://ha.example/?token=1").errors).toEqual(["p.err.urlQuery"]);
    expect(validateUrl("").errors).toEqual(["p.err.urlRequired"]);
  });

  it("parses Name=id lines and merges sources, backend apps and the configured list without duplicates", () => {
    const list = parseAppList("YouTube=com.google.android.youtube.tv\nKodi=org.xbmc.kodi\n\nNetflix\nKodi=org.xbmc.kodi");
    expect(list).toEqual([{ label: "YouTube", id: "com.google.android.youtube.tv" }, { label: "Kodi", id: "org.xbmc.kodi" }, { label: "Netflix", id: "Netflix" }]);
    const merged = launchEntries({ ...UNKNOWN_STATE, sources: ["Netflix", "HDMI 1"], apps: [{ label: "Kodi", id: "org.xbmc.kodi" }] }, list);
    expect(merged.map((e) => e.id)).toEqual(["Netflix", "HDMI 1", "org.xbmc.kodi", "com.google.android.youtube.tv"]);
  });
});
