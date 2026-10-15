/**
 * Heimnetz-Wächter (home network watch) for the Status Glass reference server.
 *
 * Off unless STATUS_NETWATCH=1. Passive by default: it only reads the
 * neighbour table this machine already keeps (`ip neigh`, or /proc/net/arp)
 * and never sends a packet of its own. An optional ping refresh of this
 * machine's own private /24 needs a second switch (STATUS_NETWATCH_PING=1)
 * and refuses anything outside the RFC 1918 ranges.
 *
 * Devices are keyed by MAC address. The book remembers first and last sight,
 * the last IPv4 address and, where the local resolver knows one, the reverse
 * DNS name. It is kept in a JSON file (mode 600, written atomically). A device
 * is "new" when it was first seen in the last 24 hours and nobody has marked
 * it as known. On the very first run every device already present is taken as
 * the baseline (known), so starting the watch does not raise twenty alerts.
 *
 * Only Node's standard library is used; every function that touches the
 * system can be given a stand-in, so the tests run on fixtures alone.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export const NEW_WINDOW_MS = 24 * 3600 * 1000;
export const MAX_DEVICES = 512;
/** lastSeen alone is written at most this often; anything else at once. */
export const LAZY_SAVE_MS = 10 * 60 * 1000;
const NAME_MAX = 64;

/** Interfaces whose neighbours are not the home network (containers, VPNs, bridges of VMs). */
export const VIRTUAL_IFACE = /^(lo|veth|docker|br-|virbr|cni|flannel|cali|vnet|tap|tun|tailscale|wg|kube|lxc|fwbr|fwpr|fwln|zt)/;

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const PRESENT = new Set(["REACHABLE", "STALE", "DELAY", "PROBE", "PERMANENT", "NOARP"]);

/** "AA-BB-…" or "aa:bb:…" → "aa:bb:…"; null for anything that is not a usable unicast MAC. */
export function normalizeMac(raw) {
  const mac = String(raw ?? "").trim().toLowerCase().replace(/-/g, ":");
  if (!MAC.test(mac)) return null;
  if (mac === "00:00:00:00:00:00" || mac === "ff:ff:ff:ff:ff:ff") return null;
  // Group (multicast) addresses are not devices.
  if (parseInt(mac.slice(0, 2), 16) & 1) return null;
  return mac;
}

export function isIpv4(ip) {
  const parts = String(ip ?? "").split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** RFC 1918: 10/8, 172.16/12 and the third, home-router block (192 + 168). */
export function isPrivate4(ip) {
  if (!isIpv4(ip)) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function ifaceAllowed(dev, ifaces) {
  if (!dev) return true;
  if (ifaces && ifaces.length > 0) return ifaces.includes(dev);
  return !VIRTUAL_IFACE.test(dev);
}

/**
 * Parses `ip neigh show`:
 *   10.0.0.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE
 *   10.0.0.9 dev eth0  FAILED
 * Entries without a link-layer address (FAILED, INCOMPLETE) are left out.
 */
export function parseIpNeigh(text, { ifaces } = {}) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 3) continue;
    const ip = tokens[0];
    const at = (key) => { const i = tokens.indexOf(key); return i >= 0 ? tokens[i + 1] : undefined; };
    const mac = normalizeMac(at("lladdr"));
    const state = tokens[tokens.length - 1].toUpperCase();
    if (!mac || !PRESENT.has(state)) continue;
    const dev = at("dev") ?? "";
    if (!ifaceAllowed(dev, ifaces)) continue;
    out.push({ ip, mac, dev, state });
  }
  return out;
}

/**
 * Parses /proc/net/arp:
 *   IP address  HW type  Flags  HW address         Mask  Device
 *   10.0.0.1    0x1      0x2    aa:bb:cc:dd:ee:ff  *     eth0
 * Flags 0x2 (complete) or 0x4 (permanent) count; 0x0 is an unanswered lookup.
 */
export function parseProcArp(text, { ifaces } = {}) {
  const out = [];
  for (const line of String(text ?? "").split("\n").slice(1)) {
    const [ip, , flags, hw, , dev = ""] = line.trim().split(/\s+/);
    if (!ip || !isIpv4(ip)) continue;
    const mac = normalizeMac(hw);
    if (!mac || (parseInt(flags, 16) & 0x6) === 0) continue;
    if (!ifaceAllowed(dev, ifaces)) continue;
    out.push({ ip, mac, dev, state: (parseInt(flags, 16) & 0x4) ? "PERMANENT" : "REACHABLE" });
  }
  return out;
}

/** Either format; /proc/net/arp starts with its header line. */
export function parseNeighbours(text, options = {}) {
  return /^\s*IP address\s+HW type/i.test(String(text ?? "")) ? parseProcArp(text, options) : parseIpNeigh(text, options);
}

/** One entry per MAC, the IPv4 address preferred over IPv6. */
export function byMac(entries) {
  const map = new Map();
  for (const entry of entries) {
    const before = map.get(entry.mac);
    if (!before || (!isIpv4(before.ip) && isIpv4(entry.ip))) map.set(entry.mac, entry);
  }
  return map;
}

/**
 * Addresses for the optional ping refresh: the /24 around each private IPv4
 * address of this machine's real interfaces, without its own address. Public
 * and virtual networks give nothing; a larger subnet is still cut to its /24.
 */
export function pingTargets(interfaces, { ifaces } = {}) {
  const targets = new Set();
  const own = new Set();
  for (const [name, addresses] of Object.entries(interfaces ?? {})) {
    if (!ifaceAllowed(name, ifaces)) continue;
    for (const address of addresses ?? []) {
      const family = address.family === 4 ? "IPv4" : address.family;
      if (family !== "IPv4" || address.internal || !isPrivate4(address.address)) continue;
      own.add(address.address);
      const prefix = address.address.split(".").slice(0, 3).join(".");
      for (let host = 1; host <= 254; host += 1) targets.add(`${prefix}.${host}`);
    }
  }
  for (const address of own) targets.delete(address);
  return [...targets].filter(isPrivate4);
}

/** Pings each target once (1 s timeout), a few at a time. `run(file, args)` is the server's runner. */
export async function pingSweep(targets, run, concurrency = 16) {
  const queue = targets.filter(isPrivate4);
  const worker = async () => {
    while (queue.length > 0) {
      const ip = queue.shift();
      await run("ping", ["-n", "-q", "-c", "1", "-W", "1", ip], 3000);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

const cut = (value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, NAME_MAX) : undefined);
const time = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

/** Writes JSON so a crash leaves either the old file or the new one, readable only by its owner. */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* nothing left behind */ }
    throw error;
  }
}

/** The devices this machine has seen, and what the user said about them. */
export class DeviceBook {
  constructor({ file = null, newWindowMs = NEW_WINDOW_MS, maxDevices = MAX_DEVICES } = {}) {
    this.file = file;
    this.newWindowMs = newWindowMs;
    this.maxDevices = maxDevices;
    /** mac → { ip, name, firstSeen, lastSeen, known } */
    this.devices = new Map();
    this.online = new Set();
    /** No book yet: the first observation becomes the baseline. */
    this.firstRun = true;
    this.dirty = false;
    this.touched = false;
    this.savedAt = 0;
  }

  /** Reads the file. A missing or unreadable file starts a fresh book (with a baseline). */
  load() {
    if (!this.file) return this;
    let raw;
    try { raw = JSON.parse(readFileSync(this.file, "utf8")); } catch { return this; }
    const devices = raw && typeof raw === "object" && raw.devices && typeof raw.devices === "object" ? raw.devices : null;
    if (!devices) return this;
    for (const [key, entry] of Object.entries(devices)) {
      const mac = normalizeMac(key);
      if (!mac || !entry || typeof entry !== "object") continue;
      const firstSeen = time(entry.firstSeen);
      const lastSeen = time(entry.lastSeen) ?? firstSeen;
      if (!firstSeen) continue;
      this.devices.set(mac, {
        ip: cut(entry.ip),
        name: cut(entry.name),
        firstSeen,
        lastSeen,
        known: entry.known === true,
      });
    }
    this.firstRun = false;
    return this;
  }

  /** Takes one reading of the neighbour table. Returns the MACs seen for the first time. */
  observe(entries, now) {
    const seen = byMac(entries);
    const added = [];
    const baseline = this.firstRun;
    this.firstRun = false;
    this.online = new Set(seen.keys());
    for (const [mac, entry] of seen) {
      const device = this.devices.get(mac);
      if (!device) {
        this.devices.set(mac, { ip: entry.ip, name: undefined, firstSeen: now, lastSeen: now, known: baseline });
        added.push(mac);
        this.dirty = true;
        continue;
      }
      if (entry.ip && entry.ip !== device.ip && (isIpv4(entry.ip) || !isIpv4(device.ip))) {
        device.ip = entry.ip;
        device.name = undefined;
        this.dirty = true;
      }
      device.lastSeen = now;
      this.touched = true;
    }
    this.prune();
    return baseline ? [] : added;
  }

  /** Keeps the book bounded: the unknown devices seen longest ago go first. */
  prune() {
    if (this.devices.size <= this.maxDevices) return;
    const drop = [...this.devices.entries()]
      .filter(([mac]) => !this.online.has(mac))
      .sort(([, a], [, b]) => Number(a.known) - Number(b.known) || a.lastSeen - b.lastSeen)
      .slice(0, this.devices.size - this.maxDevices);
    for (const [mac] of drop) this.devices.delete(mac);
    this.dirty = true;
  }

  /** Marks a device as known (or not). False when the MAC is not in the book. */
  markKnown(rawMac, known = true) {
    const mac = normalizeMac(rawMac);
    const device = mac ? this.devices.get(mac) : undefined;
    if (!device) return false;
    if (device.known !== known) {
      device.known = known;
      this.dirty = true;
    }
    return true;
  }

  setName(mac, name) {
    const device = this.devices.get(mac);
    const value = cut(name);
    if (!device || device.name === value) return;
    device.name = value;
    this.dirty = true;
  }

  isNew(device, now) {
    return !device.known && now - device.firstSeen < this.newWindowMs;
  }

  /** The `network` block of the report. */
  summary(now) {
    const devices = [...this.devices.entries()].map(([mac, d]) => ({
      mac,
      ...(d.ip ? { ip: d.ip } : {}),
      ...(d.name ? { name: d.name } : {}),
      online: this.online.has(mac),
      known: d.known,
      new: this.isNew(d, now),
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
    }));
    // New ones first, then the ones online, then by address.
    devices.sort((a, b) => Number(b.new) - Number(a.new) || Number(b.online) - Number(a.online) || ipOrder(a.ip) - ipOrder(b.ip));
    return {
      total: devices.length,
      online: devices.filter((d) => d.online).length,
      new: devices.filter((d) => d.new).length,
      devices,
    };
  }

  /** Writes the book when something changed; lastSeen alone only every LAZY_SAVE_MS. */
  save(now, { force = false } = {}) {
    if (!this.file) return false;
    if (!force && !this.dirty && !(this.touched && now - this.savedAt >= LAZY_SAVE_MS)) return false;
    const devices = {};
    for (const [mac, d] of this.devices) {
      devices[mac] = { ...(d.ip ? { ip: d.ip } : {}), ...(d.name ? { name: d.name } : {}), firstSeen: d.firstSeen, lastSeen: d.lastSeen, known: d.known };
    }
    writeJsonAtomic(this.file, { version: 1, devices });
    this.dirty = false;
    this.touched = false;
    this.savedAt = now;
    return true;
  }
}

function ipOrder(ip) {
  if (!isIpv4(ip)) return Number.MAX_SAFE_INTEGER;
  return ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

/**
 * Looks up reverse DNS names for devices that have none, at most once an hour
 * per device, each lookup bounded by `timeoutMs`. `reverse(ip)` resolves to a
 * list of names (node:dns/promises reverse in the server, a stand-in in tests).
 */
export async function resolveNames(book, reverse, now, { timeoutMs = 2000, retryMs = 3600 * 1000, tried = new Map() } = {}) {
  for (const [mac, device] of book.devices) {
    if (device.name || !isIpv4(device.ip) || !book.online.has(mac)) continue;
    const key = `${mac}|${device.ip}`;
    if (now - (tried.get(key) ?? 0) < retryMs) continue;
    tried.set(key, now);
    const names = await Promise.race([
      Promise.resolve().then(() => reverse(device.ip)).catch(() => []),
      new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs).unref?.()),
    ]);
    const name = Array.isArray(names) ? names.find((n) => typeof n === "string" && n.trim()) : undefined;
    if (name) book.setName(mac, name.replace(/\.$/, ""));
  }
  return tried;
}
