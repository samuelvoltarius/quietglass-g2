import { describe, expect, it } from "vitest";
import { createHomeAssistant, createMoonraker, deviceFromState, parseDevices, serviceFor, shapePrinter } from "../examples/quiet-hub-adapters.mjs";

describe("Home Assistant adapter", () => {
  it("parses the allow-list with optional labels and drops garbage", () => {
    expect(parseDevices("light.office=Büro Licht, switch.plug ,, nonsense, climate.kitchen=Küche")).toEqual([
      { entity: "light.office", label: "Büro Licht" },
      { entity: "switch.plug", label: "switch.plug" },
      { entity: "climate.kitchen", label: "Küche" },
    ]);
  });

  it("maps states to the glasses vocabulary (de/en) and marks sensors read-only", () => {
    expect(deviceFromState({ entity: "light.a", label: "A" }, { state: "on", attributes: {} })).toMatchObject({ state: "an", on: true, writable: true });
    expect(deviceFromState({ entity: "light.a", label: "A" }, { state: "off", attributes: {} }, "en")).toMatchObject({ state: "off", on: false });
    expect(deviceFromState({ entity: "climate.k", label: "K" }, { state: "heat", attributes: { current_temperature: 21.5 } })).toMatchObject({ kind: "climate", state: "21,5°", on: true });
    expect(deviceFromState({ entity: "cover.j", label: "J" }, { state: "open", attributes: {} })).toMatchObject({ kind: "cover", state: "offen", on: true });
    expect(deviceFromState({ entity: "sensor.t", label: "T" }, { state: "20.44", attributes: { unit_of_measurement: "°C" } })).toMatchObject({ state: "20.4°C", writable: false });
    expect(deviceFromState({ entity: "light.a", label: "A" }, undefined)).toMatchObject({ state: "n/v", writable: false });
  });

  it("chooses the right service per domain", () => {
    expect(serviceFor("light.a", true)).toEqual(["light", "toggle"]);
    expect(serviceFor("cover.j", true)).toEqual(["cover", "close_cover"]);
    expect(serviceFor("climate.k", false)).toEqual(["climate", "turn_on"]);
    expect(serviceFor("scene.movie", false)).toEqual(["scene", "turn_on"]);
  });

  it("only allow-listed, writable devices can be switched; HA errors surface without the token", async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push([init.method ?? "GET", String(url)]);
      if (String(url).endsWith("/api/states")) return new Response(JSON.stringify([{ entity_id: "light.a", state: "off", attributes: {} }, { entity_id: "lock.door", state: "locked", attributes: {} }]), { status: 200 });
      return new Response("fail", { status: 500 });
    };
    const ha = createHomeAssistant({ url: "http://ha/", token: "SECRET", devices: "light.a=A", fetchImpl });
    await ha.refresh();
    expect(await ha.toggle("lock.door")).toMatchObject({ ok: false, status: 404 });
    const failed = await ha.toggle("light.a");
    expect(failed).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(failed)).not.toContain("SECRET");
    expect(calls.some(([, u]) => u.includes("lock"))).toBe(false);
  });

  it("an unreachable Home Assistant keeps the list but makes it read-only", async () => {
    const ha = createHomeAssistant({ url: "http://ha", token: "t", devices: "light.a=A", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
    await ha.refresh();
    expect(ha.devices()[0]).toMatchObject({ writable: false, state: "n/v" });
    expect(ha.status().lastError).toContain("ECONNREFUSED");
  });
});

describe("Moonraker adapter", () => {
  const raw = (extra = {}) => ({ result: { status: { print_stats: { state: "printing", filename: "box.gcode", print_duration: 1800, info: { current_layer: 10, total_layer: 40 }, ...extra }, display_status: { progress: 0.25 }, extruder: { temperature: 209.6 }, heater_bed: { temperature: 59.8 } } } });

  it("shapes printing, paused and idle states", () => {
    expect(shapePrinter(raw())).toMatchObject({ job: "box.gcode", state: "printing", layer: 10, layers: 40, progress: 25, etaMin: 90, nozzleC: 210, bedC: 60 });
    expect(shapePrinter(raw({ state: "paused" }))).toMatchObject({ state: "paused", job: "box.gcode" });
    expect(shapePrinter(raw({ state: "complete" }))).toMatchObject({ state: "ready", job: null, etaMin: null });
    expect(shapePrinter(raw({ state: "error" }))).toMatchObject({ state: "error", job: null });
    expect(shapePrinter({})).toMatchObject({ state: "ready", job: null });
  });

  it("controls pause/resume/cancel through /printer/print/*, nothing else", async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => { calls.push([init.method ?? "GET", String(url)]); return new Response(JSON.stringify(raw()), { status: 200 }); };
    const moon = createMoonraker({ url: "http://p:7125", fetchImpl });
    expect(await moon.control("cancel")).toMatchObject({ ok: true });
    expect(calls[0]).toEqual(["POST", "http://p:7125/printer/print/cancel"]);
    expect(await moon.control("emergency_stop")).toMatchObject({ ok: false, status: 400 });
    expect(calls.some(([, u]) => u.includes("emergency"))).toBe(false);
  });

  it("an unreachable printer is reported offline, not as stale data", async () => {
    const moon = createMoonraker({ url: "http://p", fetchImpl: async () => { throw new Error("down"); } });
    await moon.refresh();
    expect(moon.printer()).toMatchObject({ offline: true, job: null });
    expect(await moon.control("pause")).toMatchObject({ ok: false, status: 502 });
  });
});
