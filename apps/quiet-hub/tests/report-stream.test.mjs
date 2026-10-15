import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { gunzipSync } from "node:zlib";
import { startHub, TOKEN, sleep } from "./helpers.mjs";

const open = [];
async function hub(options) {
  const h = await startHub(options);
  open.push(h);
  return h;
}
afterEach(async () => { while (open.length) await open.pop().close(); });

const register = (api) => api("/relay/register", { machine: "win", agents: [{ id: "claude-win", kind: "claude", mode: "ask" }] });

/** Raw GET (no automatic decompression) to see the exact headers and bytes. */
function rawGet(url, path, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("report long-poll (streamed answers)", () => {
  it("advertises long-poll support in /report and /health", async () => {
    const h = await hub();
    const report = (await h.api("/report")).json;
    expect(report.rev).toBeGreaterThan(0);
    expect(typeof report.boot).toBe("string");
    expect(report.live).toEqual({ longPoll: true, maxWaitS: 25 });
    expect((await h.api("/health")).json.live).toMatchObject({ longPoll: true });
  });

  it("rev only moves when the report really changes", async () => {
    const h = await hub();
    const a = (await h.api("/report")).json.rev;
    const b = (await h.api("/report")).json.rev;
    expect(b).toBe(a);
    await h.api("/events", { provider: "test", status: "done", title: "neu" });
    expect((await h.api("/report")).json.rev).toBe(a + 1);
  });

  it("answers a stale revision or another daemon boot at once", async () => {
    const h = await hub();
    const { rev, boot } = (await h.api("/report")).json;
    let started = Date.now();
    const stale = await h.api(`/report?since=${rev - 1}&boot=${boot}&wait=25`);
    expect(stale.json.rev).toBe(rev);
    expect(Date.now() - started).toBeLessThan(1000);
    started = Date.now();
    const restarted = await h.api(`/report?since=${rev}&boot=older&wait=25`);
    expect(restarted.json.boot).toBe(boot);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("holds an up-to-date request and wakes it with the next answer delta", async () => {
    const h = await hub();
    const reg = await register(h.api);
    await h.api("/agent/ask", { agentId: "claude-win", question: "Hallo", wait: false });
    const poll = await h.api(`/relay/poll?relay=${reg.json.relayId}`);
    const jobId = poll.json.commands[0].jobId;
    const { rev, boot } = (await h.api("/report")).json;

    const started = Date.now();
    const held = h.api(`/report?since=${rev}&boot=${boot}&wait=25`);
    await sleep(150);
    await h.api("/relay/result", { jobId, status: "running", text: "Erstes Wort" });
    const woke = await held;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(woke.json.rev).toBeGreaterThan(rev);
    expect(woke.json.agents[0]).toMatchObject({ answer: "Erstes Wort", busy: true });

    // Next round: the following delta wakes the next held request.
    const next = h.api(`/report?since=${woke.json.rev}&boot=${boot}&wait=25`);
    await sleep(100);
    await h.api("/relay/result", { jobId, status: "running", text: "Erstes Wort zweites" });
    expect((await next).json.agents[0].answer).toBe("Erstes Wort zweites");
  });

  it("returns the unchanged report when the wait runs out", async () => {
    const h = await hub({ reportWaitMs: 200 });
    const { rev, boot } = (await h.api("/report")).json;
    const started = Date.now();
    const out = await h.api(`/report?since=${rev}&boot=${boot}&wait=25`);
    expect(out.status).toBe(200);
    expect(out.json.rev).toBe(rev);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it("sees changes without a hook through the periodic tick", async () => {
    const h = await hub({ reportTickMs: 50 });
    const { rev, boot } = (await h.api("/report")).json;
    const held = h.api(`/report?since=${rev}&boot=${boot}&wait=25`);
    await sleep(80);
    // A direct state change that calls no hook (like a Home Assistant refresh).
    h.hub.state.events.unshift({ id: "x", provider: "t", status: "done", title: "still", detail: null, createdAt: new Date().toISOString(), read: false });
    const out = await held;
    expect(out.json.rev).toBe(rev + 1);
  });

  it("wait=0 or no since is a plain report", async () => {
    const h = await hub();
    const { rev } = (await h.api("/report")).json;
    const started = Date.now();
    expect((await h.api(`/report?since=${rev}&wait=0`)).json.rev).toBe(rev);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("answers the CORS preflight of the long-poll with 204 and no body", async () => {
    const h = await hub();
    const res = await rawGet(h.url, "/report?since=1&wait=25", { Origin: "https://app.example", "Access-Control-Request-Method": "GET" }, "OPTIONS");
    expect(res.status).toBe(204);
    expect(res.body.length).toBe(0);
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-headers"]).toMatch(/Authorization/);
  });

  it("gzips a large report when the client accepts it", async () => {
    const h = await hub();
    for (let i = 0; i < 10; i += 1) await h.api("/events", { provider: "test", status: "done", title: `Meldung ${i}`, detail: "x".repeat(400) });
    const plain = await rawGet(h.url, "/report");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    const packed = await rawGet(h.url, "/report", { "Accept-Encoding": "gzip, deflate" });
    expect(packed.headers["content-encoding"]).toBe("gzip");
    const json = JSON.parse(gunzipSync(packed.body).toString("utf8"));
    expect(json.inbox.events.length).toBe(10);
    expect(packed.body.length).toBeLessThan(plain.body.length);
  });

  it("a closed long-poll is forgotten and the daemon still closes cleanly", async () => {
    const h = await hub();
    const { rev, boot } = (await h.api("/report")).json;
    const controller = new AbortController();
    const held = fetch(`${h.url}/report?since=${rev}&boot=${boot}&wait=25`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: controller.signal }).catch((e) => e);
    await sleep(80);
    controller.abort();
    expect(await held).toBeInstanceOf(Error);
    await h.api("/events", { provider: "test", status: "done", title: "danach" });
    expect((await h.api("/report")).json.rev).toBe(rev + 1);
  });
});
