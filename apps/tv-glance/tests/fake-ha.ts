import type { WsLike } from "../src/tv/ha-ws";

/**
 * A fake Home Assistant WebSocket API (no network): auth handshake, get_states,
 * subscribe_entities with compressed diffs, call_service that changes the
 * fake TV and pushes the change to the subscribers.
 */

export interface FakeEntity { entity_id: string; state: string; attributes: Record<string, unknown> }

export interface FakeHaOptions {
  token?: string;
  /** The socket errors and closes instead of opening (WebSocket blocked). */
  refuse?: boolean;
  /** Never answer anything (timeouts). */
  silent?: boolean;
}

export interface ServiceCall { domain: string; service: string; service_data: Record<string, unknown>; target: { entity_id?: string } }

export function tvEntity(): FakeEntity {
  return {
    entity_id: "media_player.living_room_tv", state: "playing",
    attributes: { friendly_name: "Living Room TV", app_name: "Netflix", media_title: "The Crown", source: "Netflix", volume_level: 0.2, is_volume_muted: false, source_list: ["Netflix", "YouTube", "HDMI 1"] },
  };
}

export function fakeHaWs(options: FakeHaOptions = {}) {
  const token = options.token ?? "xxxxxxxxxxxxxxxxxxx";
  const entities = new Map<string, FakeEntity>([
    ["media_player.living_room_tv", tvEntity()],
    ["remote.living_room_tv", { entity_id: "remote.living_room_tv", state: "on", attributes: { friendly_name: "Living Room TV" } }],
    ["light.kitchen", { entity_id: "light.kitchen", state: "on", attributes: {} }],
  ]);
  const urls: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const services: ServiceCall[] = [];
  const sockets: FakeSocket[] = [];
  const subscriptions: { socket: FakeSocket; id: number; ids: string[] }[] = [];

  const mutate = (call: ServiceCall): void => {
    const id = call.target.entity_id ?? "";
    const tv = entities.get(id);
    if (!tv || call.domain !== "media_player") return;
    const before = JSON.stringify(tv);
    if (call.service === "turn_off") tv.state = "off";
    if (call.service === "turn_on") tv.state = "on";
    if (call.service === "media_play_pause") tv.state = tv.state === "playing" ? "paused" : "playing";
    if (call.service === "select_source") tv.attributes["source"] = call.service_data["source"];
    if (call.service === "volume_up") tv.attributes["volume_level"] = Math.min(1, Number(tv.attributes["volume_level"]) + 0.01);
    if (call.service === "volume_mute") tv.attributes["is_volume_muted"] = call.service_data["is_volume_muted"];
    if (JSON.stringify(tv) !== before) push(id);
    // Like the Android TV Remote integration: the remote entity follows the screen.
    const remote = entities.get(id.replace(/^media_player\./, "remote."));
    if (remote && (call.service === "turn_off" || call.service === "turn_on")) {
      const next = call.service === "turn_off" ? "off" : "on";
      if (remote.state !== next) { remote.state = next; push(remote.entity_id); }
    }
  };

  /** Sends a "c" (changed) event for `id` to every subscriber that asked for it. */
  const push = (id: string): void => {
    const entity = entities.get(id);
    if (!entity) return;
    for (const sub of subscriptions) {
      if (!sub.ids.includes(id) || sub.socket.readyState !== 1) continue;
      sub.socket.reply({ id: sub.id, type: "event", event: { c: { [id]: { "+": { s: entity.state, a: entity.attributes } } } } });
    }
  };

  class FakeSocket implements WsLike {
    readyState = 0;
    authed = false;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;

    constructor(readonly url: string) {
      urls.push(url);
      sockets.push(this);
      queueMicrotask(() => {
        if (options.refuse) { this.readyState = 3; this.onerror?.({}); this.onclose?.({}); return; }
        this.readyState = 1;
        this.onopen?.({});
        if (!options.silent) this.reply({ type: "auth_required", ha_version: "2026.10.0" });
      });
    }

    reply(message: Record<string, unknown>): void {
      queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) }); });
    }

    send(data: string): void {
      const message = JSON.parse(data) as Record<string, unknown>;
      sent.push(message);
      if (options.silent) return;
      const id = message["id"] as number;
      if (message["type"] === "auth") {
        if (message["access_token"] === token) { this.authed = true; this.reply({ type: "auth_ok", ha_version: "2026.10.0" }); }
        else this.reply({ type: "auth_invalid", message: "Invalid access token or password" });
        return;
      }
      if (!this.authed) { this.close(); return; }
      switch (message["type"]) {
        case "get_states":
          this.reply({ id, type: "result", success: true, result: [...entities.values()] });
          return;
        case "subscribe_entities": {
          const ids = (message["entity_ids"] as string[]) ?? [...entities.keys()];
          subscriptions.push({ socket: this, id, ids });
          this.reply({ id, type: "result", success: true, result: null });
          const added: Record<string, unknown> = {};
          for (const key of ids) { const e = entities.get(key); if (e) added[key] = { s: e.state, a: e.attributes, c: "ctx", lc: 1 }; }
          this.reply({ id, type: "event", event: { a: added } });
          return;
        }
        case "call_service": {
          const call: ServiceCall = { domain: String(message["domain"]), service: String(message["service"]), service_data: (message["service_data"] ?? {}) as Record<string, unknown>, target: (message["target"] ?? {}) as { entity_id?: string } };
          services.push(call);
          if (!entities.has(call.target.entity_id ?? "")) { this.reply({ id, type: "result", success: false, error: { code: "not_found", message: "Entity not found" } }); return; }
          this.reply({ id, type: "result", success: true, result: { context: {} } });
          mutate(call);
          return;
        }
        default:
          this.reply({ id, type: "result", success: false, error: { code: "unknown_command", message: "Unknown command." } });
      }
    }

    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({}));
    }
  }

  return {
    entities, urls, sent, services, sockets, subscriptions, push,
    factory: (url: string): WsLike => new FakeSocket(url),
    /** For vi.stubGlobal("WebSocket", …). */
    WebSocket: FakeSocket,
    /** Drops every open connection, like a restart of Home Assistant. */
    dropAll: () => { for (const socket of sockets) socket.close(); },
    tv: () => entities.get("media_player.living_room_tv")!,
    remote: () => entities.get("remote.living_room_tv")!,
  };
}
