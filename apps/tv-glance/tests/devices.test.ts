import { describe, expect, it } from "vitest";
import { cockpitModel, headline } from "../src/cockpit/model";
import { HEADER_WIDTH, ROW_WIDTH, appsView, startRows, startView, type ViewState } from "../src/glasses/views";
import { messages } from "../src/messages";
import {
  MAX_DEVICES, activeDeviceOf, addDevice, deviceLabel, nextActive, parseSettings, removeDevice, updateDevice, type Settings,
} from "../src/storage/persist";
import { createHaWsBackend } from "../src/tv/ha-ws";
import { createHaBackend } from "../src/tv/ha-backend";
import { parseHaState } from "../src/tv/ha";
import { DEMO_SOURCES } from "../src/tv/demo";
import { bannerFor, pillOf, tvInner } from "../src/ui/phone";
import { fakeHaWs } from "./fake-ha";

// 0.2.0: several devices (TV + projector) - settings migration, the device list, command routing, unavailable status.
const BASE = "https://ha.example:8123";
const TOKEN = "xxxxxxxxxxxxxxxxxxx";
const TV = "media_player.wohnzimmer";
const TV_REMOTE = "remote.wohnzimmer";
const BEAMER = "media_player.miprojm05";
const BEAMER_REMOTE = "remote.miprojm05";

const base = { backend: "ha", haUrl: BASE, haToken: TOKEN };
const two = { devices: [{ entityId: TV, remoteId: TV_REMOTE, name: "TV" }, { entityId: BEAMER, remoteId: BEAMER_REMOTE, name: "Beamer" }], activeDevice: 0 };

describe("settings migration", () => {
  it("an old single TV (0.1.x) becomes device 1, transparently", () => {
    const old = parseSettings(JSON.stringify({ ...base, entityId: TV, remoteId: TV_REMOTE }));
    expect(old.devices).toEqual([{ entityId: TV, remoteId: TV_REMOTE, name: "" }]);
    expect(old.activeDevice).toBe(0);
    expect(old).not.toHaveProperty("entityId");
    expect(old).not.toHaveProperty("remoteId");
    // "-" (none) and "" (automatic, never used) both mean no remote.
    expect(parseSettings(JSON.stringify({ ...base, entityId: TV, remoteId: "-" })).devices[0]?.remoteId).toBe("");
    expect(parseSettings(JSON.stringify({ ...base, entityId: TV })).devices[0]?.remoteId).toBe("");
    // Nothing chosen before: no device.
    expect(parseSettings(JSON.stringify({ ...base })).devices).toEqual([]);
  });

  it("saving writes the list only; reading it back is stable", () => {
    const migrated = parseSettings(JSON.stringify({ ...base, entityId: TV, remoteId: TV_REMOTE }));
    const written = JSON.stringify(migrated);
    expect(written).not.toContain("entityId\":\"media_player.wohnzimmer\",\"remoteId\":\"remote.wohnzimmer\",\"bridgeUrl");
    expect(JSON.parse(written)).toMatchObject({ devices: [{ entityId: TV }], activeDevice: 0 });
    expect(parseSettings(written)).toEqual(migrated);
  });

  it("the list is validated: only media_player.*, no duplicates, remote.* or none, at most 6, active index clamped", () => {
    const parsed = parseSettings(JSON.stringify({
      ...base, activeDevice: 9,
      devices: [
        { entityId: TV, remoteId: "light.x", name: "  TV  " }, { entityId: TV, remoteId: "", name: "again" },
        { entityId: "light.kitchen", remoteId: "", name: "no" }, "junk", { entityId: BEAMER, remoteId: BEAMER_REMOTE, name: "x".repeat(80) },
      ],
    }));
    expect(parsed.devices.map((d) => d.entityId)).toEqual([TV, BEAMER]);
    expect(parsed.devices[0]).toEqual({ entityId: TV, remoteId: "", name: "TV" });
    expect(parsed.devices[1]?.name).toHaveLength(40);
    expect(parsed.activeDevice).toBe(1);
    const many = parseSettings(JSON.stringify({ ...base, devices: Array.from({ length: 9 }, (_, i) => ({ entityId: `media_player.d${i}`, remoteId: "", name: "" })) }));
    expect(many.devices).toHaveLength(MAX_DEVICES);
  });
});

describe("device list helpers", () => {
  const settings = parseSettings(JSON.stringify({ ...base, ...two }));

  it("add (no duplicate, capped), rename, remove keeps the active device", () => {
    const added = addDevice(settings, { entityId: "media_player.kueche", remoteId: "", name: "Küche" });
    expect(added.devices).toHaveLength(3);
    expect(addDevice(added, { entityId: "media_player.kueche", remoteId: "", name: "x" })).toBe(added);
    expect(updateDevice(added, BEAMER, { name: "Projektor" }).devices[1]?.name).toBe("Projektor");
    expect(updateDevice(added, BEAMER, { remoteId: "" }).devices[1]?.remoteId).toBe("");
    // Removing the first device while the second is active: the same device stays active (index shifts).
    const second: Settings = { ...settings, activeDevice: 1 };
    const without = removeDevice(second, TV);
    expect(without.devices.map((d) => d.entityId)).toEqual([BEAMER]);
    expect(activeDeviceOf(without)?.entityId).toBe(BEAMER);
    // Removing the active last device: clamps to the new last one.
    expect(removeDevice(second, BEAMER).activeDevice).toBe(0);
    expect(removeDevice(settings, "media_player.unknown")).toBe(settings);
    let full = settings;
    for (let i = 0; i < 10; i += 1) full = addDevice(full, { entityId: `media_player.f${i}`, remoteId: "", name: "" });
    expect(full.devices).toHaveLength(MAX_DEVICES);
  });

  it("cycling wraps around; the label falls back to the friendly name, then the id", () => {
    expect(nextActive(settings)).toBe(1);
    expect(nextActive({ ...settings, activeDevice: 1 })).toBe(0);
    expect(nextActive({ devices: [], activeDevice: 0 })).toBe(0);
    expect(deviceLabel({ entityId: TV, remoteId: "", name: "Kino" }, "Living Room")).toBe("Kino");
    expect(deviceLabel({ entityId: TV, remoteId: "", name: "" }, "Living Room")).toBe("Living Room");
    expect(deviceLabel({ entityId: "media_player.mi_proj", remoteId: "", name: "" })).toBe("mi proj");
  });
});

describe("command routing", () => {
  it("one connection subscribes to every device; commands, key presses and reads follow select()", async () => {
    const ha = fakeHaWs();
    ha.entities.set(TV, { entity_id: TV, state: "playing", attributes: { friendly_name: "Wohnzimmer", volume_level: 0.2 } });
    ha.entities.set(BEAMER, { entity_id: BEAMER, state: "paused", attributes: { friendly_name: "Beamer", volume_level: 0.5, app_name: "Plex" } });
    ha.entities.set(BEAMER_REMOTE, { entity_id: BEAMER_REMOTE, state: "on", attributes: {} });
    const backend = createHaWsBackend({ baseUrl: BASE, token: TOKEN, entityId: TV, remoteId: "", wsFactory: ha.factory, devices: [{ entityId: TV, remoteId: "" }, { entityId: BEAMER, remoteId: BEAMER_REMOTE }] });
    expect((await backend.state()).name).toBe("Wohnzimmer");
    expect(backend.dpad).toBe(false);
    await backend.playPause();
    await expect(backend.key("HOME")).rejects.toMatchObject({ code: "unsupported" });

    backend.select(BEAMER, BEAMER_REMOTE);
    expect(backend.dpad).toBe(true);
    expect(await backend.state()).toMatchObject({ name: "Beamer", app: "Plex", volume: 50 });
    await backend.volumeStep(1);
    await backend.power(true);
    await backend.mute(true);
    await backend.key("DPAD_CENTER");
    await backend.launch({ label: "Kodi", id: "org.xbmc.kodi" });

    expect(ha.services.map((c) => `${c.domain}.${c.service}→${c.target.entity_id}`)).toEqual([
      `media_player.media_play_pause→${TV}`,
      `remote.send_command→${BEAMER_REMOTE}`, `media_player.turn_on→${BEAMER}`, `media_player.volume_mute→${BEAMER}`,
      `remote.send_command→${BEAMER_REMOTE}`, `media_player.play_media→${BEAMER}`,
    ]);
    const subscribes = ha.sent.filter((m) => m["type"] === "subscribe_entities");
    expect(subscribes).toHaveLength(1);
    expect((subscribes[0]?.["entity_ids"] as string[]).sort()).toEqual([BEAMER, BEAMER_REMOTE, TV].sort());
    expect(ha.sockets).toHaveLength(1);

    // Live state of the active device; a change of the other one does not disturb it.
    ha.entities.get(BEAMER)!.attributes["media_title"] = "Film";
    ha.push(BEAMER);
    await new Promise((done) => setTimeout(done, 20));
    expect((await backend.state()).title).toBe("Film");
    backend.close();
  });

  it("a device that was not subscribed is subscribed again on select(); the combined backend routes REST as well", async () => {
    const ha = fakeHaWs();
    ha.entities.set(BEAMER, { entity_id: BEAMER, state: "on", attributes: { friendly_name: "Beamer" } });
    const ws = createHaWsBackend({ baseUrl: BASE, token: TOKEN, entityId: "media_player.living_room_tv", wsFactory: ha.factory });
    await ws.state();
    ws.select(BEAMER, "");
    expect((await ws.state()).name).toBe("Beamer");
    expect(ha.sent.filter((m) => m["type"] === "subscribe_entities")).toHaveLength(2);
    ws.close();

    const urls: string[] = [];
    const fetchImpl = (async (input: string) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ entity_id: BEAMER, state: "on", attributes: {} }));
    }) as unknown as typeof fetch;
    const blocked = fakeHaWs({ refuse: true });
    const combined = createHaBackend({ baseUrl: BASE, token: TOKEN, entityId: TV, wsFactory: blocked.factory, fetchImpl });
    combined.select(BEAMER, "");
    await combined.state();
    expect(urls[0]).toContain(BEAMER);
    combined.close();
  });
});

describe("unavailable devices", () => {
  const unavailable = parseHaState({ entity_id: BEAMER, state: "unavailable", attributes: { friendly_name: "Beamer" } });
  const TVSTATE = { ...unavailable, name: "Beamer", sources: [...DEMO_SOURCES] };

  function view(over: Partial<ViewState> = {}): ViewState {
    return {
      locale: "de", demo: false, connection: { kind: "ok" }, tv: TVSTATE, dpad: true, entries: [], pendingVolume: 0, flash: null, armed: false, now: 0,
      device: { name: "Beamer", index: 1, count: 2 },
      ...over,
    };
  }

  it("is a state of its own, not an error", () => {
    expect(unavailable).toMatchObject({ unavailable: true, power: "unknown", name: "Beamer" });
    expect(parseHaState({ entity_id: TV, state: "off", attributes: {} })).not.toHaveProperty("unavailable");
  });

  it("start page, cockpit and phone say so clearly (DE and EN)", () => {
    expect(startView(view(), 0).body[0]).toBe("● Fernbedienung · nicht verfügbar");
    expect(startView(view({ locale: "en" }), 0).body[0]).toBe("● Remote · unavailable");
    expect(headline(view())).toEqual(["NICHT VERFÜGBAR", "BEAMER"]);
    expect(headline(view({ locale: "en" }))).toEqual(["UNAVAILABLE", "BEAMER"]);
    const model = cockpitModel(view());
    expect(model.tone).toBe("warn");
    expect(model.caption).toBe("Beamer");
    expect(model.cells[0]?.value).toBe("OFFLINE");
    // Only the way back is offered, never a command that cannot be sent.
    expect(model.hint).toBe("2× = zurück");
    expect(appsView(view(), 0).body.join("|")).toContain("Gerät nicht verfügbar");
    expect(pillOf(view(), { kind: "ok" })).toEqual({ text: "nicht verfügbar", on: false });
    expect(bannerFor(view(), { kind: "ok" }, parseSettings(JSON.stringify({ ...base, ...two })))).toMatchObject({ tone: "offline" });
    expect(bannerFor(view(), { kind: "ok" }, parseSettings(JSON.stringify({ ...base, ...two }))).text).toContain("Beamer ist nicht verfügbar");
  });
});

describe("glasses: the device switch", () => {
  const tv = { name: "Wohnzimmer", power: "on", activity: "playing", app: "Netflix", title: null, source: null, volume: 20, muted: false, sources: [], apps: [] } as const;
  const state = (over: Partial<ViewState> = {}): ViewState => ({
    locale: "de", demo: false, connection: { kind: "ok" }, tv, dpad: true, entries: [], pendingVolume: 0, flash: null, armed: false, now: 0, ...over,
  });

  it("the switch row exists only with two or more devices, and is last", () => {
    expect(startRows({ dpad: true })).toEqual(["remote", "apps", "dpad"]);
    expect(startRows({ dpad: true, device: { name: "TV", index: 0, count: 1 } })).toEqual(["remote", "apps", "dpad"]);
    expect(startRows({ dpad: true, device: { name: "TV", index: 0, count: 2 } })).toEqual(["remote", "apps", "dpad", "device"]);
    expect(startRows({ dpad: false, device: { name: "TV", index: 0, count: 3 } })).toEqual(["remote", "apps", "device"]);
  });

  it("header carries the device name (only with a choice), the row shows the position; tap word is 'switch', never hold", () => {
    const device = { name: "Beamer", index: 1, count: 2 };
    const view = startView(state({ device }), 3);
    expect(view.header).toBe("TV Glance · Beamer · ● live");
    expect(view.body[3]).toBe("● Gerät: Beamer (2/2)");
    expect(view.footer).toBe("Tippen = Gerät wechseln · Wischen = wählen · 2× = Ende");
    expect(startView(state({ device }), 0).footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
    expect(startView(state({ device: { ...device, count: 1 } }), 0).header).toBe("TV Glance · ● live");
    expect(appsView(state({ device }), 0).header).toBe("Apps & Eingang · Beamer · ● live");
  });

  it("long names never push the live word out of the header and every line fits", () => {
    const device = { name: "Ein sehr langer Gerätename für das Kino im Keller", index: 0, count: 2 };
    for (const locale of ["de", "en"] as const) {
      const view = startView(state({ locale, device }), 3);
      expect(view.header.length).toBeLessThanOrEqual(HEADER_WIDTH);
      expect(view.header.endsWith("● live")).toBe(true);
      for (const row of [...view.body, view.footer]) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
    }
  });

  it("the new strings exist in both languages and never offer a hold", () => {
    const keys = ["g.start.device", "g.f.switch", "g.unavailable", "g.err.unavailable", "g.cp.unavailable", "g.cp.offline", "p.dev.title", "p.dev.switchHint", "p.banner.unavailable", "p.pill.unavailable"];
    for (const key of keys) {
      expect(messages.de[key], key).toBeTruthy();
      expect(messages.en[key], key).toBeTruthy();
    }
    for (const locale of ["de", "en"] as const) {
      for (const key of Object.keys(messages[locale]).filter((k) => /^(g\.|p\.dev|p\.c\.)/.test(k))) {
        expect(messages[locale][key]!.toLowerCase(), key).not.toMatch(/bhaltenb|bholdb|long.?press/);
      }
    }
  });
});

describe("phone: devices", () => {
  const settings = parseSettings(JSON.stringify({ ...base, ...two }));
  const entities = {
    players: [{ id: TV, name: "Wohnzimmer", state: "on" }, { id: BEAMER, name: "Projector", state: "unavailable" }, { id: "media_player.kueche", name: "Küche", state: "off" }],
    remotes: [{ id: TV_REMOTE, name: "Wohnzimmer", state: "on" }, { id: BEAMER_REMOTE, name: "Projector", state: "unavailable" }],
  };

  it("lists the devices with rename field, remote choice and remove; players already added are marked", () => {
    const html = tvInner(settings, "de", entities, "");
    expect(html).toContain('data-dev-name="media_player.wohnzimmer"');
    expect(html).toContain('value="Beamer"');
    expect(html).toContain('data-dev-remote="media_player.miprojm05"');
    expect(html).toContain('<option value="remote.miprojm05" selected>');
    expect(html).toContain('data-dev-remove="media_player.miprojm05"');
    expect(html).toMatch(/class="choice on" data-player="media_player.wohnzimmer"/);
    expect(html).toMatch(/class="choice" data-player="media_player.kueche"/);
    expect(html).toContain("aktiv auf der Brille");
    expect(html).toContain("Zeile „Gerät“"); // the switch hint, only with two or more devices
  });

  it("no device yet: the hint says how to add; no switch hint for one device", () => {
    const empty = parseSettings(JSON.stringify({ ...base }));
    expect(tvInner(empty, "en", null, "")).toContain("No device yet");
    const one = parseSettings(JSON.stringify({ ...base, entityId: TV, remoteId: TV_REMOTE }));
    expect(tvInner(one, "en", null, "")).not.toContain("“Device” row");
  });
});
