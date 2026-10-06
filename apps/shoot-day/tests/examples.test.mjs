import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Starts the server and resolves once it reports that it is listening. */
async function start(env, cleanup) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "shootday-"));
  const dataFile = join(dir, "data.json");
  const child = spawn(process.execPath, [example("shoot-day-server.mjs")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_FILE: dataFile, TOKEN: "", WHISPER_URL: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { output.stdout += chunk; });
  child.stderr.on("data", (chunk) => { output.stderr += chunk; });
  cleanup.push(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", () => { if (output.stdout.includes("http://")) resolve(); });
    child.on("exit", (code) => reject(new Error("exited " + code + ": " + output.stderr)));
  });
  return { base: `http://127.0.0.1:${port}`, output, dataFile, child };
}

const post = (base, path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("the Shoot Day server example", () => {
  const cleanup = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  it("seeds a neutral example project and serves the web terminal", async () => {
    const { base, dataFile } = await start({}, cleanup);
    const list = await (await fetch(base + "/api/shotlist")).json();
    expect(list.project).toBe("Example shoot");
    expect(list.shots.length).toBeGreaterThan(0);
    const page = await fetch(base + "/");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain("Shoot Day");
    expect(JSON.parse(readFileSync(dataFile, "utf8")).active).toBe("Example shoot");
  }, 10000);

  it("logs takes, counts per shot, and updates a note", async () => {
    const { base } = await start({}, cleanup);
    const first = await (await post(base, "/api/take", { scene: "1", shot: "A", status: "OK", note: "" })).json();
    const second = await (await post(base, "/api/take", { scene: "1", shot: "A", status: "NG", note: "<b>Ton</b>" })).json();
    expect([first.n, second.n]).toEqual([1, 2]);
    expect((await post(base, "/api/take/note", { scene: "1", shot: "A", n: 1, note: "super" })).status).toBe(200);
    const { takes } = await (await fetch(base + "/api/takes?all=1")).json();
    expect(takes.map((t) => [t.n, t.status, t.note])).toEqual([[1, "OK", "super"], [2, "NG", "<b>Ton</b>"]]);
  }, 10000);

  it("changes one packing-list item at a time", async () => {
    const { base } = await start({ PRESET_LANG: "de" }, cleanup);
    const { items } = await (await fetch(base + "/api/equipment")).json();
    expect(items.map((i) => i.name)).toContain("Gimbal");
    expect((await post(base, "/api/equipment", { setneed: { name: "Gimbal", need: true } })).status).toBe(200);
    const ticked = await (await post(base, "/api/equipment", { toggle: { name: "Gimbal", packed: true } })).json();
    expect(ticked).toMatchObject({ ok: true, packed: true, need: 1, packedCount: 1 });
    expect((await post(base, "/api/equipment", { toggle: { name: "nope", packed: true } })).status).toBe(404);
  }, 10000);

  it("answers the CORS preflight even with a TOKEN, and requires the token with a constant answer", async () => {
    const { base } = await start({ TOKEN: "s3cret" }, cleanup);
    const preflight = await fetch(base + "/api/shotlist", {
      method: "OPTIONS",
      headers: { Origin: "https://phone.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: "Bearer s3cretX" }, { Authorization: "s3cret" }]) {
      expect((await fetch(base + "/api/shotlist", { headers })).status, JSON.stringify(headers)).toBe(401);
    }
    expect((await fetch(base + "/api/shotlist", { headers: { Authorization: "Bearer s3cret" } })).status).toBe(200);
  }, 10000);

  it("refuses to listen beyond this machine without a TOKEN", async () => {
    const port = await freePort();
    const result = spawnSync(process.execPath, [example("shoot-day-server.mjs")], {
      env: { ...process.env, PORT: String(port), HOST: "0.0.0.0", TOKEN: "" }, encoding: "utf8", timeout: 8000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("without a TOKEN");
  }, 10000);

  it("speech is off without WHISPER_URL, and an oversized body gets a 413", async () => {
    const { base } = await start({}, cleanup);
    expect((await fetch(base + "/api/stt", { method: "POST", body: new Uint8Array(100) })).status).toBe(503);
    const big = await post(base, "/api/prompter", { text: "x".repeat(400 * 1024) });
    expect(big.status).toBe(413);
  }, 10000);

  it("proxies speech to the configured recogniser with the language hint", async () => {
    let received = "";
    const whisper = createServer((request, response) => {
      let body = "";
      request.setEncoding("latin1");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => { received = body; response.end(JSON.stringify({ text: " Gimbal eingepackt " })); });
    });
    await new Promise((resolve) => whisper.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => { whisper.closeAllConnections(); whisper.close(); });
    const { base } = await start({ WHISPER_URL: `http://127.0.0.1:${whisper.address().port}/v1/audio/transcriptions` }, cleanup);
    const reply = await fetch(base + "/api/stt?lang=de", { method: "POST", body: new Uint8Array(4000) });
    expect(await reply.json()).toEqual({ text: "Gimbal eingepackt" });
    expect(received).toContain('name="language"');
    expect(received).toContain("de");
  }, 10000);
});

const python = ["python3", "python"].find((cmd) => spawnSync(cmd, ["--version"]).status === 0);

describe.skipIf(!python)("the MCP example", () => {
  const cleanup = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  it("lists its tools and reads the shoot over stdio", async () => {
    const { base } = await start({ TOKEN: "mcp-token" }, cleanup);
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dreh_status", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "dreh_take_eintragen", arguments: { szene: "1", shot: "A", status: "NG" } } },
    ].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const child = spawn(python, [example("dreh_mcp.py")], {
      env: { ...process.env, SHOOTDAY_URL: base, SHOOTDAY_TOKEN: "mcp-token", SHOOTDAY_LANG: "en", PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end(input);
    await new Promise((resolve) => child.on("close", resolve));
    const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(replies[1].result.tools.map((t) => t.name)).toContain("dreh_pack_setzen");
    expect(replies[2].result.content[0].text).toContain("Project: Example shoot");
    expect(replies[3].result.content[0].text).toContain("Logged: 1·A T1 NG");
  }, 15000);
});
