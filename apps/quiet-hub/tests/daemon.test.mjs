import { afterEach, describe, expect, it } from "vitest";
import { startHub, TOKEN, until, sleep, fakeChild } from "./helpers.mjs";

const open = [];
async function hub(options) {
  const h = await startHub(options);
  open.push(h);
  return h;
}
afterEach(async () => { while (open.length) await open.pop().close(); });

const register = (api, machine = "win", agents = [{ id: "claude-win", kind: "claude", mode: "ask" }]) =>
  api("/relay/register", { machine, agents });

describe("auth", () => {
  it("rejects requests without the token", async () => {
    const h = await hub();
    const res = await fetch(`${h.url}/report`);
    expect(res.status).toBe(401);
    const ok = await fetch(`${h.url}/report`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
  });
});

describe("registry and routing", () => {
  it("lists registered relay agents as online and routes an ask to the relay", async () => {
    const h = await hub();
    const reg = await register(h.api);
    expect(reg.status).toBe(200);
    const agents = (await h.api("/agents")).json.agents;
    expect(agents).toEqual([expect.objectContaining({ id: "claude-win", online: true, busy: false, machine: "win", kind: "claude" })]);

    const ask = await h.api("/agent/ask", { agentId: "claude-win", question: "Hallo", wait: false });
    expect(ask.status).toBe(202);
    const poll = await h.api(`/relay/poll?relay=${reg.json.relayId}`);
    expect(poll.json.commands).toEqual([expect.objectContaining({ type: "ask", agentId: "claude-win", prompt: "Hallo" })]);
    expect((await h.api("/agents")).json.agents[0].busy).toBe(true);

    const jobId = poll.json.commands[0].jobId;
    await h.api("/relay/result", { jobId, status: "running", text: "teil", activity: "Edit: a.ts" });
    let agent = (await h.api("/agents")).json.agents[0];
    expect(agent).toMatchObject({ answer: "teil", activity: "Edit: a.ts", busy: true });

    await h.api("/relay/result", { jobId, status: "done", text: "fertig" });
    agent = (await h.api("/agents")).json.agents[0];
    expect(agent).toMatchObject({ answer: "fertig", busy: false, activity: "" });
    expect((await h.api("/report")).json.agents[0].answer).toBe("fertig");
  });

  it("a long-poll is answered immediately when a question arrives", async () => {
    const h = await hub({ pollHoldMs: 5000 });
    const reg = await register(h.api);
    const pending = h.api(`/relay/poll?relay=${reg.json.relayId}`);
    await sleep(50);
    await h.api("/agent/ask", { agentId: "claude-win", question: "x", wait: false });
    const poll = await pending;
    expect(poll.json.commands).toHaveLength(1);
  });

  it("wait mode (legacy) returns the final answer in the same request", async () => {
    const h = await hub();
    const reg = await register(h.api);
    const asking = h.api("/agent/ask", { agentId: "claude-win", question: "q" });
    const poll = await until(async () => {
      const r = await h.api(`/relay/poll?relay=${reg.json.relayId}`);
      return r.json.commands.length ? r : null;
    });
    await h.api("/relay/result", { jobId: poll.json.commands[0].jobId, status: "done", text: "antwort" });
    const done = await asking;
    expect(done.json).toMatchObject({ answer: "antwort", status: "done" });
  });

  it("refuses unknown, busy and offline agents", async () => {
    let t = 1_000_000;
    const h = await hub({ now: () => t });
    expect((await h.api("/agent/ask", { agentId: "nope", question: "x", wait: false })).status).toBe(404);
    await register(h.api);
    expect((await h.api("/agent/ask", { agentId: "claude-win", question: "x", wait: false })).status).toBe(202);
    expect((await h.api("/agent/ask", { agentId: "claude-win", question: "y", wait: false })).status).toBe(409);
    t += 60_000; // no poll for a minute: the relay is gone
    expect((await h.api("/agents")).json.agents[0].online).toBe(false);
    await h.api("/agent/cancel", { agentId: "claude-win" });
    expect((await h.api("/agent/ask", { agentId: "claude-win", question: "z", wait: false })).status).toBe(503);
  });

  it("two machines cannot claim the same agent id", async () => {
    const h = await hub();
    await register(h.api, "a");
    expect((await register(h.api, "b")).status).toBe(409);
  });

  it("re-registering replaces the agents of that machine", async () => {
    const h = await hub();
    await register(h.api, "a", [{ id: "one", kind: "claude" }, { id: "two", kind: "codex" }]);
    await register(h.api, "a", [{ id: "one", kind: "claude" }]);
    expect((await h.api("/agents")).json.agents.map((a) => a.id)).toEqual(["one"]);
  });

  it("cancel tells the relay and frees the agent", async () => {
    const h = await hub();
    const reg = await register(h.api);
    await h.api("/agent/ask", { agentId: "claude-win", question: "lang", wait: false });
    await h.api(`/relay/poll?relay=${reg.json.relayId}`);
    const cancel = await h.api("/agent/cancel", { agentId: "claude-win" });
    expect(cancel.status).toBe(200);
    const poll = await h.api(`/relay/poll?relay=${reg.json.relayId}`);
    expect(poll.json.commands[0]).toMatchObject({ type: "cancel", agentId: "claude-win" });
    expect((await h.api("/agents")).json.agents[0]).toMatchObject({ busy: false, stopped: true });
  });

  it("the daemon's own Hermes is an agent too, and failures say so", async () => {
    const calls = [];
    const h = await hub({
      localAgent: true,
      localAgentId: "hermes-pi5",
      spawnImpl: (bin, args) => { calls.push([bin, args[0], args[2]]); const c = fakeChild(); setImmediate(() => { c.emitLines("Ja."); c.exit(0); }); return c; },
    });
    const ask = await h.api("/agent/ask", { question: "Läuft es?" });
    expect(ask.json.answer).toBe("Ja.");
    expect(calls[0][0]).toBe("hermes");
    expect(calls[0][2]).toContain("Läuft es?");
    expect((await h.api("/report")).json.inbox.events[0]).toMatchObject({ provider: "hermes-pi5", status: "done" });
  });

  it("keeps the old /report shape for old clients", async () => {
    const h = await hub();
    await register(h.api);
    const report = (await h.api("/report")).json;
    expect(report).toMatchObject({ connection: "connected", agent: { questions: expect.any(Array) }, home: { devices: expect.any(Array) }, printer: expect.any(Object), inbox: { events: [] } });
    expect(report.agents).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });
});

describe("approval flow", () => {
  it("permission request becomes a card and the glasses decide", async () => {
    const h = await hub({ approvalTimeoutMs: 5000 });
    await register(h.api);
    const request = h.api("/relay/permission", { agentId: "claude-win", tool: "Bash", summary: "rm -rf build" });
    const card = await until(async () => (await h.api("/report")).json.approvals[0]);
    expect(card).toMatchObject({ agentId: "claude-win", title: "Bash: rm -rf build" });
    expect((await h.api("/report")).json.inbox.events[0]).toMatchObject({ provider: "claude-win", status: "waiting" });
    expect((await h.api("/agent/approve", { cardId: card.id, decision: "allow" })).status).toBe(200);
    expect((await request).json).toEqual({ decision: "allow" });
    expect((await h.api("/report")).json.approvals).toEqual([]);
  });

  it("deny is delivered as deny", async () => {
    const h = await hub({ approvalTimeoutMs: 5000 });
    await register(h.api);
    const request = h.api("/relay/permission", { agentId: "claude-win", tool: "Write", summary: "a.txt" });
    const card = await until(async () => (await h.api("/report")).json.approvals[0]);
    await h.api("/agent/approve", { cardId: card.id, decision: "deny" });
    expect((await request).json).toEqual({ decision: "deny" });
  });

  it("no answer in time means deny and the card disappears", async () => {
    const h = await hub({ approvalTimeoutMs: 150 });
    await register(h.api);
    const res = await h.api("/relay/permission", { agentId: "claude-win", tool: "Bash", summary: "ls" });
    expect(res.json).toEqual({ decision: "deny" });
    expect((await h.api("/report")).json.approvals).toEqual([]);
  });

  it("rejects bad decisions and unknown cards", async () => {
    const h = await hub();
    expect((await h.api("/agent/approve", { cardId: "x", decision: "maybe" })).status).toBe(400);
    expect((await h.api("/agent/approve", { cardId: "x", decision: "allow" })).status).toBe(404);
  });
});

describe("voice", () => {
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(60, 1)]);
  function whisperMock(text = "wie ist das wetter") {
    const calls = [];
    const fetchImpl = async (url, init) => {
      if (String(url).includes("8017")) {
        calls.push({ url: String(url), form: init.body });
        return new Response(JSON.stringify({ text }), { status: 200 });
      }
      return fetch(url, init);
    };
    return { calls, fetchImpl };
  }

  it("raw WAV is transcribed by the default Whisper endpoint (8017) and asked", async () => {
    const w = whisperMock();
    const h = await hub({ fetchImpl: w.fetchImpl });
    const reg = await register(h.api);
    const res = await fetch(`${h.url}/agent/voice?agentId=claude-win&wait=0`, {
      method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "audio/wav" }, body: wav,
    });
    expect(res.status).toBe(202);
    expect((await res.json()).question).toBe("wie ist das wetter");
    expect(w.calls[0].url).toBe("http://127.0.0.1:8017/v1/audio/transcriptions");
    expect(w.calls[0].form.get("model")).toBe("whisper-1");
    const poll = await h.api(`/relay/poll?relay=${reg.json.relayId}`);
    expect(poll.json.commands[0]).toMatchObject({ type: "ask", prompt: "wie ist das wetter" });
  });

  it("JSON base64 (old clients) still works and returns the answer", async () => {
    const w = whisperMock("hallo");
    const h = await hub({ fetchImpl: w.fetchImpl, localAgent: true, spawnImpl: () => { const c = fakeChild(); setImmediate(() => { c.emitLines("Hi"); c.exit(0); }); return c; } });
    const res = await h.api("/agent/voice", { audio: wav.toString("base64"), mime: "audio/wav" });
    expect(res.json).toMatchObject({ question: "hallo", answer: "Hi" });
  });

  it("reports failed transcription and silence honestly", async () => {
    const h1 = await hub({ fetchImpl: async (u, i) => (String(u).includes("8017") ? new Response("nope", { status: 500 }) : fetch(u, i)) });
    await register(h1.api);
    const bad = await fetch(`${h1.url}/agent/voice?agentId=claude-win`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "audio/wav" }, body: wav });
    expect(bad.status).toBe(502);
    const w = whisperMock("   ");
    const h2 = await hub({ fetchImpl: w.fetchImpl });
    await register(h2.api);
    const quiet = await fetch(`${h2.url}/agent/voice?agentId=claude-win`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "audio/wav" }, body: wav });
    expect(quiet.status).toBe(422);
  });

  it("an unknown or empty request is a clean error", async () => {
    const h = await hub();
    const empty = await fetch(`${h.url}/agent/voice`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "audio/wav" }, body: Buffer.alloc(3) });
    expect(empty.status).toBe(400);
  });
});

describe("home and printer wiring", () => {
  it("without configuration the stand-ins are labelled DEMO", async () => {
    const h = await hub();
    const report = (await h.api("/report")).json;
    expect(report.home.devices.every((d) => d.label.startsWith("DEMO"))).toBe(true);
    expect(report.printer.demo).toBe(true);
    expect(report.printer.job).toMatch(/^DEMO/);
  });

  it("uses Home Assistant and Moonraker when configured", async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      const u = String(url);
      if (u.startsWith("http://ha.test")) {
        calls.push([init.method ?? "GET", u.replace("http://ha.test", ""), init.headers?.Authorization]);
        if (u.endsWith("/api/states")) return new Response(JSON.stringify([{ entity_id: "light.office", state: "on", attributes: {} }]), { status: 200 });
        return new Response("[]", { status: 200 });
      }
      if (u.startsWith("http://moon.test")) {
        calls.push([init.method ?? "GET", u.replace("http://moon.test", "")]);
        return new Response(JSON.stringify({ result: { status: { print_stats: { state: "printing", filename: "a.gcode", print_duration: 600 }, display_status: { progress: 0.5 }, extruder: { temperature: 209.6 }, heater_bed: { temperature: 60.2 } } } }), { status: 200 });
      }
      return fetch(url, init);
    };
    const h = await hub({ fetchImpl, haUrl: "http://ha.test", haToken: "ha-secret", haDevices: [{ entity: "light.office", label: "Büro" }], moonrakerUrl: "http://moon.test" });
    await until(async () => (await h.api("/report")).json.printer.state === "printing");
    const report = (await h.api("/report")).json;
    expect(report.home.devices[0]).toMatchObject({ id: "light.office", label: "Büro", on: true, writable: true });
    expect(report.printer).toMatchObject({ job: "a.gcode", progress: 50, nozzleC: 210, bedC: 60 });
    expect(JSON.stringify(report)).not.toContain("ha-secret");

    expect((await h.api("/home/toggle", { device: "light.office" })).status).toBe(200);
    expect(calls).toContainEqual(["POST", "/api/services/light/toggle", "Bearer ha-secret"]);
    expect((await h.api("/home/toggle", { device: "lock.front_door" })).status).toBe(404);

    expect((await h.api("/printer", { action: "pause" })).status).toBe(200);
    expect(calls).toContainEqual(["POST", "/printer/print/pause"]);
    expect((await h.api("/printer", { action: "explode" })).status).toBe(400);
  });
});

describe("events", () => {
  it("stores completion events from any hook", async () => {
    const h = await hub();
    expect((await h.api("/events", { provider: "claude-win", status: "done", title: "Fertig" })).status).toBe(201);
    expect((await h.api("/events", { provider: "x", status: "bogus", title: "t" })).status).toBe(400);
    const events = (await h.api("/report")).json.inbox.events;
    expect(events[0]).toMatchObject({ provider: "claude-win", read: false });
    await h.api("/events/read", { id: events[0].id });
    expect((await h.api("/report")).json.inbox.events[0].read).toBe(true);
  });
});

describe("CORS preflight", () => {
  it("answers OPTIONS with a clean 204 (no body, no Content-Length) and the allow headers", async () => {
    const h = await hub();
    const res = await fetch(`${h.url}/report`, { method: "OPTIONS", headers: { Origin: "https://x.invalid", "Access-Control-Request-Headers": "authorization" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.text()).toBe("");
    expect(res.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("access log", () => {
  it("logs one token-free line per request, client IP from X-Forwarded-For, skips relay heartbeats", async () => {
    const lines = [];
    const h = await hub({ accessLog: (line) => lines.push(line), pollHoldMs: 20 });
    await fetch(`${h.url}/report?token=SECRET`, { headers: { Authorization: `Bearer ${TOKEN}`, "X-Forwarded-For": "100.1.2.3, 10.0.0.1" } });
    await fetch(`${h.url}/report`);
    const reg = await register(h.api);
    await h.api(`/relay/poll?relay=${reg.json.relayId}`);
    await sleep(30);
    expect(lines.some((l) => l.includes("100.1.2.3 GET /report 200"))).toBe(true);
    expect(lines.some((l) => l.includes(" GET /report 401"))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/SECRET|Bearer|test-token/);
    expect(lines.some((l) => l.includes("/relay/poll") || l.includes("/relay/register"))).toBe(false);
    expect(lines.every((l) => /ms$/.test(l))).toBe(true);
  });
});
