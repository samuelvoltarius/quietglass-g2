#!/usr/bin/env node
/**
 * Status Glass reference server.
 *
 * A complete, dependency-free host monitor for Linux homelab machines. Copy it,
 * trim `collect()` to what you care about, and point Status Glass at it.
 *
 *   node reference-server.mjs                 # http://127.0.0.1:8099/status
 *   PORT=9000 TOKEN=secret node reference-server.mjs
 *
 * What it reports (every metric is left out when the machine cannot tell):
 *
 *   cpu, load, memory, freemem, swap   CPU %, load per core, RAM, swap
 *   disk:<mount>                       usage of / and every large local disk
 *   temp, temp_nvme                    CPU/SoC and NVMe temperature
 *   gpu, gpu_mem, gpu_temp, gpu_power  first NVIDIA GPU (nvidia-smi)
 *   net_rx, net_tx                     network rate in Mbit/s
 *   docker                             running containers (unhealthy = warn)
 *   failed                             failed systemd units, names in `detail`
 *   svc:<name>                         services listed in STATUS_SERVICES
 *   tailscale                          this node online, peers in `detail`
 *   uptime                             hours
 *
 * Settings (environment, e.g. via a systemd EnvironmentFile):
 *
 *   NAME                    name shown on the glasses
 *   TOKEN                   bearer token (optional)
 *   STATUS_TAILSCALE_USERS  comma list of Tailscale logins that need no token
 *                           when `tailscale serve` proxies from loopback
 *   STATUS_SERVICES         comma list of systemd units to watch; prefix
 *                           `user:` for a unit of the user running this server
 *   STATUS_IGNORE_UNITS     comma list of failed units not to count
 *   STATUS_DISKS            comma list of mount points; replaces the automatic
 *                           choice (network mounts are only read when listed)
 *
 * Everything slow (nvidia-smi, systemctl, docker, tailscale, disks) is sampled
 * in the background, so a request only reads memory and answers in a few ms.
 * Nothing secret is reported: no addresses, no tokens, no environment.
 */
import { createServer, request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { cpus, freemem, totalmem, loadavg, uptime } from "node:os";

const PORT = Number(process.env["PORT"] ?? 8099);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const TOKEN = process.env["TOKEN"] ?? "";
const NAME = process.env["NAME"] ?? "reference";
const list = (value) => String(value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const TAILSCALE_USERS = list(process.env["STATUS_TAILSCALE_USERS"]).map((u) => u.toLowerCase());
const SERVICES = list(process.env["STATUS_SERVICES"]);
const IGNORE_UNITS = new Set(list(process.env["STATUS_IGNORE_UNITS"]).map(unitName));
const DISKS = list(process.env["STATUS_DISKS"]);
const FAST_MS = Number(process.env["STATUS_FAST_MS"] ?? 5000);
const SLOW_MS = Number(process.env["STATUS_SLOW_MS"] ?? 15000);
/** Tools installed outside the PATH a service gets (snap, sbin). */
const PATH = [process.env["PATH"] ?? "", "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin", "/snap/bin"].filter(Boolean).join(":");

/** `tailscale serve` connects from loopback and sets Tailscale-User-Login; a LAN client cannot spoof it. */
function tailscaleUser(request) {
  const peer = String(request.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (peer !== "127.0.0.1" && peer !== "::1") return "";
  const login = String(request.headers["tailscale-user-login"] ?? "").trim().toLowerCase();
  return TAILSCALE_USERS.includes(login) ? login : "";
}

// ---- helpers ---------------------------------------------------------------

function read(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function run(file, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, env: { ...process.env, PATH, LC_ALL: "C" }, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      // systemctl is-active exits non-zero for inactive units but still prints the answer.
      resolve({ ok: !error, stdout: String(stdout ?? "") });
    });
  });
}

const round = (value, digits = 1) => Number(value.toFixed(digits));
const gb = (bytes) => bytes / 1e9;
/** "503/916 GB" — one decimal below 10. */
function amount(used, total) {
  const f = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));
  return `${f(gb(used))}/${f(gb(total))} GB`;
}
function unitName(unit) {
  return unit.replace(/^user:/, "").replace(/\.service$/, "");
}

// ---- fast samples: CPU, network, temperature ---------------------------------

const state = {
  cpu: null, net: null, temp: null, tempNvme: null,
  disks: null, gpu: null, failed: null, services: null, docker: null, tailscale: null,
};
let lastCpu = null;
let lastNet = null;

function cpuTimes() {
  const line = (read("/proc/stat") ?? "").split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (v[3] ?? 0) + (v[4] ?? 0);
  const total = v.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
  return { idle, total };
}

/** Interfaces that carry real traffic; virtual bridges would count everything twice. */
const VIRTUAL = /^(lo|veth|docker|br-|virbr|cni|flannel|cali|vnet|tap|tun|tailscale|wg|kube|lxc|fwbr|fwpr|fwln|vmbr)/;
function netBytes() {
  const text = read("/proc/net/dev");
  if (!text) return null;
  let rx = 0, tx = 0, seen = 0;
  for (const line of text.split("\n").slice(2)) {
    const [name, rest] = line.split(":");
    if (!rest || VIRTUAL.test(name.trim())) continue;
    const v = rest.trim().split(/\s+/).map(Number);
    rx += v[0] || 0; tx += v[8] || 0; seen += 1;
  }
  return seen > 0 ? { rx, tx, at: Date.now() } : null;
}

function milli(path) {
  const v = Number((read(path) ?? "").trim());
  return Number.isFinite(v) && v !== 0 ? v / 1000 : null;
}

/** Highest plausible reading of a set of sensor files. */
function hottest(paths) {
  let best = null;
  for (const p of paths) {
    const c = milli(p);
    if (c !== null && c > 5 && c < 130 && (best === null || c > best)) best = c;
  }
  return best;
}

const CPU_HWMON = ["coretemp", "k10temp", "zenpower", "cpu_thermal", "cpu-thermal", "soc_thermal"];
const CPU_ZONES = /^(x86_pkg_temp|cpu|soc|cpu-thermal|cpu_thermal|soc_thermal|tcpu)/i;

function hwmons() {
  const base = "/sys/class/hwmon";
  try {
    return readdirSync(base).map((d) => {
      const dir = `${base}/${d}`;
      const files = (() => { try { return readdirSync(dir); } catch { return []; } })();
      return { name: (read(`${dir}/name`) ?? "").trim(), inputs: files.filter((f) => /^temp\d+_input$/.test(f)).map((f) => `${dir}/${f}`) };
    });
  } catch { return []; }
}

function temperatures() {
  const mons = hwmons();
  const cpuMons = mons.filter((m) => CPU_HWMON.includes(m.name));
  let cpu = hottest(cpuMons.flatMap((m) => m.inputs));
  let source = cpuMons[0]?.name ?? null;
  if (cpu === null) {
    let zones = [];
    try { zones = readdirSync("/sys/class/thermal").filter((z) => z.startsWith("thermal_zone")); } catch { /* none */ }
    const typed = zones.map((z) => ({ type: (read(`/sys/class/thermal/${z}/type`) ?? "").trim(), path: `/sys/class/thermal/${z}/temp` }));
    const cpuZones = typed.filter((z) => CPU_ZONES.test(z.type));
    // ACPI zones are the fallback (e.g. ARM boards whose SoC only reports there).
    const pick = cpuZones.length > 0 ? cpuZones : typed.filter((z) => z.type === "acpitz");
    cpu = hottest(pick.map((z) => z.path));
    source = pick[0]?.type ?? null;
  }
  const nvme = hottest(mons.filter((m) => m.name === "nvme").flatMap((m) => m.inputs));
  return { cpu: cpu === null ? null : { value: round(cpu), source }, nvme: nvme === null ? null : round(nvme) };
}

function sampleFast() {
  const times = cpuTimes();
  if (times && lastCpu && times.total > lastCpu.total) {
    const busy = 1 - (times.idle - lastCpu.idle) / (times.total - lastCpu.total);
    state.cpu = round(Math.min(100, Math.max(0, busy * 100)));
  }
  if (times) lastCpu = times;

  const bytes = netBytes();
  if (bytes && lastNet && bytes.at > lastNet.at) {
    const seconds = (bytes.at - lastNet.at) / 1000;
    const rate = (now, before) => Math.max(0, now - before) * 8 / 1e6 / seconds;
    state.net = { rx: round(rate(bytes.rx, lastNet.rx), 2), tx: round(rate(bytes.tx, lastNet.tx), 2) };
  }
  if (bytes) lastNet = bytes;

  const temps = temperatures();
  state.temp = temps.cpu;
  state.tempNvme = temps.nvme;
}

// ---- slow samples: disks, GPU, systemd, docker, tailscale --------------------

const LOCAL_FS = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "bcachefs", "jfs", "reiserfs", "ntfs", "ntfs3", "exfat", "vfat", "fuseblk"]);
const SKIP_MOUNT = /^\/(boot|snap|proc|sys|dev|run|var\/lib\/(docker|containers|kubelet|snapd))(\/|$)/;
const MIN_DISK_BYTES = 8e9;

/** "/mnt/my\040disk" → "/mnt/my disk" */
const unescapeMount = (path) => path.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

function mountCandidates() {
  const text = read("/proc/self/mounts") ?? read("/proc/mounts") ?? "";
  const rows = text.split("\n").map((l) => l.split(" ")).filter((r) => r.length >= 3)
    .map(([device, mount, type]) => ({ device, mount: unescapeMount(mount), type }));
  if (DISKS.length > 0) return DISKS.map((mount) => rows.find((r) => r.mount === mount) ?? { device: mount, mount, type: "listed" });
  const seen = new Set();
  return rows
    .filter((r) => LOCAL_FS.has(r.type) && (r.mount === "/" || !SKIP_MOUNT.test(r.mount)))
    .sort((a, b) => a.mount.length - b.mount.length)
    .filter((r) => {
      // One line per device: bind mounts and btrfs subvolumes would repeat it.
      const key = r.type === "zfs" ? r.mount : r.device;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function sampleDisks() {
  const out = [];
  for (const candidate of mountCandidates().slice(0, 8)) {
    const info = await Promise.race([
      statfs(candidate.mount).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (!info || !info.blocks) continue;
    const total = info.blocks * info.bsize;
    const used = (info.blocks - info.bfree) * info.bsize;
    // Usage as df shows it: the reserved blocks count as full.
    const usable = used + info.bavail * info.bsize;
    if (candidate.mount !== "/" && DISKS.length === 0 && total < MIN_DISK_BYTES) continue;
    out.push({ mount: candidate.mount, percent: round(usable > 0 ? (used / usable) * 100 : 0), used, total });
  }
  return out;
}

async function sampleGpu() {
  const result = await run("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader,nounits"]);
  if (!result.ok) return null;
  const first = result.stdout.split("\n").find((l) => l.trim());
  if (!first) return null;
  const [name, util, memUsed, memTotal, temp, power] = first.split(",").map((s) => s.trim());
  const num = (s) => { const v = Number(s); return s && !/N\/A|not supported/i.test(s) && Number.isFinite(v) ? v : null; };
  return { name: name || "GPU", util: num(util), memUsed: num(memUsed), memTotal: num(memTotal), temp: num(temp), power: num(power) };
}

async function sampleFailed() {
  const result = await run("systemctl", ["list-units", "--failed", "--plain", "--no-legend", "--no-pager"]);
  if (!result.ok && !result.stdout) return null;
  return result.stdout.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
    .map((u) => u.replace(/^●/, "")).filter(Boolean)
    .filter((u) => !IGNORE_UNITS.has(unitName(u)) && !IGNORE_UNITS.has(u));
}

async function sampleServices() {
  if (SERVICES.length === 0) return null;
  const out = [];
  for (const entry of SERVICES) {
    const user = entry.startsWith("user:");
    const unit = entry.replace(/^user:/, "");
    const result = await run("systemctl", [...(user ? ["--user"] : []), "is-active", unit]);
    out.push({ name: unitName(entry), active: result.stdout.trim() || "unknown" });
  }
  return out;
}

/** Docker's API over its socket: no CLI start-up, and readable by members of the docker group. */
function sampleDocker() {
  const socket = "/var/run/docker.sock";
  if (!existsSync(socket)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = httpRequest({ socketPath: socket, path: "/containers/json?all=1", timeout: 3000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const containers = JSON.parse(body);
          if (!Array.isArray(containers)) return resolve(null);
          const running = containers.filter((c) => c.State === "running");
          const unhealthy = running.filter((c) => /unhealthy/i.test(String(c.Status ?? "")))
            .map((c) => String(c.Names?.[0] ?? c.Id ?? "?").replace(/^\//, ""));
          resolve({ running: running.length, total: containers.length, unhealthy });
        } catch { resolve(null); }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function sampleTailscale() {
  const result = await run("tailscale", ["status", "--json"]);
  if (!result.stdout) return null;
  try {
    const status = JSON.parse(result.stdout);
    const peers = Object.values(status.Peer ?? {});
    return {
      online: status.BackendState === "Running" && status.Self?.Online !== false,
      backend: String(status.BackendState ?? "unknown"),
      peersOnline: peers.filter((p) => p.Online).length,
      peers: peers.length,
    };
  } catch { return null; }
}

let slowBusy = false;
async function sampleSlow() {
  if (slowBusy) return;
  slowBusy = true;
  try {
    const [disks, gpu, failed, services, docker, tailscale] = await Promise.all([
      sampleDisks().catch(() => null), sampleGpu().catch(() => null), sampleFailed().catch(() => null),
      sampleServices().catch(() => null), sampleDocker().catch(() => null), sampleTailscale().catch(() => null),
    ]);
    Object.assign(state, { disks, gpu, failed, services, docker, tailscale });
  } finally {
    slowBusy = false;
  }
}

// ---- the report ---------------------------------------------------------------

function meminfo() {
  const text = read("/proc/meminfo");
  if (!text) return null;
  const kb = (key) => { const m = new RegExp("^" + key + ":\\s+(\\d+)", "m").exec(text); return m ? Number(m[1]) * 1024 : null; };
  return { total: kb("MemTotal"), available: kb("MemAvailable"), swapTotal: kb("SwapTotal"), swapFree: kb("SwapFree") };
}

/** Joins names into a short line for `detail`. */
function names(items, max = 4) {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} +${items.length - max}` : shown;
}

/**
 * Builds the report.
 *
 * Every metric needs `id` and `label`, plus either a numeric `value` or an
 * explicit `state`. `warn` and `critical` are optional thresholds; set
 * `lowerIsWorse: true` for metrics where a small number is the bad one.
 * `detail` is an optional short text (used/total, names).
 */
function collect() {
  const metrics = [];
  const cores = cpus().length || 1;
  const [l1 = 0, l5 = 0, l15 = 0] = loadavg();

  if (state.cpu !== null) metrics.push({ id: "cpu", label: "CPU", value: state.cpu, unit: "%", warn: 85, critical: 95, detail: `${cores} cores` });
  metrics.push({ id: "load", label: "Load", value: round((l1 / cores) * 100), unit: "%", warn: 70, critical: 90, detail: `${l1.toFixed(2)} ${l5.toFixed(2)} ${l15.toFixed(2)}` });

  const mem = meminfo();
  const total = mem?.total ?? totalmem();
  const available = mem?.available ?? freemem();
  metrics.push({ id: "memory", label: "RAM", value: round(((total - available) / total) * 100), unit: "%", warn: 85, critical: 95, detail: amount(total - available, total) });
  metrics.push({ id: "freemem", label: "Free", value: round(gb(available)), unit: "GB", warn: 2, critical: 0.5, lowerIsWorse: true });
  if (mem?.swapTotal) {
    const used = mem.swapTotal - (mem.swapFree ?? 0);
    metrics.push({ id: "swap", label: "Swap", value: round((used / mem.swapTotal) * 100), unit: "%", warn: 80, critical: 95, detail: amount(used, mem.swapTotal) });
  }

  for (const disk of state.disks ?? []) {
    metrics.push({ id: "disk:" + disk.mount, label: disk.mount, value: disk.percent, unit: "%", warn: 90, critical: 95, detail: amount(disk.used, disk.total) });
  }

  if (state.temp) metrics.push({ id: "temp", label: "Temp", value: state.temp.value, unit: "°C", warn: 80, critical: 90, ...(state.temp.source ? { detail: state.temp.source } : {}) });
  if (state.tempNvme !== null) metrics.push({ id: "temp_nvme", label: "NVMe", value: state.tempNvme, unit: "°C", warn: 70, critical: 80 });

  const gpu = state.gpu;
  if (gpu) {
    if (gpu.util !== null) metrics.push({ id: "gpu", label: "GPU", value: gpu.util, unit: "%", warn: 95, detail: gpu.name });
    if (gpu.memUsed !== null && gpu.memTotal) {
      metrics.push({ id: "gpu_mem", label: "VRAM", value: round((gpu.memUsed / gpu.memTotal) * 100), unit: "%", warn: 90, critical: 98, detail: amount(gpu.memUsed * 1048576, gpu.memTotal * 1048576) });
    }
    if (gpu.temp !== null) metrics.push({ id: "gpu_temp", label: "GPU Temp", value: gpu.temp, unit: "°C", warn: 83, critical: 90 });
    if (gpu.power !== null) metrics.push({ id: "gpu_power", label: "GPU Power", value: round(gpu.power), unit: "W" });
  }

  if (state.net) {
    metrics.push({ id: "net_rx", label: "RX", value: state.net.rx, unit: "Mbit/s" });
    metrics.push({ id: "net_tx", label: "TX", value: state.net.tx, unit: "Mbit/s" });
  }

  if (state.docker) {
    const { running, total: all, unhealthy } = state.docker;
    metrics.push({
      id: "docker", label: "Docker", value: running, unit: "",
      ...(unhealthy.length > 0 ? { state: "warn", detail: "unhealthy: " + names(unhealthy) } : { detail: `${running}/${all} running` }),
    });
  }

  if (state.failed) {
    metrics.push({ id: "failed", label: "Failed units", value: state.failed.length, unit: "", warn: 1, ...(state.failed.length > 0 ? { detail: names(state.failed.map(unitName)) } : {}) });
  }
  for (const service of state.services ?? []) {
    const status = service.active === "active" ? "ok" : service.active === "activating" || service.active === "reloading" ? "warn" : "critical";
    metrics.push({ id: "svc:" + service.name, label: service.name, state: status, detail: service.active });
  }

  if (state.tailscale) {
    metrics.push({
      id: "tailscale", label: "Tailscale", state: state.tailscale.online ? "ok" : "critical",
      detail: state.tailscale.online ? `${state.tailscale.peersOnline}/${state.tailscale.peers} peers online` : state.tailscale.backend,
    });
  }

  metrics.push({ id: "uptime", label: "Up", value: Math.round(uptime() / 3600), unit: "h" });

  return { name: NAME, timestamp: Date.now(), metrics };
}

const CORS = {
  // Status Glass runs in a WebView; allow it to read this.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const server = createServer((request, response) => {
  // The browser's preflight never carries the Authorization header, so it is
  // answered before the token check. Checking it first answered 401 without
  // CORS headers, and the WebView then refused every request — a TOKEN made
  // the server unusable from Status Glass.
  if (request.method === "OPTIONS") {
    response.writeHead(204, CORS);
    response.end();
    return;
  }

  if (!request.url?.startsWith("/status")) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found\n");
    return;
  }

  // Never log the token.
  if ((TOKEN || TAILSCALE_USERS.length > 0) && tailscaleUser(request) === "") {
    const header = request.headers["authorization"] ?? "";
    if (!TOKEN || header !== "Bearer " + TOKEN) {
      response.writeHead(401, { ...CORS, "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
  }

  let body;
  try {
    body = JSON.stringify(collect());
  } catch {
    // A sensor that misbehaves must not take the endpoint down.
    body = JSON.stringify({ name: NAME, timestamp: Date.now(), metrics: [{ id: "uptime", label: "Up", value: Math.round(uptime() / 3600), unit: "h" }] });
  }
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...CORS,
  });
  response.end(body);
});

sampleFast();
void sampleSlow();
setInterval(sampleFast, FAST_MS).unref();
setInterval(() => { void sampleSlow(); }, SLOW_MS).unref();
// The first CPU and network rate need two readings; take the second one soon.
setTimeout(sampleFast, 1000).unref();

server.listen(PORT, HOST, () => {
  console.log("Status Glass reference server on http://" + HOST + ":" + PORT + "/status");
  if (!TOKEN && TAILSCALE_USERS.length === 0) console.log("No TOKEN set: this endpoint is unauthenticated.");
  if (HOST === "0.0.0.0") console.log("Bound to all interfaces. Set a TOKEN and prefer TLS.");
});
