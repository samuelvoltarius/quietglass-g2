import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const example = (name) => fileURLToPath(new URL("../examples/" + name, import.meta.url));

/** A port that was free a moment ago; good enough for a local test. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Starts an example and resolves once it reports that it is listening. */
async function start(name, env, cleanup) {
  const port = await freePort();
  const child = spawn(process.execPath, [example(name)], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { output.stdout += chunk; });
  child.stderr.on("data", (chunk) => { output.stderr += chunk; });
  cleanup.push(() => child.kill());
  await new Promise((resolve) => child.stdout.on("data", () => { if (output.stdout.includes("http://")) resolve(); }));
  return { base: `http://127.0.0.1:${port}`, output };
}

describe("the example sources", () => {
  const cleanup = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  it("reference server: answers the CORS preflight even with a TOKEN set", async () => {
    // Regression: the preflight (which never carries Authorization) got a 401
    // without CORS headers, so the WebView blocked every authenticated poll.
    const { base } = await start("reference-server.mjs", { TOKEN: "s3cret" }, cleanup);
    const preflight = await fetch(base + "/status", {
      method: "OPTIONS",
      headers: { Origin: "http://phone.local", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");

    expect((await fetch(base + "/status")).status).toBe(401);
    const ok = await fetch(base + "/status", { headers: { Authorization: "Bearer s3cret" } });
    expect(ok.status).toBe(200);
  }, 10000);

  it("Home Assistant adapter: a hung Home Assistant gives a 502, and the token stays out of the logs", async () => {
    // Regression: the call to Home Assistant had no timeout, so one hung
    // request held /status open until the glasses gave up.
    const hung = createServer(() => { /* never answers */ });
    await new Promise((resolve) => hung.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => { hung.closeAllConnections(); hung.close(); });

    const token = "ha-long-lived-token-do-not-leak";
    const { base, output } = await start("home-assistant-adapter.mjs", {
      HA_URL: `http://127.0.0.1:${hung.address().port}`, HA_TOKEN: token, HA_TIMEOUT_MS: "300",
    }, cleanup);
    const response = await fetch(base + "/status", { signal: AbortSignal.timeout(3000) });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain(token);
    expect(output.stdout + output.stderr).not.toContain(token);
  }, 10000);

  /** A stand-in Home Assistant that records service calls. */
  async function fakeHa(states = []) {
    const calls = [];
    const ha = createServer((request, response) => {
      calls.push(request.method + " " + request.url);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(request.url === "/api/states" ? JSON.stringify(states) : "{}");
    });
    await new Promise((resolve) => ha.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => { ha.closeAllConnections(); ha.close(); });
    return { url: `http://127.0.0.1:${ha.address().port}`, calls };
  }
  const auth = { Authorization: "Bearer adapter-secret" };

  it("Home Assistant adapter: refuses an action that is not on the allow-list", async () => {
    const ha = await fakeHa();
    const { base } = await start("home-assistant-adapter.mjs", { HA_URL: ha.url, HA_TOKEN: "t", TOKEN: "adapter-secret" }, cleanup);
    for (const id of ["lock.front_door", "constructor", "__proto__", "kitchen_light ", ["kitchen_light"]]) {
      const response = await fetch(base + "/action", { method: "POST", headers: auth, body: JSON.stringify({ id }) });
      expect(response.status, JSON.stringify(id)).toBe(404);
    }
    expect(ha.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  }, 10000);

  it("Home Assistant adapter: without a TOKEN it is read-only and offers no actions", async () => {
    // Regression: with no TOKEN and CORS open to every origin, any web page the
    // browser opened could POST /action — including confirm-only actions.
    const ha = await fakeHa();
    const { base } = await start("home-assistant-adapter.mjs", { HA_URL: ha.url, HA_TOKEN: "t", TOKEN: "" }, cleanup);
    const action = await fetch(base + "/action", { method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify({ id: "all_off" }) });
    expect(action.status).toBe(403);
    const status = await (await fetch(base + "/status")).json();
    expect(status.actions).toEqual([]);
    expect(ha.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  }, 10000);

  it("Home Assistant adapter: with a TOKEN, only the right bearer runs an allowed action", async () => {
    const ha = await fakeHa();
    const { base } = await start("home-assistant-adapter.mjs", { HA_URL: ha.url, HA_TOKEN: "t", TOKEN: "adapter-secret" }, cleanup);
    const body = JSON.stringify({ id: "kitchen_light" });
    for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: "Bearer adapter-secretX" }, { Authorization: "adapter-secret" }]) {
      expect((await fetch(base + "/action", { method: "POST", headers, body })).status, JSON.stringify(headers)).toBe(401);
    }
    expect(ha.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect((await fetch(base + "/action", { method: "POST", headers: auth, body })).status).toBe(200);
    expect(ha.calls).toContain("POST /api/services/light/toggle");
    const status = await (await fetch(base + "/status", { headers: auth })).json();
    expect(status.actions.map((a) => a.id)).toContain("all_off");
  }, 10000);

  it("Home Assistant adapter: an oversized body gets a 413 instead of hanging", async () => {
    // Regression: readBody destroyed the request past 4 KiB and never resolved.
    const ha = await fakeHa();
    const { base } = await start("home-assistant-adapter.mjs", { HA_URL: ha.url, HA_TOKEN: "t", TOKEN: "adapter-secret" }, cleanup);
    const response = await fetch(base + "/action", {
      method: "POST", headers: auth, body: JSON.stringify({ id: "kitchen_light", pad: "x".repeat(20000) }), signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(413);
    expect(ha.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  }, 10000);

  it("Home Assistant adapter: a state named like an Object method maps to unknown", async () => {
    // Regression: spec.states["constructor"] resolved to Object's constructor.
    const ha = await fakeHa([{ entity_id: "binary_sensor.front_door", state: "constructor" }]);
    const { base } = await start("home-assistant-adapter.mjs", { HA_URL: ha.url, HA_TOKEN: "t" }, cleanup);
    const status = await (await fetch(base + "/status")).json();
    expect(status.metrics.find((m) => m.id === "binary_sensor.front_door")?.state).toBe("unknown");
  }, 10000);
});
