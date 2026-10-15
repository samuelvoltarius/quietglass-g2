import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeviceBook, LAZY_SAVE_MS, NEW_WINDOW_MS, byMac, isPrivate4, normalizeMac, parseIpNeigh, parseNeighbours,
  parseProcArp, pingSweep, pingTargets, resolveNames, writeJsonAtomic,
} from "../examples/netwatch.mjs";

// Fixtures only: nothing here reads this machine's tables or touches a network.
const IP_NEIGH = [
  "10.0.0.1 dev eth0 lladdr AA:BB:CC:00:00:01 REACHABLE",
  "10.0.0.7 dev eth0 lladdr aa:bb:cc:00:00:07 STALE",
  "10.0.0.9 dev eth0  FAILED",
  "10.0.0.10 dev eth0  INCOMPLETE",
  "10.0.0.12 dev eth0 lladdr aa:bb:cc:00:00:0c router DELAY",
  "10.0.0.13 dev eth0 lladdr aa:bb:cc:00:00:0d PROBE",
  "172.17.0.2 dev docker0 lladdr 02:42:ac:11:00:02 REACHABLE",
  "10.0.0.20 dev wlan0 lladdr aa:bb:cc:00:00:14 PERMANENT",
  "10.0.0.30 dev eth0 lladdr 01:00:5e:00:00:fb REACHABLE",
  "fe80::1 dev eth0 lladdr aa:bb:cc:00:00:01 router STALE",
  "fd00::7 dev eth0 lladdr aa:bb:cc:00:00:07 REACHABLE",
  "",
].join("\n");

const PROC_ARP = [
  "IP address       HW type     Flags       HW address            Mask     Device",
  "10.1.2.1         0x1         0x2         aa:bb:cc:00:01:01     *        eth0",
  "10.1.2.5         0x1         0x0         00:00:00:00:00:00     *        eth0",
  "10.1.2.6         0x1         0x6         aa:bb:cc:00:01:06     *        eth0",
  "10.1.2.7         0x1         0x2         aa:bb:cc:00:01:07     *        veth12ab",
  "",
].join("\n");

const T0 = 1_800_000_000_000;
const H = 3600 * 1000;

describe("reading the neighbour table", () => {
  it("parses ip neigh: complete entries only, no containers, no multicast", () => {
    const entries = parseIpNeigh(IP_NEIGH);
    expect(entries.map((e) => [e.ip, e.mac, e.state])).toEqual([
      ["10.0.0.1", "aa:bb:cc:00:00:01", "REACHABLE"],
      ["10.0.0.7", "aa:bb:cc:00:00:07", "STALE"],
      ["10.0.0.12", "aa:bb:cc:00:00:0c", "DELAY"],
      ["10.0.0.13", "aa:bb:cc:00:00:0d", "PROBE"],
      ["10.0.0.20", "aa:bb:cc:00:00:14", "PERMANENT"],
      ["fe80::1", "aa:bb:cc:00:00:01", "STALE"],
      ["fd00::7", "aa:bb:cc:00:00:07", "REACHABLE"],
    ]);
  });

  it("parses /proc/net/arp: complete and permanent flags, header skipped", () => {
    expect(parseProcArp(PROC_ARP).map((e) => [e.ip, e.mac, e.dev])).toEqual([
      ["10.1.2.1", "aa:bb:cc:00:01:01", "eth0"],
      ["10.1.2.6", "aa:bb:cc:00:01:06", "eth0"],
    ]);
  });

  it("tells the two formats apart and honours an interface list", () => {
    expect(parseNeighbours(PROC_ARP)).toHaveLength(2);
    expect(parseNeighbours(IP_NEIGH)).toHaveLength(7);
    expect(parseNeighbours(IP_NEIGH, { ifaces: ["wlan0"] }).map((e) => e.ip)).toEqual(["10.0.0.20"]);
    expect(parseNeighbours(PROC_ARP, { ifaces: ["veth12ab"] }).map((e) => e.ip)).toEqual(["10.1.2.7"]);
    expect(parseNeighbours("")).toEqual([]);
    expect(parseNeighbours("garbage\nmore garbage here please")).toEqual([]);
  });

  it("merges one MAC into one device and prefers its IPv4 address", () => {
    const merged = byMac(parseIpNeigh(IP_NEIGH));
    expect(merged.size).toBe(5);
    expect(merged.get("aa:bb:cc:00:00:01").ip).toBe("10.0.0.1");
    expect(merged.get("aa:bb:cc:00:00:07").ip).toBe("10.0.0.7");
  });

  it("normalises MACs and refuses broadcast, zero and multicast", () => {
    expect(normalizeMac("AA-BB-CC-00-00-01")).toBe("aa:bb:cc:00:00:01");
    expect(normalizeMac("ff:ff:ff:ff:ff:ff")).toBeNull();
    expect(normalizeMac("00:00:00:00:00:00")).toBeNull();
    expect(normalizeMac("33:33:00:00:00:01")).toBeNull();
    expect(normalizeMac("aa:bb:cc")).toBeNull();
    expect(normalizeMac(undefined)).toBeNull();
  });
});

describe("the optional ping refresh", () => {
  it("only covers the own private /24 of real interfaces, never public ranges", () => {
    const targets = pingTargets({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      eth0: [{ address: "10.4.5.6", family: "IPv4", internal: false }, { address: "fe80::2", family: "IPv6", internal: false }],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
      wan0: [{ address: "8.8.4.4", family: "IPv4", internal: false }],
      tailscale0: [{ address: "10.99.0.1", family: "IPv4", internal: false }],
    });
    expect(targets).toHaveLength(253);
    expect(targets).toContain("10.4.5.1");
    expect(targets).toContain("10.4.5.254");
    expect(targets).not.toContain("10.4.5.6");
    expect(targets.every((ip) => ip.startsWith("10.4.5."))).toBe(true);
    expect(pingTargets({ wan0: [{ address: "8.8.4.4", family: 4, internal: false }] })).toEqual([]);
  });

  it("knows the RFC 1918 ranges", () => {
    expect(isPrivate4("10.0.0.1")).toBe(true);
    expect(isPrivate4("172.16.0.1")).toBe(true);
    expect(isPrivate4("172.31.255.1")).toBe(true);
    expect(isPrivate4("172.32.0.1")).toBe(false);
    expect(isPrivate4("11.0.0.1")).toBe(false);
    expect(isPrivate4("172.15.0.1")).toBe(false);
    expect(isPrivate4("8.8.8.8")).toBe(false);
    expect(isPrivate4("10.0.0")).toBe(false);
  });

  it("sends one ping per private target through the given runner and drops anything public", async () => {
    const calls = [];
    await pingSweep(["10.4.5.1", "10.4.5.2", "8.8.8.8"], async (file, args) => { calls.push([file, args.at(-1)]); return { ok: true, stdout: "" }; }, 2);
    expect(calls.map((c) => c[1]).sort()).toEqual(["10.4.5.1", "10.4.5.2"]);
    expect(calls.every((c) => c[0] === "ping")).toBe(true);
  });
});

describe("the device book", () => {
  const dirs = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const tempFile = () => { const dir = mkdtempSync(join(tmpdir(), "netwatch-")); dirs.push(dir); return join(dir, "state", "netwatch.json"); };

  it("takes the first reading as the baseline, then flags newcomers for 24 hours", () => {
    const book = new DeviceBook();
    expect(book.observe(parseIpNeigh(IP_NEIGH), T0)).toEqual([]);
    let summary = book.summary(T0);
    expect(summary).toMatchObject({ total: 5, online: 5, new: 0 });
    expect(summary.devices.every((d) => d.known)).toBe(true);

    const later = [...parseIpNeigh(IP_NEIGH), { ip: "10.0.0.50", mac: "aa:bb:cc:00:00:32", dev: "eth0", state: "REACHABLE" }];
    expect(book.observe(later, T0 + H)).toEqual(["aa:bb:cc:00:00:32"]);
    summary = book.summary(T0 + H);
    expect(summary).toMatchObject({ total: 6, online: 6, new: 1 });
    expect(summary.devices[0]).toMatchObject({ mac: "aa:bb:cc:00:00:32", ip: "10.0.0.50", new: true, known: false, online: true });

    // A day later it is no longer new, but still not known.
    const dayLater = book.summary(T0 + H + NEW_WINDOW_MS);
    expect(dayLater.new).toBe(0);
    expect(dayLater.devices.find((d) => d.mac === "aa:bb:cc:00:00:32").known).toBe(false);
  });

  it("counts a device that left the table as offline, and keeps it", () => {
    const book = new DeviceBook();
    book.observe(parseIpNeigh(IP_NEIGH), T0);
    book.observe(parseIpNeigh(IP_NEIGH).filter((e) => e.ip !== "10.0.0.13"), T0 + 60_000);
    const summary = book.summary(T0 + 60_000);
    expect(summary).toMatchObject({ total: 5, online: 4 });
    const gone = summary.devices.find((d) => d.ip === "10.0.0.13");
    expect(gone).toMatchObject({ online: false, lastSeen: T0 });
  });

  it("marks a device as known, and refuses one it never saw", () => {
    const book = new DeviceBook();
    book.observe([], T0);
    book.observe([{ ip: "10.0.0.50", mac: "aa:bb:cc:00:00:32", dev: "eth0", state: "REACHABLE" }], T0 + 1);
    expect(book.summary(T0 + 2).new).toBe(1);
    expect(book.markKnown("AA:BB:CC:00:00:32")).toBe(true);
    expect(book.summary(T0 + 2).new).toBe(0);
    expect(book.markKnown("aa:bb:cc:00:00:99")).toBe(false);
    expect(book.markKnown("not a mac")).toBe(false);
  });

  it("persists the book atomically with mode 600 and reads it back", () => {
    const file = tempFile();
    const book = new DeviceBook({ file }).load();
    expect(book.firstRun).toBe(true);
    book.observe(parseIpNeigh(IP_NEIGH), T0);
    book.observe([{ ip: "10.0.0.50", mac: "aa:bb:cc:00:00:32", dev: "eth0", state: "REACHABLE" }], T0 + 1000);
    book.setName("aa:bb:cc:00:00:32", "printer.lan.");
    expect(book.save(T0 + 1000)).toBe(true);
    expect(readdirSync(join(file, "..")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.devices["aa:bb:cc:00:00:32"]).toMatchObject({ ip: "10.0.0.50", known: false, firstSeen: T0 + 1000 });

    const again = new DeviceBook({ file }).load();
    expect(again.firstRun).toBe(false);
    expect(again.devices.size).toBe(6);
    // Nothing is online until the next reading; the newcomer is still new and not re-baselined.
    expect(again.summary(T0 + 2000)).toMatchObject({ total: 6, online: 0, new: 1 });
    expect(again.observe([{ ip: "10.0.0.51", mac: "aa:bb:cc:00:00:33", dev: "eth0", state: "REACHABLE" }], T0 + 3000)).toEqual(["aa:bb:cc:00:00:33"]);
  });

  it("writes lastSeen alone only now and then, anything else at once", () => {
    const file = tempFile();
    const book = new DeviceBook({ file }).load();
    book.observe(parseIpNeigh(IP_NEIGH), T0);
    expect(book.save(T0)).toBe(true);
    book.observe(parseIpNeigh(IP_NEIGH), T0 + 60_000);
    expect(book.save(T0 + 60_000)).toBe(false);
    expect(book.save(T0 + LAZY_SAVE_MS + 1)).toBe(true);
    book.markKnown("aa:bb:cc:00:00:01", false);
    expect(book.save(T0 + LAZY_SAVE_MS + 2)).toBe(true);
  });

  it("survives a broken or foreign file and drops entries that make no sense", () => {
    const file = tempFile();
    writeJsonAtomic(file, { devices: { "zz:zz": { firstSeen: 1 }, "aa:bb:cc:00:00:01": { firstSeen: "x" }, "aa:bb:cc:00:00:02": { firstSeen: T0, ip: "10.0.0.2", known: true } } });
    const book = new DeviceBook({ file }).load();
    expect([...book.devices.keys()]).toEqual(["aa:bb:cc:00:00:02"]);
    writeFileSync(file, "{ not json");
    expect(new DeviceBook({ file }).load().firstRun).toBe(true);
  });

  it("stays bounded, dropping the unknown devices seen longest ago", () => {
    const book = new DeviceBook({ maxDevices: 3 });
    book.observe([], T0);
    const mac = (n) => `aa:bb:cc:00:10:${n.toString(16).padStart(2, "0")}`;
    for (let n = 1; n <= 5; n += 1) book.observe([{ ip: `10.0.1.${n}`, mac: mac(n), dev: "eth0", state: "REACHABLE" }], T0 + n);
    expect(book.devices.size).toBe(3);
    expect(book.devices.has(mac(5))).toBe(true);
    expect(book.devices.has(mac(1))).toBe(false);
  });

  it("looks up reverse DNS names once, with a time limit, for devices online", async () => {
    const book = new DeviceBook();
    book.observe([{ ip: "10.0.0.1", mac: "aa:bb:cc:00:00:01", dev: "eth0", state: "REACHABLE" }, { ip: "10.0.0.2", mac: "aa:bb:cc:00:00:02", dev: "eth0", state: "REACHABLE" }], T0);
    const asked = [];
    const reverse = async (ip) => { asked.push(ip); if (ip === "10.0.0.2") return new Promise(() => {}); return ["router.home.arpa."]; };
    const tried = await resolveNames(book, reverse, T0, { timeoutMs: 50 });
    expect(book.devices.get("aa:bb:cc:00:00:01").name).toBe("router.home.arpa");
    expect(book.devices.get("aa:bb:cc:00:00:02").name).toBeUndefined();
    await resolveNames(book, reverse, T0 + 1000, { timeoutMs: 50, tried });
    expect(asked).toEqual(["10.0.0.1", "10.0.0.2"]);
  });
});

// ---- the reference server with the watch switched on, fed from a fixture file ----

const example = fileURLToPath(new URL("../examples/reference-server.mjs", import.meta.url));

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe("reference server with STATUS_NETWATCH=1", () => {
  const cleanup = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  async function start(env) {
    const dir = mkdtempSync(join(tmpdir(), "netwatch-srv-"));
    const table = join(dir, "neigh.txt");
    writeFileSync(table, IP_NEIGH);
    const file = join(dir, "book", "netwatch.json");
    const port = await freePort();
    const child = spawn(process.execPath, [example], {
      env: {
        ...process.env, PORT: String(port), HOST: "127.0.0.1", STATUS_NETWATCH: "1", STATUS_NETWATCH_DNS: "0",
        STATUS_NETWATCH_PING: "", STATUS_NETWATCH_SOURCE: table, STATUS_NETWATCH_FILE: file, ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    cleanup.push(() => { child.kill(); setTimeout(() => rmSync(dir, { recursive: true, force: true }), 200); });
    await new Promise((resolve) => child.stdout.on("data", () => { if (out.includes("http://")) resolve(); }));
    return { base: `http://127.0.0.1:${port}`, table, file };
  }

  const auth = { Authorization: "Bearer s3cret", "Content-Type": "application/json" };

  it("reports the network block and lets an authenticated POST mark a device as known", async () => {
    const { base, table, file } = await start({ TOKEN: "s3cret", STATUS_NETWATCH_MS: "10000" });
    const first = await (await fetch(base + "/status", { headers: auth })).json();
    expect(first.network).toMatchObject({ total: 5, online: 5, new: 0 });
    expect(existsSync(file)).toBe(true);

    const preflight = await fetch(base + "/devices", { method: "OPTIONS", headers: { Origin: "https://phone.example", "Access-Control-Request-Method": "POST" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");

    const body = JSON.stringify({ mac: "aa:bb:cc:00:00:01", known: false });
    expect((await fetch(base + "/devices", { method: "POST", body })).status).toBe(401);
    expect((await fetch(base + "/devices", { method: "POST", headers: { ...auth, Authorization: "Bearer wrong" }, body })).status).toBe(401);
    expect((await fetch(base + "/devices", { method: "POST", headers: auth, body: JSON.stringify({ mac: "aa:bb:cc:00:00:99" }) })).status).toBe(404);
    expect((await fetch(base + "/devices", { method: "POST", headers: auth, body: "{nope" })).status).toBe(400);
    expect((await fetch(base + "/devices", { method: "POST", headers: auth, body: JSON.stringify({ mac: "x".repeat(9000) }) })).status).toBe(413);
    expect((await fetch(base + "/devices", { method: "POST", headers: auth, body })).status).toBe(200);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored.devices["aa:bb:cc:00:00:01"].known).toBe(false);

    const again = await (await fetch(base + "/devices", { method: "POST", headers: auth, body: JSON.stringify({ mac: "aa:bb:cc:00:00:01" }) })).json();
    expect(again).toEqual({ ok: true, known: true });
    void table;
  }, 15000);

  it("refuses to change the book on a server without any login", async () => {
    const { base } = await start({ TOKEN: "", STATUS_TAILSCALE_USERS: "" });
    const status = await (await fetch(base + "/status")).json();
    expect(status.network.total).toBe(5);
    const response = await fetch(base + "/devices", { method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify({ mac: "aa:bb:cc:00:00:01" }) });
    expect(response.status).toBe(403);
  }, 15000);

  it("an allowed Tailscale login may mark devices without a token", async () => {
    const { base } = await start({ TOKEN: "", STATUS_TAILSCALE_USERS: "me@example.com" });
    const headers = { "Tailscale-User-Login": "me@example.com" };
    expect((await fetch(base + "/devices", { method: "POST", headers, body: JSON.stringify({ mac: "aa:bb:cc:00:00:07" }) })).status).toBe(200);
    expect((await fetch(base + "/devices", { method: "POST", headers: { "Tailscale-User-Login": "x@example.com" }, body: "{}" })).status).toBe(401);
  }, 15000);

  it("without the switch there is no network block and no /devices", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [example], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TOKEN: "s3cret", STATUS_NETWATCH: "" }, stdio: ["ignore", "pipe", "pipe"] });
    cleanup.push(() => child.kill());
    let out = "";
    await new Promise((resolve) => child.stdout.on("data", (c) => { out += c; if (out.includes("http://")) resolve(); }));
    const status = await (await fetch(`http://127.0.0.1:${port}/status`, { headers: auth })).json();
    expect(status.network).toBeUndefined();
    expect((await fetch(`http://127.0.0.1:${port}/devices`, { method: "POST", headers: auth, body: "{}" })).status).toBe(404);
  }, 15000);
});
