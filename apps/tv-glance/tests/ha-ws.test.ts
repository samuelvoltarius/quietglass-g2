import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEntityEvent, createHaWsBackend, HaSocket, listHaEntitiesWs } from "../src/tv/ha-ws";
import { createHaBackend, listHaEntities, WS_RETRY_MS } from "../src/tv/ha-backend";
import { haHttpBase, haWsUrl, validateUrl } from "../src/tv/errors";
import type { HaEntity } from "../src/tv/ha";
import { fakeHaWs, tvEntity } from "./fake-ha";

// Home Assistant over the WebSocket API, against a fake socket: never a real Home Assistant.
const BASE = "https://ha.example:8123";
const TOKEN = "xxxxxxxxxxxxxxxxxxx";
const ENTITY = "media_player.living_room_tv";
const REMOTE = "remote.living_room_tv";

afterEach(() => { vi.useRealTimers(); });

describe("addresses", () => {
  it("derives the WebSocket address from http, https, ws, wss and a pasted /api/websocket", () => {
    expect(haWsUrl("http://192.168.1.5:8123")).toBe("ws://192.168.1.5:8123/api/websocket");
    expect(haWsUrl("https://ha.example:8123/")).toBe("wss://ha.example:8123/api/websocket");
    expect(haWsUrl("wss://abcdef.ui.nabu.casa")).toBe("wss://abcdef.ui.nabu.casa/api/websocket");
    expect(haWsUrl("https://abcdef.ui.nabu.casa/api/websocket")).toBe("wss://abcdef.ui.nabu.casa/api/websocket");
    expect(haWsUrl("ws://homeassistant.local:8123/api")).toBe("ws://homeassistant.local:8123/api/websocket");
    expect(haHttpBase("wss://abcdef.ui.nabu.casa/api/websocket")).toBe("https://abcdef.ui.nabu.casa");
    expect(haHttpBase("ws://10.0.0.2:8123")).toBe("http://10.0.0.2:8123");
  });

  it("ws/wss are accepted only for Home Assistant", () => {
    expect(validateUrl("wss://abcdef.ui.nabu.casa", true).valid).toBe(true);
    expect(validateUrl("wss://abcdef.ui.nabu.casa").valid).toBe(false);
  });
});

describe("the socket", () => {
  it("authenticates with the token in the auth message only, then answers calls by id", async () => {
    const ha = fakeHaWs();
    const socket = new HaSocket({ baseUrl: BASE, token: TOKEN, wsFactory: ha.factory });
    const states = await socket.call({ type: "get_states" });
    expect(ha.urls).toEqual(["wss://ha.example:8123/api/websocket"]);
    expect(ha.urls[0]).not.toContain(TOKEN);
    expect(ha.sent[0]).toEqual({ type: "auth", access_token: TOKEN });
    expect(Array.isArray(states)).toBe(true);
    expect(ha.sent[1]).toEqual({ type: "get_states", id: 1 });
    socket.close();
  });

  it("a wrong token is auth (final), a blocked socket unreachable, silence a timeout", async () => {
    await expect(new HaSocket({ baseUrl: BASE, token: "wrong", wsFactory: fakeHaWs().factory }).connect()).rejects.toMatchObject({ code: "auth" });
    await expect(new HaSocket({ baseUrl: BASE, token: TOKEN, wsFactory: fakeHaWs({ refuse: true }).factory }).connect()).rejects.toMatchObject({ code: "unreachable" });
    await expect(new HaSocket({ baseUrl: BASE, token: TOKEN, wsFactory: () => { throw new Error("blocked"); } }).connect()).rejects.toMatchObject({ code: "unreachable" });
    vi.useFakeTimers();
    const pending = new HaSocket({ baseUrl: BASE, token: TOKEN, timeoutMs: 1000, wsFactory: fakeHaWs({ silent: true }).factory }).connect().catch((e: { code: string }) => e.code);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await pending).toBe("timeout");
  });

  it("a failed result maps not_found to missing", async () => {
    const ha = fakeHaWs();
    const socket = new HaSocket({ baseUrl: BASE, token: TOKEN, wsFactory: ha.factory });
    await expect(socket.call({ type: "call_service", domain: "media_player", service: "turn_on", service_data: {}, target: { entity_id: "media_player.nope" } })).rejects.toMatchObject({ code: "missing" });
    socket.close();
  });
});

describe("subscribe_entities diffs", () => {
  it("applies added, changed (+ and -) and removed", () => {
    const known = new Map<string, HaEntity>();
    applyEntityEvent(known, { a: { [ENTITY]: { s: "on", a: { volume_level: 0.1, media_title: "X" } } } });
    expect(known.get(ENTITY)).toEqual({ entity_id: ENTITY, state: "on", attributes: { volume_level: 0.1, media_title: "X" } });
    applyEntityEvent(known, { c: { [ENTITY]: { "+": { s: "playing", a: { volume_level: 0.3 } }, "-": { a: ["media_title"] } } } });
    expect(known.get(ENTITY)).toEqual({ entity_id: ENTITY, state: "playing", attributes: { volume_level: 0.3 } });
    applyEntityEvent(known, { c: { [ENTITY]: { "+": { a: { is_volume_muted: true } } } } });
    expect(known.get(ENTITY)?.state).toBe("playing");
    applyEntityEvent(known, { r: [ENTITY] });
    expect(known.size).toBe(0);
  });
});

describe("WebSocket backend", () => {
  it("reads the TV from the subscription and calls services with a target", async () => {
    const ha = fakeHaWs();
    const tv = createHaWsBackend({ baseUrl: "http://192.168.1.5:8123", token: TOKEN, entityId: ENTITY, remoteId: REMOTE, wsFactory: ha.factory });
    const state = await tv.state();
    expect(state).toMatchObject({ name: "Living Room TV", power: "on", activity: "playing", app: "Netflix", volume: 20 });
    expect(ha.urls).toEqual(["ws://192.168.1.5:8123/api/websocket"]);
    expect(ha.sent.find((m) => m["type"] === "subscribe_entities")).toMatchObject({ entity_ids: [ENTITY, REMOTE] });
    await tv.playPause();
    await tv.volumeStep(1);
    await tv.mute(true);
    await tv.power(false);
    await tv.launch({ label: "YouTube", id: "YouTube" });
    await tv.launch({ label: "Kodi", id: "org.xbmc.kodi" });
    await tv.key("DPAD_UP");
    expect(ha.services.map((c) => `${c.domain}.${c.service}`)).toEqual([
      "media_player.media_play_pause", "remote.send_command", "media_player.volume_mute", "media_player.turn_off",
      "media_player.select_source", "media_player.play_media", "remote.send_command",
    ]);
    expect(ha.services[1]).toMatchObject({ service_data: { command: "VOLUME_UP" }, target: { entity_id: REMOTE } });
    expect(ha.services[2]).toMatchObject({ service_data: { is_volume_muted: true }, target: { entity_id: ENTITY } });
    expect(ha.services[4]?.service_data).toEqual({ source: "YouTube" });
    expect(ha.services[5]?.service_data).toEqual({ media_content_type: "app", media_content_id: "org.xbmc.kodi" });
    expect(ha.services[6]).toMatchObject({ service_data: { command: "DPAD_UP" }, target: { entity_id: REMOTE } });
    expect(ha.sockets).toHaveLength(1); // one connection for everything
    tv.close();
  });

  it("live updates: a change pushed by Home Assistant calls the watcher and shows in the next read", async () => {
    const ha = fakeHaWs();
    const tv = createHaWsBackend({ baseUrl: BASE, token: TOKEN, entityId: ENTITY, wsFactory: ha.factory });
    const changes: number[] = [];
    tv.watch(() => changes.push(1));
    await tv.state();
    ha.tv().attributes["media_title"] = "Another Show";
    ha.push(ENTITY);
    await vi.waitFor(() => expect(changes.length).toBe(1));
    expect((await tv.state()).title).toBe("Another Show");
    expect(tv.dpad).toBe(false);
    await expect(tv.key("HOME")).rejects.toMatchObject({ code: "unsupported" });
    tv.close();
  });

  it("an unknown entity is missing; a dropped connection is opened again on the next read", async () => {
    const ha = fakeHaWs();
    await expect(createHaWsBackend({ baseUrl: BASE, token: TOKEN, entityId: "media_player.gone", wsFactory: ha.factory }).state()).rejects.toMatchObject({ code: "missing" });
    const tv = createHaWsBackend({ baseUrl: BASE, token: TOKEN, entityId: ENTITY, wsFactory: ha.factory });
    let dropped = 0;
    tv.watch(() => { dropped += 1; });
    await tv.state();
    const before = ha.sockets.length;
    ha.dropAll();
    await vi.waitFor(() => expect(dropped).toBeGreaterThan(0));
    ha.tv().state = "paused";
    expect((await tv.state()).activity).toBe("paused");
    expect(ha.sockets.length).toBe(before + 1);
    tv.close();
  });

  it("the phone's picker uses get_states over a short connection", async () => {
    const ha = fakeHaWs();
    const found = await listHaEntitiesWs({ baseUrl: BASE, token: TOKEN, wsFactory: ha.factory });
    expect(found.players.map((p) => p.id)).toEqual([ENTITY]);
    expect(found.remotes.map((r) => r.id)).toEqual([REMOTE]);
    await vi.waitFor(() => expect(ha.sockets[0]?.readyState).toBe(3));
  });
});

describe("REST only as fallback", () => {
  const restFetch = () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      const path = new URL(String(input)).pathname;
      if (path === "/api/states") return new Response(JSON.stringify([tvEntity()]));
      if (path === `/api/states/${ENTITY}`) return new Response(JSON.stringify(tvEntity()));
      return new Response("[]");
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it("uses WebSocket and never REST when the socket works", async () => {
    const ha = fakeHaWs();
    const rest = restFetch();
    const tv = createHaBackend({ baseUrl: BASE, token: TOKEN, entityId: ENTITY, wsFactory: ha.factory, fetchImpl: rest.fetchImpl });
    await tv.state();
    await tv.playPause();
    expect(tv.transport()).toBe("ws");
    expect(rest.calls).toEqual([]);
    tv.close();
  });

  it("falls back to REST when the socket cannot be reached; commands then go over REST; WebSocket is tried again later", async () => {
    let now = 1_000;
    const blocked = fakeHaWs({ refuse: true });
    const rest = restFetch();
    const tv = createHaBackend({ baseUrl: "wss://abcdef.ui.nabu.casa", token: TOKEN, entityId: ENTITY, wsFactory: blocked.factory, fetchImpl: rest.fetchImpl, now: () => now });
    expect((await tv.state()).app).toBe("Netflix");
    expect(tv.transport()).toBe("rest");
    expect(rest.calls[0]).toBe("https://abcdef.ui.nabu.casa/api/states/" + ENTITY);
    await tv.playPause();
    expect(rest.calls[1]).toBe("https://abcdef.ui.nabu.casa/api/services/media_player/media_play_pause");
    const sockets = blocked.sockets.length;
    await tv.state();
    expect(blocked.sockets.length).toBe(sockets); // not retried yet
    now += WS_RETRY_MS;
    await tv.state();
    expect(blocked.sockets.length).toBe(sockets + 1);
    tv.close();
  });

  it("a refused token never falls back", async () => {
    const rest = restFetch();
    const tv = createHaBackend({ baseUrl: BASE, token: "wrong", entityId: ENTITY, wsFactory: fakeHaWs().factory, fetchImpl: rest.fetchImpl });
    await expect(tv.state()).rejects.toMatchObject({ code: "auth" });
    expect(rest.calls).toEqual([]);
    await expect(listHaEntities({ baseUrl: BASE, token: "wrong", wsFactory: fakeHaWs().factory, fetchImpl: rest.fetchImpl })).rejects.toMatchObject({ code: "auth" });
    const viaRest = await listHaEntities({ baseUrl: BASE, token: TOKEN, wsFactory: fakeHaWs({ refuse: true }).factory, fetchImpl: rest.fetchImpl });
    expect(viaRest.players.map((p) => p.id)).toEqual([ENTITY]);
  });
});
