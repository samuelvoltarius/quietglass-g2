import { afterEach, describe, expect, it } from "vitest";
import { startHub, TOKEN, until, sleep } from "./helpers.mjs";

const open = [];
async function hub(options) {
  const h = await startHub(options);
  open.push(h);
  return h;
}
afterEach(async () => { while (open.length) await open.pop().close(); });

const register = (api) => api("/relay/register", { machine: "win", agents: [{ id: "claude-win", kind: "claude", mode: "ask" }] });

/** Home Assistant + Moonraker mock; records every call. */
function world({ services, printerState = "printing" } = {}) {
  const calls = [];
  const state = { printer: printerState };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("http://ha.test")) {
      const path = u.replace("http://ha.test", "");
      calls.push({ method: init.method ?? "GET", path, body: init.body ? JSON.parse(init.body) : null });
      if (path === "/api/states") return new Response("[]", { status: 200 });
      if (path === "/api/services") return new Response(JSON.stringify(services ?? []), { status: 200 });
      return new Response("[]", { status: 200 });
    }
    if (u.startsWith("http://moon.test")) {
      return new Response(JSON.stringify({ result: { status: { print_stats: { state: state.printer, filename: "a.gcode", print_duration: 600 }, display_status: { progress: 0.5 }, extruder: { temperature: 200 }, heater_bed: { temperature: 60 } } } }), { status: 200 });
    }
    return fetch(url, init);
  };
  return { calls, state, fetchImpl };
}
const notifyCalls = (w) => w.calls.filter((c) => c.method === "POST" && c.path.startsWith("/api/services/notify/"));
const base = { haUrl: "http://ha.test", haToken: "t", haDevices: [{ entity: "light.office", label: "Büro" }] };
const phoneServices = [
  { domain: "light", services: { toggle: {} } },
  { domain: "notify", services: { notify: {}, persistent_notification: {}, mobile_app_pixel: {}, mobile_app_ipad: {} } },
];

describe("phone mirror via Home Assistant notify", () => {
  it("auto-detects the first notify.mobile_app_* service (read-only) and mirrors waiting/done/error", async () => {
    const w = world({ services: phoneServices });
    const h = await hub({ ...base, fetchImpl: w.fetchImpl });
    await h.api("/events", { provider: "claude-win", status: "waiting", title: "Freigabe: Bash: npm test" });
    await until(() => notifyCalls(w).length === 1);
    expect(w.calls.filter((c) => c.path === "/api/services").every((c) => c.method === "GET")).toBe(true);
    expect(notifyCalls(w)[0].path).toBe("/api/services/notify/mobile_app_pixel");
    expect(notifyCalls(w)[0].body).toEqual({ title: "claude-win: wartet", message: "Freigabe: Bash: npm test" });
    await h.api("/events", { provider: "claude-win", status: "done", title: "Antwort fertig" });
    await h.api("/events", { provider: "claude-win", status: "error", title: "Build kaputt" });
    await until(() => notifyCalls(w).length === 3);
    expect(notifyCalls(w).map((c) => c.body.title)).toEqual(["claude-win: wartet", "claude-win: fertig", "claude-win: Fehler"]);
    // detection happened once
    expect(w.calls.filter((c) => c.path === "/api/services").length).toBe(1);
  });

  it("a permission request from a relay is mirrored too", async () => {
    const w = world({ services: phoneServices });
    const h = await hub({ ...base, fetchImpl: w.fetchImpl });
    await register(h.api);
    h.api("/relay/permission", { agentId: "claude-win", tool: "Bash", summary: "npm test" }).catch(() => undefined);
    await until(() => notifyCalls(w).length === 1);
    expect(notifyCalls(w)[0].body.message).toContain("Bash: npm test");
  });

  it("HA_NOTIFY_SERVICE pins the service and skips detection", async () => {
    const w = world({ services: phoneServices });
    const h = await hub({ ...base, fetchImpl: w.fetchImpl, haNotifyService: "notify.mobile_app_ipad" });
    await h.api("/events", { provider: "x", status: "done", title: "ok" });
    await until(() => notifyCalls(w).length === 1);
    expect(notifyCalls(w)[0].path).toBe("/api/services/notify/mobile_app_ipad");
    expect(w.calls.some((c) => c.path === "/api/services")).toBe(false);
  });

  it("is off when no mobile_app service exists", async () => {
    const w = world({ services: [{ domain: "notify", services: { notify: {}, persistent_notification: {} } }] });
    const h = await hub({ ...base, fetchImpl: w.fetchImpl });
    await h.api("/events", { provider: "x", status: "done", title: "ok" });
    await until(() => w.calls.some((c) => c.path === "/api/services"));
    await sleep(60);
    expect(notifyCalls(w)).toEqual([]);
  });

  it("is off without Home Assistant and with HA_NOTIFY=off", async () => {
    const none = await hub();
    expect((await none.api("/events", { provider: "x", status: "done", title: "ok" })).status).toBe(201);
    const w = world({ services: phoneServices });
    const off = await hub({ ...base, fetchImpl: w.fetchImpl, haNotify: "off" });
    await off.api("/events", { provider: "x", status: "done", title: "ok" });
    await sleep(80);
    expect(w.calls.some((c) => c.path === "/api/services")).toBe(false);
    expect(notifyCalls(w)).toEqual([]);
  });

  it("a notify failure never breaks the event", async () => {
    const w = world({ services: phoneServices });
    const failing = async (url, init) => (String(url).includes("/api/services/notify/") ? new Response("no", { status: 500 }) : w.fetchImpl(url, init));
    const h = await hub({ ...base, fetchImpl: failing });
    expect((await h.api("/events", { provider: "x", status: "done", title: "ok" })).status).toBe(201);
    expect((await h.api("/report")).json.inbox.events.length).toBe(1);
  });

  it("a finished print is mirrored once (printing -> ready)", async () => {
    const w = world({ services: phoneServices });
    const h = await hub({ ...base, fetchImpl: w.fetchImpl, moonrakerUrl: "http://moon.test", moonPollMs: 40 });
    await until(async () => (await h.api("/report")).json.printer.state === "printing");
    w.state.printer = "complete";
    await until(() => notifyCalls(w).some((c) => c.body.message === "Druck fertig"), 8000);
    await sleep(100);
    expect(notifyCalls(w).filter((c) => c.body.message === "Druck fertig").length).toBe(1);
  }, 15000);
});

describe("voice transcribe-only and approvals", () => {
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(60, 1)]);
  const whisper = async (url, init) => (String(url).includes("8017") ? new Response(JSON.stringify({ text: "wie spät ist es" }), { status: 200 }) : fetch(url, init));

  it("ask=0 returns the transcript without asking the agent", async () => {
    const h = await hub({ fetchImpl: whisper });
    const reg = await register(h.api);
    const res = await fetch(`${h.url}/agent/voice?agentId=claude-win&wait=0&ask=0`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "audio/wav" }, body: wav });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ question: "wie spät ist es", asked: false });
    const poll = await h.api(`/relay/poll?relay=${reg.json.relayId}`);
    expect(poll.json.commands ?? []).toEqual([]);
    expect((await h.api("/report")).json.agents[0].busy).toBe(false);
  });

  it("the report names the tool of a pending approval", async () => {
    const h = await hub();
    await register(h.api);
    h.api("/relay/permission", { agentId: "claude-win", tool: "Bash", summary: "npm test" }).catch(() => undefined);
    const card = await until(async () => (await h.api("/report")).json.approvals[0]);
    expect(card).toMatchObject({ tool: "Bash", detail: "npm test", title: "Bash: npm test" });
  });
});
