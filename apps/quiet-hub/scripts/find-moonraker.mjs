#!/usr/bin/env node
/**
 * Finds Moonraker (Klipper) printers on a LAN. READ-ONLY: it only sends
 * GET /printer/info to port 7125 and prints candidates.
 *
 *   node scripts/find-moonraker.mjs                # scans 192.168.0.0/24
 *   node scripts/find-moonraker.mjs 192.168.1      # scans 192.168.1.0/24
 *
 * Then set MOONRAKER_URL=http://<ip>:7125 in .env-hub.
 */
const net = (process.argv[2] ?? "192.168.0").replace(/\.$/, "");
if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(net)) {
  console.error("usage: node find-moonraker.mjs [a.b.c]   (a /24 prefix such as 192.168.0)");
  process.exit(2);
}
const port = Number(process.env.MOONRAKER_PORT ?? 7125);

async function probe(ip) {
  try {
    const res = await fetch(`http://${ip}:${port}/printer/info`, { signal: AbortSignal.timeout(900) });
    if (!res.ok) return null;
    const info = (await res.json())?.result ?? {};
    return { ip, state: info.state ?? "?", hostname: info.hostname ?? "", software: info.software_version ?? "" };
  } catch {
    return null;
  }
}

const found = [];
const ips = Array.from({ length: 254 }, (_, i) => `${net}.${i + 1}`);
for (let i = 0; i < ips.length; i += 32) {
  const hits = await Promise.all(ips.slice(i, i + 32).map(probe));
  for (const hit of hits) if (hit) found.push(hit);
}
if (found.length === 0) {
  console.log(`No Moonraker found on ${net}.0/24 (port ${port}).`);
} else {
  console.log(`Moonraker candidates on ${net}.0/24:`);
  for (const f of found) console.log(`  MOONRAKER_URL=http://${f.ip}:${port}   (${f.hostname || "?"}, state: ${f.state})`);
}
