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
async function start(name, env, cleanup, host = "127.0.0.1") {
  const port = await freePort();
  const child = spawn(process.execPath, [example(name)], {
    env: { ...process.env, PORT: String(port), HOST: host, TOKEN: "", KL_ALLOW_CONTROL: "", KL_MOONRAKER: "", ...env },
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
  return { base: `http://${host}:${port}`, output };
}

async function printerAndBridge(bridgeEnv, cleanup, host) {
  const printer = await start("mock-moonraker.mjs", {}, cleanup);
  const bridge = await start("klipper-bridge.mjs", { KL_MOONRAKER: printer.base, ...bridgeEnv }, cleanup, host);
  return { printer, bridge };
}

const command = (base, name, headers = {}) =>
  fetch(base + "/api/printer/cmd", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ command: name }) });

describe("the Klipper Glance bridge example", () => {
  const cleanup = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  it("reports the mock printer in the shape the app reads", async () => {
    const { bridge } = await printerAndBridge({}, cleanup);
    const status = await (await fetch(bridge.base + "/api/printer")).json();
    expect(status).toMatchObject({ online: true, state: "printing", file: "bracket_v3.gcode", layers: 180, controllable: false, speed: 100 });
    expect(status.nozzle.target).toBe(220);
    expect(typeof status.progress).toBe("number");
  }, 15000);

  it("refuses control unless KL_ALLOW_CONTROL=1", async () => {
    const { printer, bridge } = await printerAndBridge({}, cleanup);
    const reply = await command(bridge.base, "cancel");
    expect(reply.status).toBe(403);
    expect(await reply.json()).toEqual({ ok: false, error: "control-off" });
    expect((await (await fetch(printer.base + "/mock/commands")).json()).commands).toEqual([]);
  }, 15000);

  it("bound beyond loopback, control also needs a TOKEN", async () => {
    // 127.0.0.2 is a loopback address the bridge does not treat as "this machine only",
    // so the rule can be tested without opening a port to the network.
    const { printer, bridge } = await printerAndBridge({ KL_ALLOW_CONTROL: "1" }, cleanup, "127.0.0.2");
    // The start-up lines may arrive in more than one chunk.
    for (let i = 0; i < 40 && !bridge.output.stdout.includes("ignored"); i++) await new Promise((done) => setTimeout(done, 50));
    expect(bridge.output.stdout).toContain("ignored: printer control needs a TOKEN");
    expect((await command(bridge.base, "pause")).status).toBe(403);
    expect((await (await fetch(printer.base + "/mock/commands")).json()).commands).toEqual([]);
  }, 15000);

  it("on loopback, control still needs a TOKEN (any local web page could post a cancel)", async () => {
    const { printer, bridge } = await printerAndBridge({ KL_ALLOW_CONTROL: "1" }, cleanup);
    for (let i = 0; i < 40 && !bridge.output.stdout.includes("ignored"); i++) await new Promise((done) => setTimeout(done, 50));
    expect(bridge.output.stdout).toContain("ignored: printer control needs a TOKEN");
    expect((await command(bridge.base, "cancel", { Origin: "https://evil.example" })).status).toBe(403);
    expect((await (await fetch(printer.base + "/mock/commands")).json()).commands).toEqual([]);
  }, 15000);

  it("with KL_ALLOW_CONTROL=1 and a TOKEN, only the right bearer controls the printer", async () => {
    const { printer, bridge } = await printerAndBridge({ KL_ALLOW_CONTROL: "1", TOKEN: "s3cret" }, cleanup, "127.0.0.2");
    for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: "Bearer s3cretX" }, { Authorization: "s3cret" }]) {
      expect((await command(bridge.base, "pause", headers)).status, JSON.stringify(headers)).toBe(401);
    }
    const ok = await command(bridge.base, "pause", { Authorization: "Bearer s3cret" });
    expect(await ok.json()).toEqual({ ok: true, command: "pause" });
    expect((await command(bridge.base, "constructor", { Authorization: "Bearer s3cret" })).status).toBe(400);
    expect((await (await fetch(printer.base + "/mock/commands")).json()).commands).toEqual(["pause"]);
    const status = await (await fetch(bridge.base + "/api/printer", { headers: { Authorization: "Bearer s3cret" } })).json();
    expect(status).toMatchObject({ state: "paused", controllable: true });
  }, 15000);

  it("answers the CORS preflight even with a TOKEN set", async () => {
    const { bridge } = await printerAndBridge({ TOKEN: "s3cret" }, cleanup);
    const preflight = await fetch(bridge.base + "/api/printer", {
      method: "OPTIONS",
      headers: { Origin: "https://phone.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    expect((await fetch(bridge.base + "/api/printer")).status).toBe(401);
  }, 15000);

  it("a silent printer at a fixed address reads as offline, and an oversized body gets a 413", async () => {
    const dead = await freePort();
    const { base } = await start("klipper-bridge.mjs", { KL_MOONRAKER: `http://127.0.0.1:${dead}`, KL_ALLOW_CONTROL: "1" }, cleanup);
    expect(await (await fetch(base + "/api/printer")).json()).toMatchObject({ online: false, reason: "printer-silent" });
    const big = await fetch(base + "/api/printer/cmd", { method: "POST", body: JSON.stringify({ command: "pause", pad: "x".repeat(10000) }) });
    expect(big.status).toBe(413);
  }, 15000);

  it("without an address it searches in the background instead of blocking the request", async () => {
    // TEST-NET-1 (192.0.2.0/24) is reserved for documentation: nothing answers there.
    const { base } = await start("klipper-bridge.mjs", { KL_SCAN_NET: "192.0.2" }, cleanup);
    const started = Date.now();
    const status = await (await fetch(base + "/api/printer")).json();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(status).toMatchObject({ online: false, reason: "searching" });
  }, 15000);
});
