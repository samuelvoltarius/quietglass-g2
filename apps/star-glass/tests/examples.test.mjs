import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";
import { readSequence, flipMinutes, readGuider, readWeather, readSafety, readSite, decodePngGray, encodePngGray, fitPreview } from "../examples/star-bridge.mjs";

const example = (name) => fileURLToPath(new URL("../examples/" + name, import.meta.url));

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function start(name, env, cleanup) {
  const port = await freePort();
  const child = spawn(process.execPath, [example(name)], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TOKEN: "", STAR_ALLOW_CONTROL: "", STAR_TAILSCALE_USERS: "", STAR_WS: "0", ...env },
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

async function ninaAndBridge(env, cleanup) {
  const nina = await start("mock-nina.mjs", {}, cleanup);
  const bridge = await start("star-bridge.mjs", { STAR_NINA: nina.base, STAR_POLL_MS: "500", ...env }, cleanup);
  return { nina, bridge };
}

/** Polls until the bridge has read N.I.N.A. once. */
async function status(base, headers = {}) {
  for (let i = 0; i < 40; i++) {
    const reply = await fetch(base + "/api/star", { headers });
    if (reply.status !== 200) return { reply, body: null };
    const body = await reply.json();
    if (body.online && body.last) return { reply, body };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("bridge never came online");
}

describe("the Star Glass bridge", () => {
  const cleanup = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  it("sums N.I.N.A. up in the shape the app reads, without the site coordinates", async () => {
    const { bridge } = await ninaAndBridge({}, cleanup);
    const { body } = await status(bridge.base);
    expect(body.sequence).toEqual({ state: "running", target: "M 42", step: "Take Exposure", frame: 4, frames: 10 });
    expect(body.exposure.active).toBe(true);
    expect(body.exposure.total).toBe(60);
    expect(body.exposure.remaining).toBeGreaterThan(15);
    expect(body.filter).toBe("L");
    expect(body.camera).toMatchObject({ connected: true, temp: -9.8, setpoint: -10, cooler: true, power: 41, canCool: true });
    expect(body.mount).toMatchObject({ connected: true, tracking: true, alt: 41.3, flipMinutes: 12, pier: "east" });
    expect(body.focuser).toMatchObject({ connected: true, position: 12000, temp: 6.3 });
    expect(body.guider).toEqual({ connected: true, guiding: true, rms: 0.64, ra: 0.4, dec: 0.5 });
    expect(body.last).toMatchObject({ index: 2, filter: "L", hfr: 2.31, stars: 920, target: "M 42" });
    expect(body.history.hfr).toEqual([2.4, 2.2, 2.31]);
    expect(body.controllable).toBe(false);
    expect(body.weather).toEqual({
      connected: true, name: "Mock CloudWatcher", cloudCover: 35, rainRate: 0, humidity: 81, dewPoint: 3.2, temperature: 6.1,
      windSpeed: 9, windGust: 18, skyQuality: 20.84,
    });
    expect(body.safety).toEqual({ connected: true, safe: true });
    expect(body.site).toBeUndefined();
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/Site|Latitude|Longitude|1\.2345|6\.789|\.fits/);
  }, 20000);

  it("shares the site rounded to 2 decimals only with STAR_SITE=1", async () => {
    const { bridge } = await ninaAndBridge({ STAR_SITE: "1" }, cleanup);
    const { body } = await status(bridge.base);
    expect(body.site).toEqual({ lat: 1.23, lon: 6.79 });
    expect(JSON.stringify(body)).not.toMatch(/1\.2345|6\.789/);
  }, 20000);

  it("serves the newest frame as a 288 x 144 grayscale PNG", async () => {
    const { bridge } = await ninaAndBridge({}, cleanup);
    const { body } = await status(bridge.base);
    expect(body.preview).toMatch(/^[0-9a-f]{12}$/);
    const reply = await fetch(bridge.base + "/api/star/preview.png");
    expect(reply.headers.get("content-type")).toBe("image/png");
    const image = decodePngGray(Buffer.from(await reply.arrayBuffer()));
    expect([image.width, image.height]).toEqual([288, 144]);
  }, 20000);

  it("answers a CORS preflight with 204 and no body, echoing the origin", async () => {
    const { bridge } = await ninaAndBridge({ STAR_TAILSCALE_USERS: "me@example.com" }, cleanup);
    const reply = await fetch(bridge.base + "/api/star", { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Headers": "authorization" } });
    expect(reply.status).toBe(204);
    expect(await reply.text()).toBe("");
    expect(reply.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(reply.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
  }, 20000);

  it("lets listed Tailscale logins in from loopback and refuses everyone else", async () => {
    const { bridge } = await ninaAndBridge({ STAR_TAILSCALE_USERS: "me@example.com" }, cleanup);
    expect((await fetch(bridge.base + "/api/star")).status).toBe(401);
    expect((await fetch(bridge.base + "/api/star", { headers: { "Tailscale-User-Login": "other@example.com" } })).status).toBe(401);
    const { reply } = await status(bridge.base, { "Tailscale-User-Login": "Me@Example.com" });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("access-control-allow-origin")).toBe("*");
  }, 20000);

  it("accepts the token as the alternative", async () => {
    const { bridge } = await ninaAndBridge({ TOKEN: "s3cret" }, cleanup);
    expect((await fetch(bridge.base + "/api/star", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect(bridge.output.stderr + bridge.output.stdout).not.toContain("nope");
    const { reply } = await status(bridge.base, { Authorization: "Bearer s3cret" });
    expect(reply.status).toBe(200);
  }, 20000);

  it("refuses control unless STAR_ALLOW_CONTROL=1 and a login is configured", async () => {
    const { bridge } = await ninaAndBridge({ STAR_ALLOW_CONTROL: "1" }, cleanup);
    const reply = await fetch(bridge.base + "/api/star/cmd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "stop" }) });
    expect(reply.status).toBe(403);
    expect(bridge.output.stdout).toContain("ignored");
  }, 20000);

  it("stops and resumes the sequence when allowed", async () => {
    const { bridge } = await ninaAndBridge({ STAR_ALLOW_CONTROL: "1", TOKEN: "t" }, cleanup);
    const headers = { Authorization: "Bearer t", "Content-Type": "application/json" };
    const { body } = await status(bridge.base, headers);
    expect(body.controllable).toBe(true);
    const bad = await fetch(bridge.base + "/api/star/cmd", { method: "POST", headers, body: JSON.stringify({ command: "rm -rf" }) });
    expect(bad.status).toBe(400);
    const stop = await fetch(bridge.base + "/api/star/cmd", { method: "POST", headers, body: JSON.stringify({ command: "stop" }) });
    expect(await stop.json()).toEqual({ ok: true, command: "stop" });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await (await fetch(bridge.base + "/api/star", { headers })).json();
    expect(after.sequence.state).toBe("idle");
  }, 20000);

  it("says when N.I.N.A. is silent", async () => {
    const port = await freePort();
    const bridge = await start("star-bridge.mjs", { STAR_NINA: `http://127.0.0.1:${port}`, STAR_POLL_MS: "500" }, cleanup);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const body = await (await fetch(bridge.base + "/api/star")).json();
    expect(body).toEqual({ v: 1, online: false, reason: "nina-silent", controllable: false });
  }, 20000);
});

describe("bridge helpers", () => {
  it("reads a sequence tree as the live Advanced API 2.2.15 sends it", () => {
    // Captured from N.I.N.A. 3.2 (simulator), trimmed.
    const tree = [
      { GlobalTriggers: [] },
      { Name: "Start_Container", Status: "FINISHED", Items: [] },
      { Name: "Targets_Container", Status: "RUNNING", Items: [{
        Name: "M 31 Andromeda_Container", Target: { TargetName: "M 31 Andromeda" }, Status: "RUNNING", Items: [{
          Name: "Take Many Exposures_Container", Status: "RUNNING",
          Conditions: [{ Iterations: 12, Name: "Loop For Iterations_Condition", Status: "CREATED", CompletedIterations: 0 }],
          Items: [{ ImageType: "LIGHT", Name: "Take Exposure", Status: "RUNNING", ExposureTime: 20.0 }],
        }],
      }] },
      { Name: "End_Container", Status: "CREATED", Items: [] },
    ];
    expect(readSequence(tree)).toMatchObject({ state: "running", target: "M 31 Andromeda", step: "Take Exposure", frame: 1, frames: 12, exposureSeconds: 20 });
    const finished = tree.map((n) => (n.Name === "Targets_Container" ? { ...n, Status: "FINISHED", Items: [] } : n));
    expect(readSequence(finished).state).toBe("finished");
    // After a stop N.I.N.A. shows everything as CREATED again: idle, with the target a resume continues.
    const halt = (n) => ({ ...n, ...(n.Status === "RUNNING" ? { Status: "CREATED" } : {}), ...(Array.isArray(n.Items) ? { Items: n.Items.map(halt) } : {}) });
    expect(readSequence(tree.map(halt))).toMatchObject({ state: "idle", target: "M 31 Andromeda", frame: null });
    expect(readSequence([{ GlobalTriggers: [] }, { Name: "Start_Container", Status: "CREATED", Items: [] }]).state).toBe("none");
    expect(readSequence(null).state).toBe("none");
  });

  it("flip minutes only while tracking; guider in arc seconds", () => {
    expect(flipMinutes({ TrackingEnabled: true, TimeToMeridianFlip: 0.5 })).toBe(30);
    expect(flipMinutes({ TrackingEnabled: false, TimeToMeridianFlip: 0.5 })).toBeNull();
    expect(flipMinutes({ TrackingEnabled: true, TimeToMeridianFlip: 24 })).toBeNull();
    expect(readGuider({ Connected: false })).toMatchObject({ connected: false, rms: null });
    expect(readGuider({ Connected: true, PixelScale: 1.5, RMSError: { Total: { Pixel: 0.5 } } })).toMatchObject({ rms: 0.75, guiding: null });
  });

  it("weather station, safety monitor and site", () => {
    expect(readWeather({ Connected: false })).toEqual({ connected: false });
    expect(readWeather(null)).toEqual({ connected: false });
    const w = readWeather({ Connected: true, Name: "AAG", CloudCover: "NaN", RainRate: 1.24, WindSpeed: 10, WindGust: "NaN", SkyQuality: 21.123 });
    expect(w).toMatchObject({ connected: true, name: "AAG", cloudCover: null, rainRate: 1.2, windSpeed: 36, windGust: null, skyQuality: 21.12 });
    expect(readSafety({ Connected: true, IsSafe: false })).toEqual({ connected: true, safe: false });
    expect(readSafety({ Connected: true })).toEqual({ connected: true, safe: null });
    expect(readSafety(undefined)).toEqual({ connected: false, safe: null });
    expect(readSite({ Connected: true, SiteLatitude: 47.80951, SiteLongitude: 13.05502 }, null)).toEqual({ lat: 47.81, lon: 13.06 });
    expect(readSite({ Connected: true, SiteLatitude: 0, SiteLongitude: 0 }, { AstrometrySettings: { Latitude: 47.8, Longitude: 13.04 } })).toEqual({ lat: 47.8, lon: 13.04 });
    expect(readSite({ Connected: false }, null)).toBeNull();
  });

  it("decodes 16-bit PNGs and fits them into the preview box", () => {
    // A 16-bit gray PNG like N.I.N.A. streams: build one by hand.
    const w = 8, h = 6;
    const eight = encodePngGray({ width: w, height: h, pixels: Uint8Array.from({ length: w * h }, (_, i) => i * 5) });
    const back = decodePngGray(eight);
    expect(back.width).toBe(8);
    expect(back.pixels[7]).toBe(35);
    const fitted = fitPreview({ width: 640, height: 480, pixels: new Uint8Array(640 * 480).fill(30) });
    expect([fitted.width, fitted.height]).toEqual([288, 144]);
    expect(fitted.pixels[0]).toBe(0); // letterbox bar at the left
    expect(() => decodePngGray(Buffer.from("nope"))).toThrow();

    // 16 bit, filter 2 (Up) on the second row: the high byte is what counts.
    const chunk = (type, data) => {
      const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1");
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
      return Buffer.concat([head, data, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 16; ihdr[9] = 0;
    const raw = Buffer.from([0, 0x10, 0x00, 0x20, 0xff, 2, 0x01, 0x00, 0x01, 0x00]);
    const png16 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
    expect(Array.from(decodePngGray(png16).pixels)).toEqual([0x10, 0x20, 0x11, 0x21]);
  });
});
