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
 *   KL_TAILSCALE_USERS  Tailscale logins (comma list) that need no token when
 *                       `tailscale serve` proxies the request (loopback only)
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
 * `tailscale serve` connects from loopback and sets Tailscale-User-Login to the
 * signed-in tailnet user. A LAN client cannot reach a loopback-bound server, so
 * the header is only trusted from loopback and only for the logins in
 * KL_TAILSCALE_USERS (comma list). The TOKEN keeps working as the alternative.
 */
const TAILSCALE_USERS = String(process.env["KL_TAILSCALE_USERS"] ?? "").split(",").map((u) => u.trim().toLowerCase()).filter(Boolean);
function tailscaleUser(request) {
  const peer = String(request.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (peer !== "127.0.0.1" && peer !== "::1") return "";
  const login = String(request.headers["tailscale-user-login"] ?? "").trim().toLowerCase();
  return TAILSCALE_USERS.includes(login) ? login : "";
}
/**
 * Pausing or cancelling a print is consequential, and CORS is open to every
 * origin (the glasses app has no fixed one). So control needs an explicit
 * switch AND, as soon as the bridge is reachable from other machines, a token.
 */
const CONTROL = process.env["KL_ALLOW_CONTROL"] === "1" && (TOKEN !== "" || TAILSCALE_USERS.length > 0);
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
    z: typeof s.gcode_move?.gcode_position?.[2] === "number" ? Math.round(s.gcode_move.gcode_position[2] * 100) / 100 : null,
    message: typeof ps.message === "string" ? ps.message : "",
    controllable: CONTROL,
  };
}

const offline = (reason, extra = {}) => ({ online: false, reason, controllable: CONTROL, ...extra });

async function status() {
  if (base) {
    const raw = await moonraker(QUERY);
    if (raw) return { ...shape(raw), spool: await spool() };
    if (FIXED) return offline("printer-silent");
    base = "";                                   // the remembered address is stale
  }
  if (scanning) return offline("searching");
  const wait = RESCAN_MS - (Date.now() - failedScanAt);
  if (failedScanAt && wait > 0) return offline("no-printer", { nextScanSeconds: Math.ceil(wait / 1000) });
  void scan();
  return offline("searching");
}

/**
 * The slicer's preview picture of a print file (PNG), via Moonraker's file
 * metadata. The largest preview up to 400 px wide is used; the last one is
 * cached, since the glasses ask once per print. null when there is none.
 */
const THUMB_MAX_BYTES = 1_500_000;
let thumbCache = { file: "", png: null };

function validFile(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 255 && !name.split("/").includes("..") && !name.startsWith("/");
}

async function thumbnail(file) {
  if (!base || !validFile(file)) return null;
  if (thumbCache.file === file) return thumbCache.png;
  const meta = await moonraker("/server/files/metadata?filename=" + encodeURIComponent(file));
  if (!meta) return null;                        // printer busy or away: ask again next time
  const list = Array.isArray(meta?.result?.thumbnails) ? meta.result.thumbnails : [];
  const usable = list.filter((t) => typeof t?.relative_path === "string" && t.relative_path.toLowerCase().endsWith(".png") && Number(t.width) > 0);
  const fitting = usable.filter((t) => Number(t.width) <= 400);
  const pick = (fitting.length ? fitting : usable).sort((a, b) => Number(b.width) - Number(a.width))[0];
  let png = null;
  if (pick) {
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
    const path = (dir + pick.relative_path).split("/").map(encodeURIComponent).join("/");
    try {
      const response = await fetch(base + "/server/files/gcodes/" + path, { signal: AbortSignal.timeout(4000) });
      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 8 && bytes.length <= THUMB_MAX_BYTES && bytes.readUInt32BE(0) === 0x89504e47) png = bytes;
      }
    } catch {
      png = null;
    }
  }
  thumbCache = { file, png };
  return png;
}

/**
 * The active Spoolman spool, through Moonraker's Spoolman proxy (needs
 * [spoolman] in moonraker.conf). Read only; cached for 30 s; null when
 * Spoolman is not set up or no spool is active.
 */
let spoolCache = { at: 0, value: null };
async function spool() {
  if (Date.now() - spoolCache.at < 30_000) return spoolCache.value;
  let value = null;
  const active = await moonraker("/server/spoolman/spool_id");
  const id = active?.result?.spool_id;
  if (Number.isInteger(id) && id > 0) {
    const reply = await moonraker("/server/spoolman/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_method: "GET", path: "/v1/spool/" + id }),
    });
    // Moonraker returns the Spoolman body directly (API v2) or wrapped in { response } (v1).
    const raw = reply?.result;
    const sp = raw && typeof raw === "object" ? (raw.filament ? raw : raw.response ?? null) : null;
    if (sp && typeof sp === "object") {
      const f = sp.filament ?? {};
      const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);
      value = {
        id,
        material: typeof f.material === "string" ? f.material.slice(0, 20) : "",
        vendor: typeof f.vendor?.name === "string" ? f.vendor.name.slice(0, 24) : "",
        name: typeof f.name === "string" ? f.name.slice(0, 32) : "",
        grams: num(sp.remaining_weight) === null ? null : Math.round(sp.remaining_weight),
        meters: num(sp.remaining_length) === null ? null : Math.round(sp.remaining_length / 100) / 10,
      };
    }
  }
  spoolCache = { at: Date.now(), value };
  return value;
}

/**
 * The print as layers of line segments, for the glasses' layer view. The
 * G-code is read once per file (streamed, any size) and kept: extruding moves
 * only, short pieces merged, thinned to SEG_BUDGET segments by keeping every
 * n-th layer. Coordinates in 0.1 mm as Int16, sent base64:
 *   { file, bounds:[x0,y0,z0,x1,y1,z1], z:[...], start:[...], segs:"<base64>", layersTotal }
 * While it is being prepared the endpoint answers 202 { preparing: true }.
 */
const SEG_BUDGET = 40_000;
const MIN_SEG_MM = 0.6;
let modelState = { file: "", status: "none", model: null };

const WORD = {};
for (const letter of ["X", "Y", "Z", "E"]) WORD[letter] = new RegExp("(?:^|\\s)" + letter + "(-?\\d*\\.?\\d+)", "i");
const word = (line, letter) => {
  const m = line.match(WORD[letter]);
  return m ? Number(m[1]) : null;
};

export function gcodeLayers() {
  let absXYZ = true, absE = true;
  let x = 0, y = 0, z = 0, e = 0;
  const layers = [];
  let layer = null;
  let px = null, py = null;
  return {
    line(raw) {
      const line = raw.split(";")[0].trim();
      if (!line) return;
      const cmd = line.split(/\s+/)[0].toUpperCase();
      if (cmd === "G90") { absXYZ = true; return; }
      if (cmd === "G91") { absXYZ = false; return; }
      if (cmd === "M82") { absE = true; return; }
      if (cmd === "M83") { absE = false; return; }
      if (cmd === "G92") { const ne = word(line, "E"); if (ne !== null) e = ne; return; }
      if (!/^G0?[0-3]$/.test(cmd)) return;
      const nx = word(line, "X"), ny = word(line, "Y"), nz = word(line, "Z"), ne = word(line, "E");
      const tx = nx === null ? x : absXYZ ? nx : x + nx;
      const ty = ny === null ? y : absXYZ ? ny : y + ny;
      const tz = nz === null ? z : absXYZ ? nz : z + nz;
      let extrudes = false;
      if (ne !== null) {
        const te = absE ? ne : e + ne;
        extrudes = te - e > 1e-5;
        e = te;
      }
      if (extrudes && (tx !== x || ty !== y)) {
        if (!layer || tz > layer.z + 0.01) { layer = { z: tz, segs: [] }; layers.push(layer); px = null; }
        if (px === null) { px = x; py = y; }
        if (Math.hypot(tx - px, ty - py) >= MIN_SEG_MM) { layer.segs.push(px, py, tx, ty); px = tx; py = ty; }
      } else {
        px = null;
      }
      x = tx; y = ty; z = tz;
    },
    done() {
      const total = layers.reduce((n, l) => n + l.segs.length / 4, 0);
      const every = Math.max(1, Math.ceil(total / SEG_BUDGET));
      const kept = layers.filter((_, i) => i % every === 0 || i === layers.length - 1);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const l of kept) {
        for (let i = 0; i < l.segs.length; i += 2) {
          x0 = Math.min(x0, l.segs[i]); x1 = Math.max(x1, l.segs[i]);
          y0 = Math.min(y0, l.segs[i + 1]); y1 = Math.max(y1, l.segs[i + 1]);
        }
      }
      const count = kept.reduce((n, l) => n + l.segs.length, 0);
      const ints = new Int16Array(count);
      const start = [];
      let k = 0;
      for (const l of kept) {
        start.push(k / 4);
        for (const v of l.segs) ints[k++] = Math.max(-32768, Math.min(32767, Math.round(v * 10)));
      }
      const r = (n) => Math.round(n * 100) / 100;
      return {
        bounds: kept.length ? [r(x0), r(y0), r(kept[0].z), r(x1), r(y1), r(kept[kept.length - 1].z)] : [0, 0, 0, 0, 0, 0],
        z: kept.map((l) => r(l.z)),
        start,
        segs: Buffer.from(ints.buffer, ints.byteOffset, ints.byteLength).toString("base64"),
        layersTotal: layers.length,
      };
    },
  };
}

async function buildModel(file) {
  const path = file.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(base + "/server/files/gcodes/" + path, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error("gcode " + response.status);
  const parser = gcodeLayers();
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of response.body) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) parser.line(line);
  }
  if (rest) parser.line(rest);
  return { file, ...parser.done() };
}

function layerModel(file) {
  if (!base || !validFile(file)) return { status: 404, body: { error: "no-model" } };
  if (modelState.file === file) {
    if (modelState.status === "ready") return { status: 200, body: modelState.model };
    if (modelState.status === "preparing") return { status: 202, body: { preparing: true } };
    // A failed attempt is retried after a minute (the printer may have been busy).
    if (Date.now() - (modelState.at ?? 0) < 60_000) return { status: 404, body: { error: "no-model" } };
  }
  modelState = { file, status: "preparing", model: null, at: Date.now() };
  buildModel(file).then(
    (built) => {
      if (modelState.file !== file) return;
      modelState = { file, status: "ready", model: built, at: Date.now() };
      console.log("layer model ready: " + built.z.length + " of " + built.layersTotal + " layers");
    },
    (error) => {
      if (modelState.file !== file) return;
      modelState = { file, status: "failed", model: null, at: Date.now() };
      console.log("layer model failed: " + error.message);
    },
  );
  return { status: 202, body: { preparing: true } };
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
  if (tailscaleUser(request) !== "") return true;
  // With an allow-list and no TOKEN, only the listed tailnet users get in.
  if (!TOKEN) return TAILSCALE_USERS.length === 0;
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
    if (url.pathname === "/api/printer/thumb" && request.method === "GET") {
      const png = await thumbnail(url.searchParams.get("file") ?? "");
      if (!png) { send(response, 404, { error: "no-thumbnail" }); return; }
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": png.length,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      response.end(png);
      return;
    }
    if (url.pathname === "/api/printer/model" && request.method === "GET") {
      const result = layerModel(url.searchParams.get("file") ?? "");
      send(response, result.status, result.body);
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
  if (CONTROL_BLOCKED) console.log("  KL_ALLOW_CONTROL=1 ignored: printer control needs a TOKEN or KL_TAILSCALE_USERS.");
  if (!TOKEN && TAILSCALE_USERS.length === 0) console.log("  No TOKEN set: anyone who can reach this port can read the printer status.");
});
