import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { sanitizeQuery, upstreamUrl, MAX_COUNT } from "../examples/sugar-bridge.mjs";

const script = fileURLToPath(new URL("../examples/sugar-bridge.mjs", import.meta.url));

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** A Nightscout stand-in that records what it was asked. */
async function fakeNightscout(cleanup) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.url);
    const url = new URL(request.url, "http://x");
    if (url.searchParams.get("token") !== "read-token") { response.writeHead(401); response.end("{}"); return; }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify([{ sgv: 111, date: 1 }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

async function startBridge(env, cleanup) {
  const port = await freePort();
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TOKEN: "", SUGAR_TAILSCALE_USERS: "", NS_TOKEN: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { output.stdout += chunk; });
  child.stderr.on("data", (chunk) => { output.stderr += chunk; });
  cleanup.push(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.on("data", () => { if (output.stdout.includes("http://")) resolve(); });
    child.on("exit", (code) => reject(new Error("exited " + code + ": " + output.stderr)));
  });
  return { base: `http://127.0.0.1:${port}`, output };
}

describe("query sanitising", () => {
  it("keeps count (clamped) and time filters, drops tokens and anything else", () => {
    const q = sanitizeQuery("?count=9999&token=evil&find[created_at][$gte]=2026-10-13&find[foo]=1&x=1");
    expect(q.get("count")).toBe(String(MAX_COUNT));
    expect(q.get("token")).toBeNull();
    expect(q.get("find[created_at][$gte]")).toBe("2026-10-13");
    expect(q.has("find[foo]")).toBe(false);
    expect(q.has("x")).toBe(false);
    expect(upstreamUrl("/api/v1/status.json", "?token=evil", "http://ns", "good")).toBe("http://ns/api/v1/status.json?token=good");
  });
});

describe("the Sugar Glass bridge", () => {
  const cleanup = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  it("refuses everything without a login allowlist or token", async () => {
    const ns = await fakeNightscout(cleanup);
    const bridge = await startBridge({ NS_URL: ns.base, NS_TOKEN: "read-token" }, cleanup);
    const reply = await fetch(bridge.base + "/api/v1/entries/sgv.json");
    expect(reply.status).toBe(401);
    expect(bridge.output.stdout).toContain("every request is refused");
    expect(ns.seen).toEqual([]);
  });

  it("passes allowed GETs for an allowed Tailscale login and adds its own token", async () => {
    const ns = await fakeNightscout(cleanup);
    const bridge = await startBridge({ NS_URL: ns.base, NS_TOKEN: "read-token", SUGAR_TAILSCALE_USERS: "me@example.com" }, cleanup);
    const ok = await fetch(bridge.base + "/api/v1/entries/sgv.json?count=3&token=nope", { headers: { "Tailscale-User-Login": "Me@Example.com", Origin: "https://app.example" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(await ok.json()).toEqual([{ sgv: 111, date: 1 }]);
    expect(ns.seen).toEqual(["/api/v1/entries/sgv.json?count=3&token=read-token"]);

    expect((await fetch(bridge.base + "/api/v1/status.json", { headers: { "Tailscale-User-Login": "other@example.com" } })).status).toBe(401);
    expect((await fetch(bridge.base + "/api/v2/authorization/subjects", { headers: { "Tailscale-User-Login": "me@example.com" } })).status).toBe(404);
    expect((await fetch(bridge.base + "/api/v1/entries.json", { method: "POST", headers: { "Tailscale-User-Login": "me@example.com" }, body: "[]" })).status).toBe(405);
    expect(bridge.output.stdout + bridge.output.stderr).not.toContain("read-token");
  });

  it("preflight is 204 without a body; a bearer token works too", async () => {
    const ns = await fakeNightscout(cleanup);
    const bridge = await startBridge({ NS_URL: ns.base, NS_TOKEN: "read-token", TOKEN: "bridge-secret" }, cleanup);
    const pre = await fetch(bridge.base + "/api/v1/status.json", { method: "OPTIONS", headers: { Origin: "https://app.example" } });
    expect(pre.status).toBe(204);
    expect(await pre.text()).toBe("");
    expect((await fetch(bridge.base + "/api/v1/status.json", { headers: { Authorization: "Bearer bridge-secret" } })).status).toBe(200);
    expect((await fetch(bridge.base + "/api/v1/status.json", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("a wrong Nightscout token is reported as 502, not passed on as 401", async () => {
    const ns = await fakeNightscout(cleanup);
    const bridge = await startBridge({ NS_URL: ns.base, NS_TOKEN: "stale", TOKEN: "t" }, cleanup);
    expect((await fetch(bridge.base + "/api/v1/status.json", { headers: { Authorization: "Bearer t" } })).status).toBe(502);
  });
});
