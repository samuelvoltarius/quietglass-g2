#!/usr/bin/env node
/**
 * Klipper Glance bridge: reads Moonraker (Klipper's API) on your LAN and
 * serves a compact status to the glasses.
 *
 * Why a bridge and not direct access: the printer is only on the LAN, while
 * the glasses go through the phone, which may be anywhere. A machine that sees
 * both (a Raspberry Pi, a NAS, your desktop) runs this and is reached by the
 * phone — over HTTPS, e.g. via `tailscale serve`.
 *
 *   node klipper-bridge.mjs                                   # http://127.0.0.1:8898/api/printer
 *   KL_MOONRAKER=http://printer.local:7125 node klipper-bridge.mjs
 *   KL_ALLOW_CONTROL=1 TOKEN=secret HOST=0.0.0.0 node klipper-bridge.mjs
 *
 * Environment
 *   PORT                port (default 8898)
 *   HOST                address to bind (default 127.0.0.1 — this machine only)
 *   TOKEN               bearer token required on every /api request when set
 *   KL_MOONRAKER        fixed Moonraker address; without it the bridge searches
 *   KL_SCAN_NET         /24 to search, e.g. 192.168.1 (default: this machine's
 *                       private networks)
 *   KL_MOONRAKER_PORT   Moonraker port to look for (default 7125)
 *   KL_RESCAN_MS        wait after a failed search (default 45000)
 *   KL_ALLOW_CONTROL=1  allow pause / resume / cancel. Refused anyway unless a
 *                       TOKEN is set — even on loopback, because CORS is open
 *                       and any web page in a local browser could post a cancel.
 *
 * Dependency-free: Node 18+ only.
 */
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";

const PORT = Number(process.env["PORT"] ?? process.env["KL_PORT"] ?? 8898);
const HOST = process.env["HOST"] ?? process.env["KL_HOST"] ?? "127.0.0.1";
const TOKEN = process.env["TOKEN"] ?? "";
const FIXED = (process.env["KL_MOONRAKER"] ?? "").replace(/\/+$/, "");
const MOON_PORT = Number(process.env["KL_MOONRAKER_PORT"] ?? 7125);
const RESCAN_MS = Number(process.env["KL_RESCAN_MS"] ?? 45000);
const LOOPBACK = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
/**
 * Pausing or cancelling a print is consequential, and CORS is open to every
 * origin (the glasses app has no fixed one). So control needs an explicit
 * switch AND, as soon as the bridge is reachable from other machines, a token.
 */
const CONTROL = process.env["KL_ALLOW_CONTROL"] === "1" && TOKEN !== "";
const CONTROL_BLOCKED = process.env["KL_ALLOW_CONTROL"] === "1" && !CONTROL;

/** The /24 networks to search: KL_SCAN_NET, or every private IPv4 network of this machine. */
function scanNets() {
  const fixed = (process.env["KL_SCAN_NET"] ?? "").trim();
  if (fixed) return fixed.split(",").map((s) => s.trim().replace(/\.$/, "")).filter((s) => /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s));
  const nets = new Set();
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const [a, b] = address.address.split(".").map(Number);
      const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
      // 100.64/10 (Tailscale, carrier NAT) is not a LAN with printers on it.
      if (isPrivate) nets.add(address.address.split(".").slice(0, 3).join("."));
    }
  }
  return [...nets];
}

let base = FIXED;
let scanning = false;
let failedScanAt = 0;

async function ping(url, ms) {
  try {
    const response = await fetch(`${url}/printer/info`, { signal: AbortSignal.timeout(ms) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Searches the LAN in the background; a full /24 takes several seconds. */
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    for (const net of scanNets()) {
      const hosts = [];
      for (let i = 1; i < 255; i++) hosts.push(`http://${net}.${i}:${MOON_PORT}`);
      for (let i = 0; i < hosts.length; i += 32) {
        const batch = hosts.slice(i, i + 32);
        const hits = await Promise.all(batch.map(async (host) => ((await ping(host, 900)) ? host : "")));
        const found = hits.find(Boolean);
        if (found) { base = found; console.log("found Moonraker at " + found); return; }
      }
    }
    failedScanAt = Date.now();
  } finally {
    scanning = false;
  }
}

async function moonraker(path, init = {}) {
  if (!base) return null;
  try {
    const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const QUERY = "/printer/objects/query?print_stats&display_status&heater_bed&extruder&virtual_sdcard&gcode_move";
const round = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);

function shape(raw) {
  const s = raw?.result?.status ?? {};
  const ps = s.print_stats ?? {};
  const progressRaw = s.display_status?.progress ?? s.virtual_sdcard?.progress ?? 0;
  const progress = Math.max(0, Math.min(100, Math.round(progressRaw * 100)));
  const printed = ps.print_duration ?? 0;
  // Klipper reports no remaining time itself; extrapolate from progress.
  const minutesLeft = progress > 1 ? Math.max(0, Math.round((printed / (progress / 100) - printed) / 60)) : null;
  return {
    online: true,
    state: ps.state ?? "unknown",               // standby | printing | paused | complete | cancelled | error
    file: typeof ps.filename === "string" ? ps.filename : "",
    progress,
    layer: round(ps.info?.current_layer),
    layers: round(ps.info?.total_layer),
    minutesLeft,
    nozzle: s.extruder ? { now: round(s.extruder.temperature), target: round(s.extruder.target) ?? 0 } : null,
    bed: s.heater_bed ? { now: round(s.heater_bed.temperature), target: round(s.heater_bed.target) ?? 0 } : null,
    speed: round((s.gcode_move?.speed_factor ?? 1) * 100) ?? 100,
    message: typeof ps.message === "string" ? ps.message : "",
    controllable: CONTROL,
  };
}

const offline = (reason, extra = {}) => ({ online: false, reason, controllable: CONTROL, ...extra });

async function status() {
  if (base) {
    const raw = await moonraker(QUERY);
    if (raw) return shape(raw);
    if (FIXED) return offline("printer-silent");
    base = "";                                   // the remembered address is stale
  }
  if (scanning) return offline("searching");
  const wait = RESCAN_MS - (Date.now() - failedScanAt);
  if (failedScanAt && wait > 0) return offline("no-printer", { nextScanSeconds: Math.ceil(wait / 1000) });
  void scan();
  return offline("searching");
}

const PATHS = { pause: "/printer/print/pause", resume: "/printer/print/resume", cancel: "/printer/print/cancel" };

async function command(name) {
  if (!CONTROL) return { status: 403, body: { ok: false, error: "control-off" } };
  if (!Object.hasOwn(PATHS, name)) return { status: 400, body: { ok: false, error: "unknown-command" } };
  if (!base) return { status: 409, body: { ok: false, error: "no-printer" } };
  const result = await moonraker(PATHS[name], { method: "POST" });
  if (!result) return { status: 502, body: { ok: false, error: "printer-error" } };
  console.log("sent " + name + " to the printer");
  return { status: 200, body: { ok: true, command: name } };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function send(response, code, body) {
  response.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(code === 204 ? "" : JSON.stringify(body));
}

const digest = (text) => createHash("sha256").update(text).digest();
/** Constant-time check, so response timing does not leak the TOKEN. */
function authorised(request) {
  if (!TOKEN) return true;
  return timingSafeEqual(digest(request.headers["authorization"] ?? ""), digest("Bearer " + TOKEN));
}

const TOO_LARGE = Symbol("too large");
function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    request.on("data", (chunk) => {
      if (done) return;
      raw += chunk;
      if (raw.length > 4096) { finish(TOO_LARGE); request.removeAllListeners("data"); request.resume(); }
    });
    request.on("end", () => { try { finish(JSON.parse(raw || "{}")); } catch { finish(null); } });
    request.on("error", () => finish(null));
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "OPTIONS") { send(response, 204, {}); return; }
  if (!authorised(request)) { send(response, 401, { error: "unauthorized" }); return; }
  try {
    if (url.pathname === "/api/printer" && request.method === "GET") { send(response, 200, await status()); return; }
    if (url.pathname === "/api/printer/info" && request.method === "GET") {
      send(response, 200, { found: Boolean(base), searching: scanning, controllable: CONTROL });
      return;
    }
    if (url.pathname === "/api/printer/cmd" && request.method === "POST") {
      const body = await readBody(request);
      if (body === TOO_LARGE) { send(response, 413, { ok: false, error: "too-large" }); return; }
      const result = await command(typeof body?.command === "string" ? body.command : "");
      send(response, result.status, result.body);
      return;
    }
    send(response, 404, { error: "not found" });
  } catch (error) {
    console.error("request failed: " + error.message);
    send(response, 500, { error: "internal error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log("Klipper Glance bridge on http://" + HOST + ":" + PORT + "/api/printer");
  console.log("  printer: " + (FIXED || "search " + (scanNets().map((n) => n + ".x").join(", ") || "(no private network found)") + ":" + MOON_PORT));
  console.log("  control: " + (CONTROL ? "on" : "off"));
  if (CONTROL_BLOCKED) console.log("  KL_ALLOW_CONTROL=1 ignored: printer control needs a TOKEN.");
  if (!TOKEN) console.log("  No TOKEN set: anyone who can reach this port can read the printer status.");
});
