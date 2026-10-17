import type { Action, NetDevice, NetworkInfo, SourceReport } from "../protocol/schema";

/** Readings of the NAS demo, step 0..11 (oldest first), per scene. */
export function demoNasReport(scene: string | null, step: number): SourceReport {
  const wave = (base: number, amp: number, phase: number): number => Math.round(base + amp * Math.sin(step * 0.7 + phase));
  const critical = scene === "critical";
  const warn = scene === "warn";
  const cpu = critical ? Math.min(99, 70 + step * 3) : warn ? wave(76, 8, 0) : wave(34, 14, 0);
  const gpu = wave(critical ? 70 : 46, 18, 1.3);
  const ram = warn || critical ? Math.min(96, 78 + Math.round(step * 1.2)) : wave(52, 5, 2.2);
  return {
    name: "NAS",
    metrics: [
      { id: "cpu", label: "CPU", value: cpu, unit: "%", warn: 80, critical: 95 },
      { id: "gpu", label: "GPU", value: gpu, unit: "%", warn: 90, critical: 98 },
      { id: "ram", label: "RAM", value: ram, unit: "%", warn: 85, critical: 95 },
      { id: "web", label: "Web", state: "ok" },
    ],
  };
}

export interface DemoMachine {
  readonly id: string;
  readonly name: string;
  /** Base CPU load and RAM use of the demo machine. */
  readonly cpu: number;
  readonly ram: number;
  /** More than 0: the machine has been unreachable for this many minutes. */
  readonly offlineMinutes: number;
  /** Fullest disk in percent; the machine's default when omitted. */
  readonly disk?: number;
  /** What the machine offers to run. */
  readonly actions?: readonly Action[];
}

/** Four machines for `?demo=1&scene=fleet`: fine, warning, critical, offline. */
export const DEMO_FLEET: readonly DemoMachine[] = [
  { id: "spark", name: "Spark", cpu: 22, ram: 48, offlineMinutes: 0 },
  { id: "pi5", name: "Pi5", cpu: 55, ram: 88, offlineMinutes: 0 },
  { id: "ns1", name: "ns1", cpu: 90, ram: 70, offlineMinutes: 0 },
  { id: "samuel", name: "samuel", cpu: 35, ram: 40, offlineMinutes: 12 },
];

/** What the reference server reports for each demo machine, beyond CPU and RAM. */
const DEMO_EXTRAS: Readonly<Record<string, { disk: number; temp: number; gpu?: boolean; docker?: number; failed?: string[] }>> = {
  spark: { disk: 58, temp: 61, gpu: true, docker: 9 },
  pi5: { disk: 34, temp: 48, failed: ["systemd-networkd-wait-online"] },
  ns1: { disk: 93, temp: 46, docker: 31 },
  samuel: { disk: 33, temp: 53 },
  pi: { disk: 34, temp: 48 },
  nas: { disk: 52, temp: 44 },
};

/** The ns1 disk of the first-start demo: full enough for exactly one problem, or fine. */
export const DEMO_DISK_PROBLEM = 93;
export const DEMO_DISK_FINE = 61;

/**
 * The first-start demo (QUS v1): four servers, calm, and - with `problem` - one
 * nearly full disk on ns1 to show what a problem looks like. One machine offers an action.
 */
export function demoStartFleet(problem = true): DemoMachine[] {
  return [
    { id: "spark", name: "Spark", cpu: 22, ram: 48, offlineMinutes: 0, actions: [{ id: "docker-cleanup", label: "Docker cleanup", confirm: true }] },
    { id: "pi", name: "Pi5", cpu: 18, ram: 41, offlineMinutes: 0 },
    { id: "ns1", name: "ns1", cpu: 31, ram: 55, offlineMinutes: 0, disk: problem ? DEMO_DISK_PROBLEM : DEMO_DISK_FINE },
    { id: "nas", name: "NAS", cpu: 12, ram: 36, offlineMinutes: 0 },
  ];
}

export function demoFleetReport(machine: DemoMachine, step: number): SourceReport {
  const wave = (base: number, amp: number, phase: number): number => Math.min(99, Math.max(1, Math.round(base + amp * Math.sin(step * 0.8 + phase))));
  const extra = DEMO_EXTRAS[machine.id] ?? { disk: 40, temp: 50 };
  const failed = extra.failed ?? [];
  return {
    name: machine.name,
    metrics: [
      { id: "cpu", label: "CPU", value: wave(machine.cpu, 8, 0), unit: "%", warn: 85, critical: 95, detail: "8 cores" },
      { id: "load", label: "Load", value: wave(machine.cpu - 5, 6, 0.4), unit: "%", warn: 70, critical: 90, detail: "1.20 0.98 0.85" },
      { id: "memory", label: "RAM", value: wave(machine.ram, 3, 1), unit: "%", warn: 85, critical: 95, detail: "54/119 GB" },
      { id: "swap", label: "Swap", value: 4, unit: "%", warn: 80, critical: 95, detail: "0.3/8.0 GB" },
      { id: "disk:/", label: "/", value: machine.disk ?? extra.disk, unit: "%", warn: 90, critical: 95, detail: "539/916 GB" },
      ...(machine.id === "spark" ? [{ id: "disk:/data", label: "/data", value: 71, unit: "%", warn: 90, critical: 95, detail: "2.8/4.0 TB" }] : []),
      { id: "temp", label: "Temp", value: wave(extra.temp, 3, 2), unit: "°C", warn: 80, critical: 90 },
      ...(extra.gpu ? [
        { id: "gpu", label: "GPU", value: wave(40, 25, 0.7), unit: "%", warn: 95, detail: "NVIDIA GB10" },
        { id: "gpu_temp", label: "GPU Temp", value: wave(55, 4, 1), unit: "°C", warn: 83, critical: 90 },
        { id: "gpu_power", label: "GPU Power", value: 38, unit: "W" },
      ] : []),
      { id: "net_rx", label: "RX", value: 2.4, unit: "Mbit/s" },
      { id: "net_tx", label: "TX", value: 0.8, unit: "Mbit/s" },
      ...(extra.docker !== undefined ? [{ id: "docker", label: "Docker", value: extra.docker, unit: "", detail: `${extra.docker}/${extra.docker + 3} running` }] : []),
      { id: "failed", label: "Failed units", value: failed.length, unit: "", warn: 1, ...(failed.length > 0 ? { detail: failed.join(", ") } : {}) },
      { id: "tailscale", label: "Tailscale", state: "ok", detail: "13/18 peers online" },
      { id: "uptime", label: "Up", value: 345, unit: "h" },
    ],
    ...(machine.actions ? { actions: machine.actions } : {}),
  };
}

/** A home network of 23 devices, one of them new, for the fleet demo (made-up 10.x addresses). */
export function demoNetwork(now: number): NetworkInfo {
  const names = ["router", "nas", "drucker", "tv-wohnzimmer", "pixel-7", "ipad", "pi5", "spark", "sonos-kueche", "hue-bridge"];
  const devices: NetDevice[] = Array.from({ length: 22 }, (_, i) => ({
    mac: "aa:bb:cc:00:00:" + (i + 1).toString(16).padStart(2, "0"),
    ip: `10.0.0.${i + 1}`,
    ...(names[i] ? { name: names[i]! } : {}),
    online: i < 19,
    known: true,
    new: false,
    firstSeen: now - 40 * 86_400_000,
    lastSeen: i < 19 ? now : now - 3 * 3_600_000,
  }));
  devices.unshift({ mac: "de:ad:be:ef:00:42", ip: "10.0.0.142", name: "android-5f3c", online: true, known: false, new: true, firstSeen: now - 25 * 60_000, lastSeen: now });
  return { total: devices.length, online: devices.filter((d) => d.online).length, new: 1, devices };
}
