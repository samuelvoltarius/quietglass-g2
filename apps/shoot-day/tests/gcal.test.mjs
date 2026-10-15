import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvent, isoWithOffset, parseWhen } from "../examples/shoot-day-gcal.mjs";

const example = (name) => fileURLToPath(new URL("../examples/" + name, import.meta.url));
const SECRET = "s3cret-geheimwort-xyz";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

/** A fake Apps Script web app: POST /exec answers 302 -> GET /echo/<n> with the JSON result, like the real one. */
async function fakeBridge(cleanup) {
  const bridge = { calls: [], events: new Map(), fail: 0, results: new Map(), n: 0, seq: 0 };
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/exec") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        bridge.calls.push(body);
        if (bridge.fail > 0) { bridge.fail--; res.writeHead(503); res.end("down"); return; }
        let result;
        if (body.secret !== SECRET) result = { ok: false, error: "forbidden" };
        else if (body.action === "delete") { result = { ok: true, deleted: bridge.events.delete(body.project) ? 1 : 0 }; }
        else {
          const existing = bridge.events.get(body.project);
          const eventId = existing?.eventId ?? "ev" + ++bridge.seq;
          bridge.events.set(body.project, { ...body, eventId });
          result = { ok: true, eventId };
        }
        const id = ++bridge.n;
        bridge.results.set(id, result);
        res.writeHead(302, { Location: "/echo/" + id });
        res.end();
      });
      return;
    }
    const m = /^\/echo\/(\d+)$/.exec(req.url ?? "");
    if (req.method === "GET" && m) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(bridge.results.get(Number(m[1]))));
      return;
    }
    res.writeHead(405); res.end(); // the real redirect target only accepts GET
  });
  const port = await listen(server);
  cleanup.push(() => server.close());
  bridge.url = `http://127.0.0.1:${port}/exec`;
  return bridge;
}

async function freePort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function start(env, cleanup) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "shootday-gcal-"));
  const dataFile = join(dir, "data.json");
  const child = spawn(process.execPath, [example("shoot-day-server.mjs")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_FILE: dataFile, TOKEN: "", WHISPER_URL: "", SHOOT_GCAL_RETRY_MS: "100", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (c) => { output.stdout += c; });
  child.stderr.on("data", (c) => { output.stderr += c; });
  cleanup.push(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", () => { if (output.stdout.includes("http://")) resolve(); });
    child.on("exit", (code) => reject(new Error("exited " + code + ": " + output.stderr)));
  });
  return { base: `http://127.0.0.1:${port}`, output, dataFile };
}

const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const get = async (base, path) => (await fetch(base + path)).json();
async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const quiet = (bridge, base) => waitFor(async () => { const s = await get(base, "/api/gcal/status"); return s.pending === 0 && s.lastSync > 0 && s; });
const newProject = async (base, extra = {}) => {
  const { customers } = await get(base, "/api/customers");
  const customer = await (await post(base, "/api/customers", { name: "Clara Muster", phone: "0123 456", email: "clara@example.org" })).json();
  void customers;
  return (await (await post(base, "/api/projects", { customerId: customer.id, name: "Herbst-Reel", date: "2026-10-14 10:30", place: "Hofgasse 1", ...extra })).json());
};

describe("date handling", () => {
  it("parses the three formats and rejects the rest", () => {
    expect(parseWhen("2026-10-14 10:30")).toEqual({ y: 2026, m: 10, d: 14, hh: 10, mm: 30 });
    expect(parseWhen("2026-10-14")).toEqual({ y: 2026, m: 10, d: 14, hh: -1, mm: 0 });
    expect(parseWhen("14.10.2026 9:05")).toEqual({ y: 2026, m: 10, d: 14, hh: 9, mm: 5 });
    for (const bad of ["", "morgen", "2026-02-30", "2026-10-14 25:00", "14.13.2026"]) expect(parseWhen(bad)).toBeNull();
  });
  it("gives the Vienna offset for summer and winter time", () => {
    expect(isoWithOffset(Date.UTC(2026, 6, 1, 10, 0), "Europe/Vienna")).toBe("2026-07-01T10:00:00+02:00");
    expect(isoWithOffset(Date.UTC(2026, 11, 1, 10, 0), "Europe/Vienna")).toBe("2026-12-01T10:00:00+01:00");
  });
  it("builds a timed and an all-day event without links", () => {
    const cfg = { durationMin: 90, tz: "Europe/Vienna", calendar: "" };
    const customer = { name: "Clara Muster", company: "", phone: "1", email: "c@example.org" };
    const timed = buildEvent({ id: "p_1", name: "Reel", date: "2026-10-14 10:30", place: "Hof", ideas: [{ done: false }, { done: true }] }, customer, cfg);
    expect(timed).toMatchObject({ title: "Clara Muster – Reel", allDay: false, start: "2026-10-14T10:30:00+02:00", end: "2026-10-14T12:00:00+02:00", location: "Hof" });
    expect(timed.description).toContain("Offene Ideen: 1");
    expect(timed.description).not.toMatch(/https?:/);
    expect(buildEvent({ id: "p_1", name: "Reel", date: "2026-10-14", place: "", ideas: [] }, customer, cfg)).toMatchObject({ allDay: true, date: "2026-10-14", start: "" });
  });
});

describe("Google Calendar sync (fake Apps Script bridge)", () => {
  const cleanup = [];
  afterEach(() => { for (const step of cleanup.splice(0).reverse()) step(); });
  const env = (bridge) => ({ SHOOT_GCAL_WEBHOOK: bridge.url, SHOOT_GCAL_SECRET: SECRET });

  it("is off without webhook and secret, and makes no calls", async () => {
    const bridge = await fakeBridge(cleanup);
    const { base } = await start({ SHOOT_GCAL_WEBHOOK: bridge.url }, cleanup);
    await newProject(base);
    expect(await get(base, "/api/gcal/status")).toMatchObject({ enabled: false, pending: 0 });
    expect((await post(base, "/api/gcal/sync")).status).toBe(409);
    expect(bridge.calls).toHaveLength(0);
  }, 15000);

  it("creates, updates and deletes one event per project (following the 302)", async () => {
    const bridge = await fakeBridge(cleanup);
    const { base } = await start(env(bridge), cleanup);
    await quiet(bridge, base); // the seeded example project has no date
    const before = bridge.calls.length;
    const project = await newProject(base);
    await quiet(bridge, base);
    const created = [...bridge.events.values()].filter((e) => e.project === project.id);
    expect(bridge.calls.length).toBeGreaterThan(before);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ action: "upsert", title: "Clara Muster – Herbst-Reel", location: "Hofgasse 1", start: "2026-10-14T10:30:00+02:00", end: "2026-10-14T11:30:00+02:00", allDay: false });
    const eventId = created[0].eventId;
    expect((await get(base, "/api/projects/" + project.id)).gcalEventId).toBe(eventId);

    await post(base, "/api/projects/" + project.id, { date: "2026-10-15 08:00", place: "Neuer Ort" });
    await waitFor(() => bridge.events.get(project.id)?.location === "Neuer Ort");
    await quiet(bridge, base);
    expect(bridge.events.get(project.id)).toMatchObject({ start: "2026-10-15T08:00:00+02:00", location: "Neuer Ort", eventId });
    expect(bridge.events.size).toBe(1);

    await fetch(base + "/api/projects/" + project.id, { method: "DELETE" });
    await waitFor(() => bridge.events.size === 0);
    expect((await quiet(bridge, base)).pending).toBe(0);
  }, 20000);

  it("removes the event when the date becomes unparseable, and never creates one for a bad date", async () => {
    const bridge = await fakeBridge(cleanup);
    const { base } = await start(env(bridge), cleanup);
    const bad = await newProject(base, { date: "irgendwann im Herbst" });
    await new Promise((r) => setTimeout(r, 300));
    expect(bridge.calls.filter((c) => c.project === bad.id)).toHaveLength(0);
    await post(base, "/api/projects/" + bad.id, { date: "14.10.2026" });
    await waitFor(() => bridge.events.has(bad.id));
    expect(bridge.events.get(bad.id)).toMatchObject({ allDay: true, date: "2026-10-14" });
    await post(base, "/api/projects/" + bad.id, { date: "" });
    await waitFor(() => !bridge.events.has(bad.id));
    expect((await get(base, "/api/projects/" + bad.id)).gcalEventId).toBeUndefined();
  }, 20000);

  it("backfill is idempotent", async () => {
    const bridge = await fakeBridge(cleanup);
    const second = await start(env(bridge), cleanup);
    await newProject(second.base);
    await post(second.base, "/api/projects", { name: "Zweites", date: "2026-11-02 14:00" });
    await quiet(bridge, second.base);
    const callsAfterAuto = bridge.calls.length;
    expect(bridge.events.size).toBe(2);
    const answer = await post(second.base, "/api/gcal/sync");
    expect(answer.status).toBe(202);
    await new Promise((r) => setTimeout(r, 300));
    await quiet(bridge, second.base);
    expect(bridge.calls.length).toBe(callsAfterAuto); // nothing changed, nothing sent
    expect(bridge.events.size).toBe(2);
  }, 25000);

  it("a failing bridge does not break saving; it retries and recovers", async () => {
    const bridge = await fakeBridge(cleanup);
    const { base, dataFile, output } = await start(env(bridge), cleanup);
    await quiet(bridge, base);
    bridge.fail = 30;
    const project = await newProject(base);
    const saved = JSON.parse(readFileSync(dataFile, "utf8"));
    expect(saved.projects[project.id].date).toBe("2026-10-14 10:30");
    const bad = await waitFor(async () => { const s = await get(base, "/api/gcal/status"); return s.lastError && s; }, 15000);
    expect(bad.pending).toBeGreaterThan(0);
    expect((await post(base, "/api/projects/" + project.id, { place: "Weiter speichern" })).status).toBe(200);
    bridge.fail = 0;
    await waitFor(() => bridge.events.get(project.id)?.location === "Weiter speichern", 15000);
    const ok = await quiet(bridge, base);
    expect(ok.lastError).toBe("");
    expect(output.stderr).toContain("gcal:");
  }, 40000);

  it("reports a wrong secret as an error and keeps the secret and URL out of logs and status", async () => {
    const bridge = await fakeBridge(cleanup);
    const { base, output } = await start({ SHOOT_GCAL_WEBHOOK: bridge.url, SHOOT_GCAL_SECRET: "falsches-wort" }, cleanup);
    await newProject(base);
    const bad = await waitFor(async () => { const s = await get(base, "/api/gcal/status"); return s.lastError && s; });
    expect(bad.lastError).toContain("forbidden");
    const everything = output.stdout + output.stderr + JSON.stringify(bad) + JSON.stringify(await get(base, "/api/config"));
    expect(everything).not.toContain("falsches-wort");
    expect(everything).not.toContain(bridge.url);
    expect(everything).not.toContain(SECRET);
  }, 15000);
});
