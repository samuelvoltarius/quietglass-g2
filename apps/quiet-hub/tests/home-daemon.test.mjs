import { afterEach, describe, expect, it } from "vitest";
import { startHub } from "./helpers.mjs";
import { buildHomeView, createHomeView, entityFromState, kindOf, parseHomeConfig, serviceCall, CONFIRM_TTL_MS } from "../examples/quiet-hub-home.mjs";

const HA_TOKEN = "ha-secret-token-xyz";
const HA_URL = "http://ha.test:8123";

const st = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes });
const STATES = () => [
  st("light.wohnzimmer_decke", "on", { friendly_name: "Decke", brightness: 128 }),
  st("light.wohnzimmer_stehlampe", "off", { friendly_name: "Stehlampe" }),
  st("cover.wohnzimmer_links", "open", { friendly_name: "Rollo links", current_position: 100 }),
  st("cover.wohnzimmer_rechts", "closed", { friendly_name: "Rollo rechts", current_position: 0 }),
  st("sensor.wohnzimmer_temp", "21.46", { friendly_name: "Temperatur", device_class: "temperature", unit_of_measurement: "°C" }),
  st("sensor.wohnzimmer_hum", "48", { friendly_name: "Feuchte", device_class: "humidity", unit_of_measurement: "%" }),
  st("sensor.wohnzimmer_power", "120", { friendly_name: "Leistung", device_class: "power", unit_of_measurement: "W" }),
  st("binary_sensor.flur_motion", "on", { friendly_name: "Bewegung Flur", device_class: "motion" }),
  st("sensor.flur_batt", "12", { friendly_name: "Akku Sensor", device_class: "battery", unit_of_measurement: "%" }),
  st("switch.buero_drucker", "off", { friendly_name: "Drucker" }),
  st("light.buero", "unavailable", { friendly_name: "Büro" }),
  st("scene.abend", "2026-10-01T20:00:00", { friendly_name: "Abend" }),
  st("lock.haustuer", "locked", { friendly_name: "Haustür" }),
  st("cover.garage", "closed", { friendly_name: "Garage", device_class: "garage" }),
  st("alarm_control_panel.home", "disarmed", { friendly_name: "Alarm" }),
  st("media_player.tv", "on", { friendly_name: "TV" }),
];
const AREAS = [
  { id: "wohnzimmer", name: "Wohnzimmer", entities: ["light.wohnzimmer_decke", "light.wohnzimmer_stehlampe", "cover.wohnzimmer_links", "cover.wohnzimmer_rechts", "sensor.wohnzimmer_temp", "sensor.wohnzimmer_hum", "sensor.wohnzimmer_power", "media_player.tv"] },
  { id: "flur", name: "Flur", entities: ["binary_sensor.flur_motion", "sensor.flur_batt", "lock.haustuer", "alarm_control_panel.home"] },
  { id: "buero", name: "Büro", entities: ["switch.buero_drucker", "light.buero"] },
  { id: "garage", name: "Garage", entities: ["cover.garage"] },
  { id: "keller", name: "Keller", entities: ["media_player.tv"] },
];

/** A fake Home Assistant: /api/states, /api/template, /api/services/<d>/<s>. Never the real one. */
function fakeHa() {
  const states = new Map(STATES().map((s) => [s.entity_id, s]));
  const calls = [];
  const seen = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    seen.push(`${init.method ?? "GET"} ${u.pathname}`);
    if (`${u.protocol}//${u.host}` !== HA_URL) return json({ error: "wrong host" }, 500);
    if (init.headers?.Authorization !== `Bearer ${HA_TOKEN}`) return json({ message: "401" }, 401);
    if (u.pathname === "/api/states") return json([...states.values()]);
    if (u.pathname === "/api/template") return new Response(JSON.stringify(AREAS), { status: 200, headers: { "Content-Type": "text/plain" } });
    if (u.pathname === "/api/services") return json([]);
    const m = u.pathname.match(/^\/api\/services\/(\w+)\/(\w+)$/);
    if (m && init.method === "POST") {
      const data = JSON.parse(init.body);
      calls.push({ domain: m[1], service: m[2], data });
      for (const id of [].concat(data.entity_id)) {
        const s = states.get(id);
        if (!s) continue;
        const next = { turn_on: "on", turn_off: "off", open_cover: "open", close_cover: "closed", lock: "locked", unlock: "unlocked", alarm_arm_away: "armed_away", alarm_disarm: "disarmed" }[m[2]];
        if (m[2] === "toggle") s.state = s.state === "on" ? "off" : "on";
        else if (next) s.state = next;
        if (typeof data.brightness_pct === "number") s.attributes = { ...s.attributes, brightness: Math.round(data.brightness_pct * 2.55) };
      }
      return json([]);
    }
    return json({ error: "not found" }, 404);
  };
  return { fetchImpl, calls, seen, states };
}

describe("home view model (pure)", () => {
  const config = (env = {}) => parseHomeConfig({ HA_FAVORITES: "scene.abend=Abendlicht,light.wohnzimmer_decke,lock.haustuer,sensor.nope", ...env });

  it("knows which entities are shown and which are not", () => {
    expect(kindOf(st("light.x", "on"))).toBe("light");
    expect(kindOf(st("cover.g", "closed", { device_class: "garage" }))).toBe("garage");
    expect(kindOf(st("sensor.p", "1", { device_class: "power" }))).toBeNull();
    expect(kindOf(st("binary_sensor.m", "on", { device_class: "motion" }))).toBe("motion");
    expect(kindOf(st("media_player.tv", "on"))).toBeNull();
    expect(entityFromState(st("sensor.t", "21.46", { device_class: "temperature", unit_of_measurement: "°C" }), "", "de").value).toBe("21,5 °C");
    expect(entityFromState(st("light.l", "on", { brightness: 255 })).brightness).toBe(100);
  });

  it("favourites first in config order; sensitive and unknown entities are hidden by default", () => {
    const view = buildHomeView({ states: STATES(), areas: AREAS, config: config() });
    expect(view.favorites).toEqual(["scene.abend", "light.wohnzimmer_decke"]);
    expect(view.entities["scene.abend"].name).toBe("Abendlicht");
    expect(view.entities["lock.haustuer"]).toBeUndefined();
    expect(view.entities["cover.garage"]).toBeUndefined();
    expect(view.entities["alarm_control_panel.home"]).toBeUndefined();
    expect(view.entities["media_player.tv"]).toBeUndefined();
    expect(view.entities["sensor.wohnzimmer_power"]).toBeUndefined();
    // An area with nothing shown (garage, keller) is left out.
    expect(view.areas.map((a) => a.name)).toEqual(["Wohnzimmer", "Flur", "Büro"]);
  });

  it("groups per area: 'all lights' and 'all covers' first, then by kind, sensors last", () => {
    const view = buildHomeView({ states: STATES(), areas: AREAS, config: config() });
    const living = view.areas[0];
    expect(living.entities.slice(0, 2)).toEqual(["group:wohnzimmer:light", "group:wohnzimmer:cover"]);
    expect(living.entities.at(-1)).toMatch(/^sensor\./);
    const lights = view.entities["group:wohnzimmer:light"];
    expect(lights).toMatchObject({ kind: "light", on: true, state: "1/2", group: true });
    expect(view.entities["group:wohnzimmer:cover"]).toMatchObject({ kind: "cover", on: true, state: "1/2" });
    // One light in an area makes no group.
    expect(view.areas.find((a) => a.id === "buero").entities.some((id) => id.startsWith("group:"))).toBe(false);
  });

  it("HA_SENSITIVE shows locks/alarm/garage, flagged sensitive", () => {
    const view = buildHomeView({ states: STATES(), areas: AREAS, config: config({ HA_SENSITIVE: "lock,garage,alarm,bogus" }) });
    expect(view.entities["lock.haustuer"]).toMatchObject({ kind: "lock", sensitive: true, on: false });
    expect(view.entities["cover.garage"]).toMatchObject({ kind: "garage", sensitive: true });
    expect(view.areas.map((a) => a.name)).toContain("Garage");
    expect(view.sensitive).toBe(true);
  });

  it("HA_AREAS picks and orders areas, HA_EXCLUDE hides entities, off hides all areas", () => {
    const view = buildHomeView({ states: STATES(), areas: AREAS, config: config({ HA_AREAS: "Büro, wohnzimmer", HA_EXCLUDE: "switch.buero_drucker" }) });
    expect(view.areas.map((a) => a.id)).toEqual(["buero", "wohnzimmer"]);
    expect(view.entities["switch.buero_drucker"]).toBeUndefined();
    expect(buildHomeView({ states: STATES(), areas: AREAS, config: config({ HA_AREAS: "off" }) }).areas).toEqual([]);
  });

  it("only allows actions that fit the kind", () => {
    const view = buildHomeView({ states: STATES(), areas: AREAS, config: config({ HA_SENSITIVE: "lock" }) });
    const e = view.entities;
    expect(serviceCall(e["light.wohnzimmer_decke"], "brightness", 40)).toEqual({ domain: "light", service: "turn_on", data: { entity_id: "light.wohnzimmer_decke", brightness_pct: 40 } });
    expect(serviceCall(e["light.wohnzimmer_decke"], "brightness", 0).service).toBe("turn_off");
    expect(serviceCall(e["switch.buero_drucker"], "brightness", 40)).toBeNull();
    expect(serviceCall(e["cover.wohnzimmer_links"], "stop").service).toBe("stop_cover");
    expect(serviceCall(e["sensor.wohnzimmer_temp"], "toggle")).toBeNull();
    expect(serviceCall(e["scene.abend"], "run")).toEqual({ domain: "scene", service: "turn_on", data: { entity_id: "scene.abend" } });
    expect(serviceCall(e["lock.haustuer"], "toggle").service).toBe("unlock");
    // Group: one on -> all off, sent as one call with the members.
    expect(serviceCall(e["group:wohnzimmer:light"], "toggle", undefined, e)).toEqual({ domain: "light", service: "turn_off", data: { entity_id: ["light.wohnzimmer_decke", "light.wohnzimmer_stehlampe"] } });
  });

  it("confirm tokens are single-use and expire", async () => {
    const ha = fakeHa();
    let clock = 1_000_000;
    const home = createHomeView({ url: HA_URL, token: HA_TOKEN, config: config({ HA_SENSITIVE: "lock" }), fetchImpl: ha.fetchImpl, now: () => clock });
    await home.refresh();
    const first = await home.action("lock.haustuer", "toggle");
    expect(first.status).toBe(202);
    expect(first.confirm.label).toBe("Haustür: aufsperren");
    expect(ha.calls).toEqual([]);
    clock += CONFIRM_TTL_MS + 1;
    expect((await home.confirm(first.confirm.token)).status).toBe(410);
    expect(ha.calls).toEqual([]);
    const second = await home.action("lock.haustuer", "toggle");
    expect((await home.confirm(second.confirm.token)).status).toBe(200);
    expect(ha.calls).toEqual([{ domain: "lock", service: "unlock", data: { entity_id: "lock.haustuer" } }]);
    expect((await home.confirm(second.confirm.token)).status).toBe(410);
    expect(home.pendingCount()).toBe(0);
  });

  it("keeps favourites when the area template fails", async () => {
    const ha = fakeHa();
    const failing = async (url, init) => (String(url).endsWith("/api/template") ? new Response("no", { status: 500 }) : ha.fetchImpl(url, init));
    const home = createHomeView({ url: HA_URL, token: HA_TOKEN, config: config(), fetchImpl: failing });
    const view = await home.refresh();
    expect(view.favorites).toEqual(["scene.abend", "light.wohnzimmer_decke"]);
    expect(view.areas).toEqual([]);
  });
});

describe("daemon /home endpoints with a fake Home Assistant", () => {
  const open = [];
  afterEach(async () => { while (open.length) await open.pop().close(); });
  async function hub(env = {}) {
    const ha = fakeHa();
    const h = await startHub({ haUrl: HA_URL, haToken: HA_TOKEN, fetchImpl: ha.fetchImpl, homeEnv: { HA_FAVORITES: "scene.abend,light.wohnzimmer_decke", ...env } });
    open.push(h);
    await h.hub.homeView.refresh();
    return { ...h, ha };
  }

  it("the report carries the view, never the HA URL or token", async () => {
    const h = await hub();
    const report = await h.api("/report");
    expect(report.json.homeView.favorites).toEqual(["scene.abend", "light.wohnzimmer_decke"]);
    expect(report.json.home.demo).toBe(false);
    const home = await h.api("/home");
    expect(home.json.configured).toBe(true);
    const text = JSON.stringify(report.json) + JSON.stringify(home.json);
    expect(text).not.toContain(HA_TOKEN);
    expect(text).not.toContain("ha.test");
  });

  it("needs the hub's own auth", async () => {
    const h = await hub();
    expect((await fetch(`${h.url}/home`)).status).toBe(401);
    expect((await fetch(`${h.url}/home/action`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("toggles a light, dims it, runs a scene and drives a cover group", async () => {
    const h = await hub();
    expect((await h.api("/home/action", { target: "light.wohnzimmer_stehlampe", action: "toggle" })).status).toBe(200);
    expect((await h.api("/home/action", { target: "light.wohnzimmer_decke", action: "brightness", value: 30 })).status).toBe(200);
    expect((await h.api("/home/action", { target: "scene.abend", action: "run" })).status).toBe(200);
    expect((await h.api("/home/action", { target: "group:wohnzimmer:cover", action: "close" })).status).toBe(200);
    expect(h.ha.calls.map((c) => `${c.domain}.${c.service}`)).toEqual(["light.toggle", "light.turn_on", "scene.turn_on", "cover.close_cover"]);
    expect(h.ha.calls[1].data.brightness_pct).toBe(30);
    // The optimistic state is in the next report already.
    const view = (await h.api("/report")).json.homeView;
    expect(view.entities["light.wohnzimmer_stehlampe"].on).toBe(true);
    expect(view.entities["group:wohnzimmer:cover"].on).toBe(false);
  });

  it("refuses entities outside the view, read-only sensors and unknown actions", async () => {
    const h = await hub();
    expect((await h.api("/home/action", { target: "media_player.tv", action: "toggle" })).status).toBe(404);
    expect((await h.api("/home/action", { target: "lock.haustuer", action: "toggle" })).status).toBe(404);
    expect((await h.api("/home/action", { target: "sensor.wohnzimmer_temp", action: "toggle" })).status).toBe(400);
    expect((await h.api("/home/action", { target: "light.wohnzimmer_decke", action: "delete" })).status).toBe(400);
    expect((await h.api("/home/action", { target: "light.buero", action: "toggle" })).status).toBe(409);
    expect(h.ha.calls).toEqual([]);
  });

  it("a lock needs the second request with the token", async () => {
    const h = await hub({ HA_SENSITIVE: "lock" });
    await h.hub.homeView.refresh();
    const first = await h.api("/home/action", { target: "lock.haustuer", action: "toggle" });
    expect(first.status).toBe(202);
    expect(first.json.confirm.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.ha.calls).toEqual([]);
    expect((await h.api("/home/confirm", { token: "nope" })).status).toBe(410);
    expect((await h.api("/home/confirm", { token: first.json.confirm.token })).status).toBe(200);
    expect(h.ha.calls).toEqual([{ domain: "lock", service: "unlock", data: { entity_id: "lock.haustuer" } }]);
  });

  it("a state change in HA moves the report revision (long-poll sees it)", async () => {
    const h = await hub();
    const before = (await h.api("/report")).json.rev;
    h.ha.states.get("light.wohnzimmer_decke").state = "off";
    await h.hub.homeView.refresh();
    const after = (await h.api("/report")).json;
    expect(after.rev).toBeGreaterThan(before);
    expect(after.homeView.entities["light.wohnzimmer_decke"].on).toBe(false);
  });

  it("without Home Assistant there is no view and the actions say so", async () => {
    const h = await startHub();
    open.push(h);
    expect((await h.api("/report")).json.homeView).toBeUndefined();
    expect((await h.api("/home")).json).toEqual({ configured: false });
    expect((await h.api("/home/action", { target: "x", action: "toggle" })).status).toBe(503);
  });
});
